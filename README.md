# WebSocket-Pong-game-with-OpenAI-coaching
Create a simple Pong game using HTML, CSS, and JavaScript. The player should control the left paddle with their mouse and arrow keys up/down, the right paddle is the computer. Make sure the game includes a bouncing ball, a scoreboard and collision detection for paddles and walls.
```markdown
Pong — WebSocket (MessagePack) + OpenAI (openai@4.6.0) + Redis rate-limiting + JWT auth + simulated fallback

Overview
- Secure WebSocket subprotocol: `pong-proto.v1` (client sends JWT as second subprotocol)
- Binary MessagePack for compact state updates (browser -> server)
- OpenAI streaming commentary using openai@4.6.0 streaming API
- Redis-backed rate limiting (rate-limiter-flexible + ioredis) to protect budget:
  - State updates: N messages per second (per-user)
  - Commentary calls: M calls per minute (per-user)
- JWT minting endpoint for dev (`/auth/token`, requires ADMIN_KEY)
- Simulated commentary fallback when OPENAI_API_KEY missing or SIMULATED_MODE=true

Run locally (quick)
1. npm install
2. Copy `.env.example` -> `.env` and set values (OPENAI_API_KEY optional for simulation)
3. Start Redis (local or use REDIS_URL)
4. npm start
5. Open http://localhost:3000, get/paste a JWT (dev token available via "Get Token (dev)"), then connect WS and play.

Files:
- server.js (main server)
- package.json
- .env.example
- public/index.html
- public/style.css
- public/script.js
```
