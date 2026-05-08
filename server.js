const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  const fs = require('fs');
  const pub  = path.join(__dirname, 'public', 'index.html');
  const root = path.join(__dirname, 'index.html');
  if (fs.existsSync(pub))  res.sendFile(pub);
  else if (fs.existsSync(root)) res.sendFile(root);
  else res.send('index.html não encontrado');
});

// ── CONSTANTS ──────────────────────────────
const ROOM_CFG = {
  BRONZE:   { fee:1,  maxPlayers:20 },
  PRATA:    { fee:5,  maxPlayers:25 },
  OURO:     { fee:10, maxPlayers:30 },
  DIAMANTE: { fee:50, maxPlayers:10 },
};
const SPD=110, TURN=18, BW=12, TS=3, GDUR=120, ZGRACE=5;
const ARENA=900, CX=450, CY=450;
const BOT_NAMES=['NEON-X','VOLT','KRAKEN','SHADOW','APEX','TITAN','CIPHER','GHOST',
  'VIPER','STORM','BLAZE','FROST','RAZOR','PULSE','FLUX','SIGMA',
  'OMEGA','DELTA','NOVA','RYZE','LYNX','ECHO','ZION','WRAITH','PYRO','KODA','ZETA','REX','NEXUS'];
const COLS=['#00ff7f','#ff00ff','#00f5ff','#ff6b00','#b700ff','#ff1744','#ffd700','#00bfff',
  '#ff69b4','#39ff14','#ff4500','#1e90ff','#ff1493','#7fff00','#dc143c','#00ced1',
  '#ff8c00','#9400d3','#32cd32','#ff6347','#4169e1','#ffa500','#adff2f','#da70d6',
  '#00fa9a','#f0e68c','#e0115f','#40e0d0','#ff007f','#c0ff00'];

const rooms = {};

// ── SNAKE (server-side) ──────────────────
function makeSnake(x, y, angle, color, name, isBot) {
  const trail = [];
  for (let i = 0; i < 50; i++)
    trail.push({ x: x - Math.cos(angle)*i*TS, y: y - Math.sin(angle)*i*TS });
  return { x, y, angle, targetAngle: angle, color, name, isBot,
           w: BW, trail, trailAcc: 0, mT: 50,
           alive: true, outsideTime: 0, aiTimer: Math.random()*1.5, aiTx: x, aiTy: y };
}

function moveSnake(s, dt) {
  let d = s.targetAngle - s.angle;
  while (d >  Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  s.angle += Math.sign(d) * Math.min(Math.abs(d), TURN*dt);
  const spd = SPD * dt;
  s.x += Math.cos(s.angle)*spd;
  s.y += Math.sin(s.angle)*spd;
  s.trailAcc += spd;
  if (s.trailAcc >= TS) {
    s.trail.unshift({ x: s.x, y: s.y });
    s.trailAcc = 0;
    while (s.trail.length > s.mT + 5) s.trail.pop();
  }
}

function botAI(s, zone, sparks, dt) {
  s.aiTimer -= dt;
  if (s.aiTimer > 0) { s.targetAngle = Math.atan2(s.aiTy-s.y, s.aiTx-s.x); return; }
  s.aiTimer = 0.2 + Math.random()*0.4;
  const r = zone.radius, dc = Math.hypot(s.x-CX, s.y-CY);
  if (dc > r - 90) {
    const a = Math.atan2(CY-s.y, CX-s.x) + (Math.random()-.5)*.5;
    s.aiTx = CX + Math.cos(a)*r*.35; s.aiTy = CY + Math.sin(a)*r*.35;
  } else {
    let best=null, bd=Infinity;
    for (const sp of sparks) {
      const d = Math.hypot(sp.x-s.x, sp.y-s.y);
      if (d < bd) { bd=d; best=sp; }
    }
    if (best && bd < 280) { s.aiTx=best.x; s.aiTy=best.y; }
    else {
      const wa=Math.random()*Math.PI*2, wr=(r-90)*.7;
      s.aiTx=CX+Math.cos(wa)*wr*Math.random(); s.aiTy=CY+Math.sin(wa)*wr*Math.random();
    }
  }
  s.targetAngle = Math.atan2(s.aiTy-s.y, s.aiTx-s.x);
}

function spawnSparks(n, zone) {
  const sparks = [];
  for (let i = 0; i < n; i++) {
    const r = zone.radius*(.14+Math.random()*.78), a = Math.random()*Math.PI*2;
    sparks.push({ x: CX+Math.cos(a)*r, y: CY+Math.sin(a)*r, isDeath:false, sz:6 });
  }
  return sparks;
}

// ── ROOM MANAGEMENT ─────────────────────
function findOrCreateRoom(type) {
  const cfg = ROOM_CFG[type];
  for (const [id, r] of Object.entries(rooms))
    if (r.type===type && !r.started && r.players.length < cfg.maxPlayers) return id;
  const id = `${type}_${Date.now()}`;
  rooms[id] = { type, players:[], started:false, countdownTimer:null, gameLoop:null };
  return id;
}

function broadcastLobby(roomId) {
  const r = rooms[roomId]; if (!r) return;
  io.to(roomId).emit('lobbyUpdate', {
    players: r.players.map(p=>({id:p.id,name:p.name,color:p.color})),
    maxPlayers: ROOM_CFG[r.type].maxPlayers,
  });
}

function startCountdown(roomId) {
  const r = rooms[roomId]; if (!r||r.countdownTimer) return;
  let secs = 5;
  io.to(roomId).emit('countdown', { secs });
  r.countdownTimer = setInterval(() => {
    secs--;
    if (secs > 0) io.to(roomId).emit('countdown', { secs });
    else {
      clearInterval(r.countdownTimer);
      startServerGame(roomId);
    }
  }, 1000);
}

// ── SERVER GAME LOOP ─────────────────────
function startServerGame(roomId) {
  const r = rooms[roomId]; if (!r) return;
  r.started = true;
  const n = ROOM_CFG[r.type].maxPlayers;
  const initialR = ARENA * 0.45;

  // Zone
  r.zone = { cx:CX, cy:CY, radius:initialR, startRadius:initialR, endRadius:initialR*0.08 };

  // Snakes: real players + bots
  r.snakes = {};
  const total = n;
  for (let i=0; i<total; i++) {
    const ang = (i/total)*Math.PI*2;
    const dist = initialR * 0.62;
    const sx = CX+Math.cos(ang)*dist, sy = CY+Math.sin(ang)*dist;
    const col = COLS[i%COLS.length];
    if (i < r.players.length) {
      const p = r.players[i];
      r.snakes[p.id] = makeSnake(sx, sy, ang+Math.PI, p.color||col, p.name, false);
    } else {
      const botId = `bot_${i}`;
      r.snakes[botId] = makeSnake(sx, sy, ang+Math.PI, col, BOT_NAMES[i%BOT_NAMES.length], true);
    }
  }

  // Sparks
  r.sparks = spawnSparks(n*3, r.zone);
  r.gameTime = 0;
  r.deathOrder = [];
  r.aliveCount = total;

  // Notify clients
  io.to(roomId).emit('gameStart', {
    players: r.players.map(p=>({id:p.id,name:p.name,color:p.color})),
    snakes: Object.entries(r.snakes).map(([id,s])=>({id,x:s.x,y:s.y,angle:s.angle,color:s.color,name:s.name,isBot:s.isBot})),
    zone: r.zone,
    pot: ROOM_CFG[r.type].fee * r.players.length,
  });

  const TICK = 50; // 20fps
  r.gameLoop = setInterval(() => serverTick(roomId, TICK/1000), TICK);
}

function serverTick(roomId, dt) {
  const r = rooms[roomId]; if (!r||!r.started) return;
  r.gameTime += dt;

  // Update zone
  const zp = Math.min(1, r.gameTime/GDUR);
  r.zone.radius = r.zone.startRadius + (r.zone.endRadius - r.zone.startRadius)*zp;

  const snakeList = Object.entries(r.snakes).filter(([,s])=>s.alive);

  // Move snakes
  for (const [id,s] of snakeList) {
    if (s.isBot) botAI(s, r.zone, r.sparks, dt);
    moveSnake(s, dt);
  }

  // Zone check
  for (const [id,s] of snakeList) {
    const dc = Math.hypot(s.x-CX, s.y-CY);
    if (dc > r.zone.radius) {
      s.outsideTime += dt;
      if (s.outsideTime >= ZGRACE) serverKill(roomId, id, null, 'zona');
    } else s.outsideTime = Math.max(0, s.outsideTime - dt*0.4);
  }

  // Spark collision
  const alive2 = Object.entries(r.snakes).filter(([,s])=>s.alive);
  for (const [id,s] of alive2) {
    for (let i=r.sparks.length-1; i>=0; i--) {
      const sp = r.sparks[i];
      if (Math.hypot(sp.x-s.x, sp.y-s.y) < s.w*0.5+sp.sz*0.5) {
        r.sparks.splice(i,1);
        s.mT = Math.min(s.mT+2, 300);
        if (r.sparks.filter(sp=>!sp.isDeath).length < alive2.length*1.5)
          r.sparks.push(...spawnSparks(3, r.zone));
      }
    }
  }

  // Head-to-body collision
  const alive3 = Object.entries(r.snakes).filter(([,s])=>s.alive);
  for (let i=0; i<alive3.length; i++) {
    const [idA,a] = alive3[i]; if (!a.alive) continue;
    for (let j=0; j<alive3.length; j++) {
      if (i===j) continue;
      const [idB,b] = alive3[j]; if (!b.alive) continue;
      for (let k=8; k<b.trail.length-1; k++) {
        if (Math.hypot(a.x-b.trail[k].x, a.y-b.trail[k].y) < (a.w+b.w)*0.46) {
          serverKill(roomId, idA, idB, 'colisão'); b.killCount=(b.killCount||0)+1; break;
        }
      }
    }
    if (!a.alive) continue;
    // Head-to-head
    for (let j=i+1; j<alive3.length; j++) {
      const [idB,b] = alive3[j]; if (!b.alive) continue;
      if (Math.hypot(a.x-b.x, a.y-b.y) < (a.w+b.w)*0.5) {
        if (a.w < b.w)      { serverKill(roomId,idA,idB,'cabeça-a-cabeça'); }
        else if (b.w < a.w) { serverKill(roomId,idB,idA,'cabeça-a-cabeça'); }
        else { serverKill(roomId,idA,null,'empate'); serverKill(roomId,idB,null,'empate'); }
      }
    }
  }

  // Broadcast state (sample trail every 4 points for bandwidth)
  const state = {
    zone: { radius: r.zone.radius },
    snakes: Object.entries(r.snakes).map(([id,s]) => ({
      id, x:s.x, y:s.y, angle:s.angle, w:s.w, alive:s.alive,
      trail: s.trail.filter((_,i)=>i%4===0).slice(0,30),
    })),
    sparks: r.sparks.slice(0,60),
    time: r.gameTime,
    alive: r.aliveCount,
  };
  io.to(roomId).emit('tick', state);

  // Win condition
  const living = Object.entries(r.snakes).filter(([,s])=>s.alive);
  if (living.length <= 1 || r.gameTime >= GDUR) {
    clearInterval(r.gameLoop); r.gameLoop=null;
    const winner = living[0] ? living[0][0] : null;
    // Only real players win
    const winnerIsReal = winner && !r.snakes[winner]?.isBot;
    io.to(roomId).emit('playerWon', { id: winnerIsReal ? winner : null, name: winner ? r.snakes[winner].name : null });
  }
}

function serverKill(roomId, victimId, killerId, reason) {
  const r = rooms[roomId]; if (!r) return;
  const s = r.snakes[victimId]; if (!s||!s.alive) return;
  s.alive = false; r.aliveCount--;
  // Spawn death sparks
  for (let i=0; i<Math.max(2,Math.floor(s.trail.length/14)); i++) {
    const t = s.trail[Math.floor(Math.random()*s.trail.length)];
    r.sparks.push({ x:t.x+(Math.random()-.5)*18, y:t.y+(Math.random()-.5)*18, isDeath:true, sz:11 });
  }
  io.to(roomId).emit('snakeDied', { id:victimId, killerId, reason });
}

// ── SOCKET EVENTS ────────────────────────
io.on('connection', socket => {
  let myRoomId = null;

  socket.on('joinRoom', ({ type, name, color }) => {
    if (!ROOM_CFG[type]) return;
    myRoomId = findOrCreateRoom(type);
    const r = rooms[myRoomId];
    r.players.push({ id:socket.id, name, color });
    socket.join(myRoomId);
    socket.emit('roomJoined', { roomId:myRoomId, playerId:socket.id });
    broadcastLobby(myRoomId);
    if (r.players.length >= 2 && !r.countdownTimer) startCountdown(myRoomId);
  });

  // Client sends only their direction
  socket.on('input', ({ targetAngle, boosting }) => {
    if (!myRoomId) return;
    const r = rooms[myRoomId]; if (!r||!r.snakes) return;
    const s = r.snakes[socket.id]; if (!s||!s.alive) return;
    s.targetAngle = targetAngle;
    if (boosting) s.boosting = true; else s.boosting = false;
  });

  socket.on('disconnect', () => {
    if (!myRoomId || !rooms[myRoomId]) return;
    const r = rooms[myRoomId];
    r.players = r.players.filter(p => p.id !== socket.id);
    if (r.snakes?.[socket.id]) r.snakes[socket.id].alive = false;
    io.to(myRoomId).emit('snakeDied', { id:socket.id, reason:'desconectado' });
    if (r.players.length === 0) {
      if (r.countdownTimer) clearInterval(r.countdownTimer);
      if (r.gameLoop) clearInterval(r.gameLoop);
      delete rooms[myRoomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐍 SERPENTRIX server on port ${PORT}`));
