/**
 * Pong server with:
 * - WebSocket subprotocol "pong-proto.v1" (text + binary)
 * - JWT authentication (token provided as second subprotocol)
 * - Redis-backed rate limiting (rate-limiter-flexible + ioredis)
 * - OpenAI streaming commentary using openai@4.6.0 (stream via async iteration)
 * - Simulated commentary fallback if OPENAI_API_KEY missing or SIMULATED_MODE=true
 *
 * Notes:
 * - Clients connect with subprotocols ['pong-proto.v1', <JWT>]
 * - Clients send state as MessagePack binary: ["state", {...}] (preferred)
 *   or as JSON text: { type: "state", state: {...} }
 *
 * Environment (.env):
 * - OPENAI_API_KEY (optional if SIMULATED_MODE=true)
 * - SIMULATED_MODE=true|false
 * - ADMIN_KEY (for dev token minting)
 * - JWT_SECRET, JWT_EXP
 * - REDIS_URL (e.g. redis://localhost:6379)
 * - MODEL_NAME (e.g. gpt-4o-mini)
 * - COMMENTARY_INTERVAL_MS, COACH_INTERVAL_MS
 * - STATE_SEND_LIMIT_PER_SECOND, COMMENTARY_LIMIT_PER_MINUTE
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const msgpack = require('msgpack-lite');
const OpenAI = require('openai');
const IORedis = require('ioredis');
const { RateLimiterRedis } = require('rate-limiter-flexible');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-very-secret';
const JWT_EXP = process.env.JWT_EXP || '1h';
const PORT = Number(process.env.PORT || 3000);

const MODEL_NAME = process.env.MODEL_NAME || 'gpt-4o-mini';
const COMMENTARY_INTERVAL_MS = Number(process.env.COMMENTARY_INTERVAL_MS || 1200);
const COACH_INTERVAL_MS = Number(process.env.COACH_INTERVAL_MS || 10000);
const STATE_SEND_LIMIT_PER_SECOND = Number(process.env.STATE_SEND_LIMIT_PER_SECOND || 5);
const COMMENTARY_LIMIT_PER_MINUTE = Number(process.env.COMMENTARY_LIMIT_PER_MINUTE || 40);

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const SIMULATED_MODE = (process.env.SIMULATED_MODE === 'true') || !OPENAI_KEY;

// Initialize OpenAI client (v4.6.0 style)
let openaiClient = null;
if (!SIMULATED_MODE) {
  try {
    openaiClient = new OpenAI({ apiKey: OPENAI_KEY });
    console.log('OpenAI initialized, model:', MODEL_NAME);
  } catch (e) {
    console.warn('OpenAI init failed, falling back to simulated mode:', e?.message);
  }
} else {
  console.log('SIMULATED_MODE enabled (no OpenAI calls).');
}

// Redis connection (for rate limiting)
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redisClient = new IORedis(REDIS_URL);

// Rate limiter: state messages (per-second)
const stateLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'rl_state',
  points: STATE_SEND_LIMIT_PER_SECOND, // allowed points
  duration: 1, // per second
  inmemoryBlockOnConsumed: STATE_SEND_LIMIT_PER_SECOND + 1,
});

// Rate limiter: commentary calls (per-minute)
const commentaryLimiter = new RateLimiterRedis({
  storeClient: redisClient,
  keyPrefix: 'rl_commentary',
  points: COMMENTARY_LIMIT_PER_MINUTE,
  duration: 60,
  inmemoryBlockOnConsumed: COMMENTARY_LIMIT_PER_MINUTE + 1,
});

// JWT dev token minting endpoint (for dev)
app.post('/auth/token', (req, res) => {
  const { adminKey } = req.body || {};
  if (!adminKey || adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'invalid adminKey' });
  const payload = { sub: 'dev-user', role: 'tester' };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXP });
  res.json({ token });
});

app.get('/health', (req, res) => res.json({ ok: true, simulated: SIMULATED_MODE }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Helper: parse sec-websocket-protocol header
function parseProtocols(req) {
  const header = req.headers['sec-websocket-protocol'] || '';
  return header.split(',').map(s => s.trim()).filter(Boolean);
}

server.on('upgrade', (req, socket, head) => {
  const protocols = parseProtocols(req);
  if (!protocols.length || protocols[0] !== 'pong-proto.v1') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Expect JWT as second protocol, otherwise query param token
  let token = protocols[1] || null;
  if (!token) {
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      token = u.searchParams.get('token');
    } catch (e) { token = null; }
  }

  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    // Accept upgrade
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit('connection', ws, req);
    });
  } catch (e) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
});

// Per-connection metadata (in-memory small state)
const metaByWs = new Map();

wss.on('connection', (ws) => {
  console.log('WS connection:', ws.user?.sub || 'unknown');
  metaByWs.set(ws, {
    lastCommentAt: 0,
    lastCoachAt: 0,
    coachEnabled: false,
    lastState: null
  });

  ws.send(JSON.stringify({ type: 'welcome', user: ws.user }));

  ws.on('message', async (msg, isBinary) => {
    // Accept binary MessagePack or JSON
    let data;
    try {
      if (isBinary) {
        data = msgpack.decode(msg);
      } else {
        data = JSON.parse(msg.toString());
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid message' }));
      return;
    }

    const userKey = ws.user?.sub || 'anon';

    // Handle frames
    if (Array.isArray(data) && data[0] === 'state') {
      // binary: ['state', stateObj]
      try {
        await stateLimiter.consume(userKey);
      } catch (rlRejected) {
        ws.send(JSON.stringify({ type: 'error', message: 'state rate limit exceeded' }));
        return;
      }
      const state = data[1];
      const meta = metaByWs.get(ws) || {};
      meta.lastState = state;
      metaByWs.set(ws, meta);
      // no immediate commentary call; periodic worker will use meta.lastState
    } else if (data && data.type === 'state') {
      // text JSON state
      try {
        await stateLimiter.consume(userKey);
      } catch (rlRejected) {
        ws.send(JSON.stringify({ type: 'error', message: 'state rate limit exceeded' }));
        return;
      }
      const state = data.state;
      const meta = metaByWs.get(ws) || {};
      meta.lastState = state;
      metaByWs.set(ws, meta);
    } else if (data && data.type === 'coach_enable') {
      const meta = metaByWs.get(ws) || {};
      meta.coachEnabled = !!data.enable;
      meta.lastCoachAt = 0;
      metaByWs.set(ws, meta);
      ws.send(JSON.stringify({ type: 'coach_status', enabled: meta.coachEnabled }));
    } else if (data && data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
    }
  });

  ws.on('close', () => {
    metaByWs.delete(ws);
    console.log('WS disconnected');
  });
});

// Helper: simulated commentary (fallback)
function generateSimulatedCommentary(state) {
  const phrases = [
    'Nice block!', 'Amazing reflex!', 'Edge of the paddle — nearly missed!', 'Fast return!', 'Deep to the corner!',
    'Watch the angle!', 'Move early to intercept', 'Keep paddle centered', 'Aim low for a tough return'
  ];
  const p = phrases[Math.floor(Math.random() * phrases.length)];
  if (Math.random() < 0.05) {
    const aiSpeed = Math.max(2, Math.min(8, (state?.rightPaddle?.speed || 4) + (Math.random() < 0.5 ? -0.5 : 0.5)));
    return JSON.stringify({ type: 'aiAdjust', aiSpeed: Number(aiSpeed.toFixed(2)) });
  }
  return p;
}
function generateSimulatedCoachTip(state) {
  const tips = [
    'Keep paddle centered and move small amounts; this reduces overcommit and increases reach for angled returns.',
    'Anticipate opponent returns by watching their paddle center; move preemptively rather than reacting late.',
    'Aim slightly ahead of the ball to push returns low — low angles are harder to reach and often cause misses.'
  ];
  return tips[Math.floor(Math.random() * tips.length)];
}

// Periodic worker: commentary for each connected client (reduced frequency)
setInterval(async () => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const meta = metaByWs.get(ws);
    if (!meta || !meta.lastState) continue;
    if (now - (meta.lastCommentAt || 0) < COMMENTARY_INTERVAL_MS) continue;

    const userKey = ws.user?.sub || 'anon';
    // enforce commentary limit per minute via Redis limiter
    try {
      await commentaryLimiter.consume(userKey);
    } catch (rlRejected) {
      ws.send(JSON.stringify({ type: 'commentary', text: '[commentary rate-limited]' }));
      meta.lastCommentAt = now;
      metaByWs.set(ws, meta);
      continue;
    }

    meta.lastCommentAt = now;
    metaByWs.set(ws, meta);

    const s = meta.lastState;
    const systemPrompt = `You are a concise sports commentator for a Pong match. Reply with either one short (<25 words) lively commentary phrase or, if recommending an AI adjustment, output a single-line JSON ONLY like {"type":"aiAdjust","aiSpeed":<number>} with no other text.`;
    const userPrompt = `Snapshot:
ball x=${Number(s.ball.x).toFixed(1)} y=${Number(s.ball.y).toFixed(1)} vx=${Number(s.ball.vx).toFixed(2)} vy=${Number(s.ball.vy).toFixed(2)}
leftPaddle.y=${Number(s.leftPaddle.y).toFixed(1)}
rightPaddle.y=${Number(s.rightPaddle.y).toFixed(1)} speed=${Number(s.rightPaddle.speed)}
score player=${s.score.player} ai=${s.score.ai}
running=${s.running}

Respond accordingly.`;

    if (SIMULATED_MODE || !openaiClient) {
      const out = generateSimulatedCommentary(s);
      // If out is JSON control string, forward control
      try {
        const parsed = JSON.parse(out);
        if (parsed && parsed.type === 'aiAdjust') {
          ws.send(JSON.stringify({ type: 'control', control: parsed }));
          ws.send(JSON.stringify({ type: 'commentary', text: `(AI speed set to ${parsed.aiSpeed})` }));
          continue;
        }
      } catch (e) { /* not JSON */ }
      ws.send(JSON.stringify({ type: 'commentary', text: out }));
      continue;
    }

    // Streaming call using openai@4.6.0 chat completions with stream:true
    try {
      const stream = await openaiClient.chat.completions.create({
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 64,
        temperature: 0.8,
        stream: true
      });

      // stream is an async iterable of chunks
      let aggregated = '';
      for await (const part of stream) {
        const choices = part?.choices || [];
        for (const ch of choices) {
          const textChunk = ch?.delta?.content || ch?.delta?.text || ch?.text || '';
          if (textChunk) {
            aggregated += textChunk;
            ws.send(JSON.stringify({ type: 'commentary_chunk', text: textChunk }));
          }
        }
      }

      const finalText = (aggregated || '').trim();
      // If JSON control
      try {
        const parsed = JSON.parse(finalText);
        if (parsed && parsed.type === 'aiAdjust' && typeof parsed.aiSpeed === 'number') {
          ws.send(JSON.stringify({ type: 'control', control: parsed }));
          ws.send(JSON.stringify({ type: 'commentary', text: `(AI speed set to ${parsed.aiSpeed})` }));
          continue;
        }
      } catch (e) {
        // not JSON
      }

      ws.send(JSON.stringify({ type: 'commentary', text: finalText }));
    } catch (err) {
      console.error('OpenAI commentary stream error:', err?.message || err);
      ws.send(JSON.stringify({ type: 'commentary', text: '[commentary error]' }));
    }
  }
}, Math.max(300, COMMENTARY_INTERVAL_MS));

// Coach periodic worker (longer tips)
setInterval(async () => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const meta = metaByWs.get(ws);
    if (!meta || !meta.coachEnabled || !meta.lastState) continue;
    if (now - (meta.lastCoachAt || 0) < COACH_INTERVAL_MS) continue;

    const userKey = ws.user?.sub || 'anon';
    try {
      await commentaryLimiter.consume(userKey);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'coach', text: '[coach rate-limited]' }));
      meta.lastCoachAt = now;
      metaByWs.set(ws, meta);
      continue;
    }

    meta.lastCoachAt = now;
    metaByWs.set(ws, meta);

    const s = meta.lastState;
    const systemPrompt = `You are a Pong coach giving one concise strategy tip (about 40-60 words) focusing on positioning and timing.`;
    const userPrompt = `Snapshot:
ball x=${Number(s.ball.x).toFixed(1)} y=${Number(s.ball.y).toFixed(1)} vx=${Number(s.ball.vx).toFixed(2)} vy=${Number(s.ball.vy).toFixed(2)}
leftPaddle.y=${Number(s.leftPaddle.y).toFixed(1)}
rightPaddle.y=${Number(s.rightPaddle.y).toFixed(1)} speed=${Number(s.rightPaddle.speed)}
score player=${s.score.player} ai=${s.score.ai}
running=${s.running}

Provide one coaching tip.`;

    if (SIMULATED_MODE || !openaiClient) {
      ws.send(JSON.stringify({ type: 'coach', text: generateSimulatedCoachTip(s) }));
      continue;
    }

    try {
      // Non-streaming for coach tips
      const resp = await openaiClient.chat.completions.create({
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.7,
        stream: false
      });

      const coachText = resp?.choices?.[0]?.message?.content ?? resp?.choices?.[0]?.text ?? '[coach error]';
      ws.send(JSON.stringify({ type: 'coach', text: String(coachText).trim() }));
    } catch (err) {
      console.error('Coach call error:', err?.message || err);
      ws.send(JSON.stringify({ type: 'coach', text: '[coach error]' }));
    }
  }
}, COACH_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (WS subprotocol: pong-proto.v1)`);
});