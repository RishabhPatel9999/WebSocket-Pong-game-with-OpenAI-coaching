/**
 * Browser client:
 * - Plays Pong locally
 * - Connects to server with WS subprotocol ['pong-proto.v1', <JWT>]
 * - Sends state as MessagePack binary ["state", state] when msgpack is available
 * - Handles commentary_chunk, commentary, control, coach messages
 *
 * Note: msgpack runtime is loaded from unpkg in index.html (window.MsgPack)
 */

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const W = canvas.width, H = canvas.height;
  const paddleWidth = 12, paddleHeight = 100, paddleSpeed = 6;

  const leftPaddle = { x: 10, y: (H - paddleHeight) / 2, width: paddleWidth, height: paddleHeight };
  const rightPaddle = { x: W - paddleWidth - 10, y: (H - paddleHeight) / 2, width: paddleWidth, height: paddleHeight, speed: 4 };
  const ball = { x: W/2, y: H/2, r: 8, vx: 0, vy: 0, speed: 5 };

  let playerScore = 0, aiScore = 0;
  let running = false, lastTime = 0;
  const keys = { ArrowUp: false, ArrowDown: false };
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
  function resetBall(direction=null){
    ball.x = W/2; ball.y = H/2; ball.speed=5;
    const angle = (Math.random()*Math.PI/4)-(Math.PI/8);
    const dir = (direction === -1 || direction === 1) ? direction : (Math.random()>0.5?1:-1);
    ball.vx = Math.cos(angle)*ball.speed*dir; ball.vy = Math.sin(angle)*ball.speed;
  }
  resetBall();

  // Input
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    leftPaddle.y = clamp(y - leftPaddle.height/2, 0, H - leftPaddle.height);
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { keys[e.code] = true; e.preventDefault(); }});
  window.addEventListener('keyup', (e) => { if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { keys[e.code] = false; e.preventDefault(); }});
  canvas.addEventListener('click', () => { if (!running) { running = true; serve(); lastTime = performance.now(); requestAnimationFrame(loop);} else running = false; });

  function serve(){ if(playerScore===0 && aiScore===0) resetBall(Math.random()>0.5?1:-1); else resetBall(playerScore>aiScore?1:-1); }

  function circleRectCollision(cx,cy,r,rx,ry,rw,rh){
    const closestX = clamp(cx, rx, rx+rw);
    const closestY = clamp(cy, ry, ry+rh);
    const dx = cx - closestX, dy = cy - closestY;
    return (dx*dx + dy*dy) <= r*r;
  }

  function update(dt){
    if (keys.ArrowUp) leftPaddle.y -= paddleSpeed;
    if (keys.ArrowDown) leftPaddle.y += paddleSpeed;
    leftPaddle.y = clamp(leftPaddle.y, 0, H - leftPaddle.height);

    const aiCenter = rightPaddle.y + rightPaddle.height/2;
    const delta = ball.y - aiCenter;
    const aiMaxMove = rightPaddle.speed;
    let move = clamp(delta * 0.12, -aiMaxMove, aiMaxMove);
    if (Math.abs(delta) < 5) move = 0;
    rightPaddle.y += move; rightPaddle.y = clamp(rightPaddle.y, 0, H - rightPaddle.height);

    ball.x += ball.vx; ball.y += ball.vy;

    if (ball.y - ball.r <= 0) { ball.y = ball.r; ball.vy = -ball.vy; }
    else if (ball.y + ball.r >= H) { ball.y = H - ball.r; ball.vy = -ball.vy; }

    if (ball.vx < 0 && circleRectCollision(ball.x, ball.y, ball.r, leftPaddle.x, leftPaddle.y, leftPaddle.width, leftPaddle.height)) {
      ball.x = leftPaddle.x + leftPaddle.width + ball.r + 0.1;
      const relativeY = (ball.y - (leftPaddle.y + leftPaddle.height/2)) / (leftPaddle.height/2);
      const bounceAngle = relativeY * (Math.PI/4);
      const speed = Math.min(12, Math.hypot(ball.vx, ball.vy) * 1.05);
      ball.vx = Math.abs(Math.cos(bounceAngle) * speed);
      ball.vy = Math.sin(bounceAngle) * speed;
    }
    if (ball.vx > 0 && circleRectCollision(ball.x, ball.y, ball.r, rightPaddle.x, rightPaddle.y, rightPaddle.width, rightPaddle.height)) {
      ball.x = rightPaddle.x - ball.r - 0.1;
      const relativeY = (ball.y - (rightPaddle.y + rightPaddle.height/2)) / (rightPaddle.height/2);
      const bounceAngle = relativeY * (Math.PI/4);
      const speed = Math.min(12, Math.hypot(ball.vx, ball.vy) * 1.05);
      ball.vx = -Math.abs(Math.cos(bounceAngle) * speed);
      ball.vy = Math.sin(bounceAngle) * speed;
    }

    if (ball.x < 0) { aiScore++; running = false; resetBall(1); updateScoreUI(); }
    else if (ball.x > W) { playerScore++; running = false; resetBall(-1); updateScoreUI(); }
  }

  function drawNet(){ const seg = 12; ctx.fillStyle = 'rgba(255,255,255,0.06)'; for(let y=0;y<H;y+=seg*2) ctx.fillRect(W/2-1,y,2,seg); }
  function roundRect(ctx,x,y,w,h,r,fill,stroke){ if(r===undefined) r=5; ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r); ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r); ctx.closePath(); if(fill) ctx.fill(); if(stroke) ctx.stroke(); }

  function draw(){
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = 'rgba(255,255,255,0.01)'; ctx.fillRect(0,0,W,H);
    drawNet();
    ctx.fillStyle = '#e6edf3';
    roundRect(ctx, leftPaddle.x, leftPaddle.y, leftPaddle.width, leftPaddle.height, 4, true, false);
    roundRect(ctx, rightPaddle.x, rightPaddle.y, rightPaddle.width, rightPaddle.height, 4, true, false);
    ctx.beginPath(); ctx.fillStyle = '#22c55e'; ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#cfead1'; ctx.font = '28px system-ui'; ctx.textAlign = 'center'; ctx.fillText(playerScore, W/2 - 60, 40); ctx.fillText(aiScore, W/2 + 60, 40);
    if (!running) {
      ctx.fillStyle = 'rgba(2,6,23,0.6)'; ctx.fillRect(W/2-180, H/2-50, 360, 100);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '20px system-ui'; ctx.fillText('Click to Play / Resume', W/2, H/2-8);
    }
  }

  function loop(timestamp){
    if (!running) { draw(); return; }
    const dt = (timestamp - lastTime) / (1000 / 60);
    lastTime = timestamp;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  draw();

  // UI & commentary
  const commentaryEl = document.getElementById('commentary');
  const playerScoreEl = document.getElementById('playerScore');
  const aiScoreEl = document.getElementById('aiScore');
  const toggleCoachBtn = document.getElementById('toggleCoach');
  const muteBtn = document.getElementById('muteTts');
  const tokenInput = document.getElementById('tokenInput');
  const connectBtn = document.getElementById('connectBtn');
  const getTokenBtn = document.getElementById('getTokenBtn');

  function updateScoreUI(){ playerScoreEl.textContent = playerScore; aiScoreEl.textContent = aiScore; }
  updateScoreUI();

  // TTS
  let ttsEnabled = true; const synth = window.speechSynthesis;
  muteBtn.addEventListener('click', ()=>{ ttsEnabled = !ttsEnabled; muteBtn.textContent = ttsEnabled ? 'Mute TTS' : 'Unmute TTS'; });
  function speak(text){ if (!ttsEnabled || !synth) return; try { synth.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1; synth.speak(u); } catch (e) {} }

  // WebSocket
  let ws = null;
  function connectWebSocket(token) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${wsProtocol}://${location.host}/ws`;
    try {
      ws = new WebSocket(url, ['pong-proto.v1', token]);
    } catch (e) {
      appendCommentary('[ws connect failed]');
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => appendCommentary('[WS connected]');
    ws.onclose = () => appendCommentary('[WS disconnected]');
    ws.onerror = () => appendCommentary('[WS error]');

    ws.onmessage = (ev) => {
      // Expect JSON text messages from server
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { appendCommentary(ev.data); return; }
      if (payload.type === 'commentary_chunk') {
        appendCommentary(payload.text, true);
      } else if (payload.type === 'commentary') {
        appendCommentary(payload.text);
      } else if (payload.type === 'control') {
        if (payload.control?.type === 'aiAdjust') {
          rightPaddle.speed = payload.control.aiSpeed;
          appendCommentary(`(AI speed set to ${payload.control.aiSpeed})`);
        }
      } else if (payload.type === 'coach') {
        appendCommentary(`[Coach] ${payload.text}`);
        speak(payload.text);
      } else if (payload.type === 'welcome') {
        appendCommentary('[server] connected');
      } else {
        appendCommentary(JSON.stringify(payload));
      }
    };
  }

  connectBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) return alert('Paste a JWT token in the input first.');
    connectWebSocket(token);
  });

  getTokenBtn.addEventListener('click', async () => {
    const adminKey = prompt('Enter server ADMIN_KEY to mint a dev JWT (for dev only):');
    if (!adminKey) return;
    try {
      const resp = await fetch('/auth/token', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ adminKey })
      });
      const j = await resp.json();
      if (j.token) {
        tokenInput.value = j.token;
        alert('Token minted and pasted into input. Click Connect WS.');
      } else {
        alert('Failed to mint token: ' + JSON.stringify(j));
      }
    } catch (e) {
      alert('Error requesting token: ' + e.message);
    }
  });

  function appendCommentary(text, incremental=false) {
    if (!text) return;
    const t = new Date().toLocaleTimeString();
    if (incremental) {
      const last = commentaryEl.lastElementChild;
      if (last && last.dataset?.inc === '1') {
        last.innerHTML += text;
        commentaryEl.scrollTop = commentaryEl.scrollHeight;
        return;
      }
      const node = document.createElement('div'); node.dataset.inc = '1'; node.innerHTML = `<small style="opacity:0.6">${t}</small> ${escapeHtml(text)}`; commentaryEl.appendChild(node);
      commentaryEl.scrollTop = commentaryEl.scrollHeight;
    } else {
      const node = document.createElement('div'); node.dataset.inc = '0'; node.innerHTML = `<small style="opacity:0.6">${t}</small> ${escapeHtml(text)}`; commentaryEl.appendChild(node);
      commentaryEl.scrollTop = commentaryEl.scrollHeight;
      speak(text);
    }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c)=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  // Periodically send state as MessagePack (array ["state", state]) if msgpack available, otherwise JSON
  const STATE_SEND_MS = 800;
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const state = {
      ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, r: ball.r },
      leftPaddle: { x: leftPaddle.x, y: leftPaddle.y, width: leftPaddle.width, height: leftPaddle.height },
      rightPaddle: { x: rightPaddle.x, y: rightPaddle.y, width: rightPaddle.width, height: rightPaddle.height, speed: rightPaddle.speed },
      score: { player: playerScore, ai: aiScore },
      running
    };

    // prefer MessagePack using @msgpack/msgpack loaded into window.MsgPack
    try {
      if (window.MsgPack && window.MsgPack.encode) {
        const packed = window.MsgPack.encode(['state', state]);
        ws.send(packed);
      } else {
        ws.send(JSON.stringify({ type: 'state', state }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'state', state }));
    }
  }, STATE_SEND_MS);

  // Coach toggle
  let coachEnabled = false;
  toggleCoachBtn.addEventListener('click', () => {
    coachEnabled = !coachEnabled;
    toggleCoachBtn.textContent = coachEnabled ? 'Disable Coach' : 'Enable Coach';
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'coach_enable', enable: coachEnabled }));
  });

})();