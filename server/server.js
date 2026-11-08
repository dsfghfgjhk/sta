// STA 온라인 서버: 모든 플레이어가 한 세계에 들어와요.
// 각자 자기 위치·차·동작을 보내고, 서버는 초당 15번 모두의 상태를 모아 뿌려 줘요.
// 총알·주먹은 쏜 사람 화면에서 맞았는지 판단하고, 서버는 맞은 사람에게 전달만 해요.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 40;
const clients = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(`STA 서버 작동 중 · 접속 ${clients.size}명`);
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 12) || '익명';
const cleanText = (s) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0; };
const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(typeof m === 'string' ? m : JSON.stringify(m)); };
const broadcast = (m, except) => { const s = JSON.stringify(m); for (const c of clients.values()) if (c !== except) send(c, s); };

// 상태 배열: [x, z, y, 방향, 속도, 모드(0 걸음·1 운전·2 동승·3 쓰러짐·4 넘어짐), 무기, 차종, 차색, 차 방향, 차 속도, 같이 탄 운전자 id, 체력, 가드]
const STATE_LIMITS = [[-2000, 2000], [-2000, 2000], [-50, 200], [-100, 100], [-100, 100], [0, 4], [0, 9], [-1, 20], [0, 0xffffff], [-100, 100], [-100, 100], [0, 1e9], [0, 200], [0, 1]];

wss.on('connection', (ws) => {
  if (clients.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }
  const id = nextId++;
  const c = { id, ws, name: '익명', look: 0, st: null, msgs: 0, chatT: 0, alive: true, ready: false };
  clients.set(id, c);

  ws.on('message', (buf) => {
    if (++c.msgs > 120) return;
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello': {
        c.name = cleanName(m.name); c.look = num(m.look, 0, 7) | 0; c.ready = true;
        send(c, { t: 'welcome', id, players: [...clients.values()].filter(o => o !== c && o.ready).map(o => ({ id: o.id, name: o.name, look: o.look })) });
        broadcast({ t: 'join', id, name: c.name, look: c.look }, c);
        break;
      }
      case 's': {
        if (!c.ready || !Array.isArray(m.s)) return;
        c.st = STATE_LIMITS.map(([lo, hi], i) => Math.round(num(m.s[i], lo, hi) * 100) / 100);
        break;
      }
      case 'chat': {
        const now = Date.now(); if (now - c.chatT < 800) return; c.chatT = now;
        const text = cleanText(m.text); if (!text) return;
        broadcast({ t: 'chat', id, name: c.name, text });
        break;
      }
      case 'fx': { // 총 쏘기·주먹·폭발 같은 보이는 효과
        if (!c.ready) return;
        const k = String(m.k || '').slice(0, 8), a = Array.isArray(m.a) ? m.a.slice(0, 8).map(v => num(v, -5000, 5000)) : [];
        broadcast({ t: 'fx', id, k, a }, c);
        break;
      }
      case 'hit': { // 다른 플레이어를 맞힘 → 맞은 사람에게 전달
        const to = clients.get(num(m.to, 0, 1e9));
        if (!to || to === c) return;
        send(to, { t: 'hit', from: id, name: c.name, dmg: num(m.dmg, 0, 150), k: String(m.k || '').slice(0, 8), nx: num(m.nx, -1, 1), nz: num(m.nz, -1, 1) });
        break;
      }
      case 'ko': { // 쓰러짐 알림 (누구 때문에)
        const by = clients.get(num(m.by, 0, 1e9));
        broadcast({ t: 'ko', id, name: c.name, by: by ? by.id : 0, byName: by ? by.name : '' });
        break;
      }
      case 'ride': { // 남의 차에 같이 탐 / 내림
        const to = clients.get(num(m.to, 0, 1e9));
        if (to && to !== c) send(to, { t: 'ride', from: id, name: c.name, on: !!m.on });
        break;
      }
    }
  });
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => { clients.delete(id); if (c.ready) broadcast({ t: 'leave', id, name: c.name }); });
  ws.on('error', () => {});
});

setInterval(() => { for (const c of clients.values()) c.msgs = 0; }, 1000);
setInterval(() => {
  const p = [];
  for (const c of clients.values()) if (c.ready && c.st) p.push([c.id, ...c.st]);
  const msg = JSON.stringify({ t: 'snap', p });
  for (const c of clients.values()) if (c.ready) send(c, msg);
}, 66);
setInterval(() => {
  for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch {} }
}, 20000);

server.listen(PORT, () => console.log(`STA 서버가 ${PORT}번 포트에서 기다리는 중`));
