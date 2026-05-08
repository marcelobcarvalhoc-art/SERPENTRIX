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

// ── CONFIG ──────────────────────────────
const ROOM_CFG = {
  BRONZE:   { fee:1,  maxPlayers:20 },
  PRATA:    { fee:5,  maxPlayers:25 },
  OURO:     { fee:10, maxPlayers:30 },
  DIAMANTE: { fee:50, maxPlayers:10 },
};
const SPD=110, TURN=18, BW=12, TS=3, GDUR=120, ZGRACE=5;
const ARENA=900, CX=450, CY=450;

const rooms = {};

// ── SNAKE ───────────────────────────────
function makeSnake(x, y, angle, color, name) {
  const trail = [];
  for (let i = 0; i < 50; i++)
    trail.push({ x: x - Math.cos(angle)*i*TS, y: y - Math.sin(angle)*i*TS });
  return { x, y, angle, targetAngle: angle, color, name,
           w: BW, trail, trailAcc: 0, mT: 50,
           alive: true, outsideTime: 0 };
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

function spawnSparks(n, radius) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const r = radius*(.14+Math.random()*.78), a = Math.random()*Math.PI*2;
    arr.push({ x: CX+Math.cos(a)*r, y: CY+Math.sin(a)*r, isDeath:false, sz:6 });
  }
  return arr;
}

// ── ROOMS ───────────────────────────────
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
    players: r.players.map(p=>({ id:p.id, name:p.name, color:p.color })),
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
    else { clearInterval(r.countdownTimer); startServerGame(roomId); }
  }, 1000);
}

// ── GAME LOOP ────────────────────────────
function startServerGame(roomId) {
  const r = rooms[roomId]; if (!r) return;
  r.started = true;
  const initialR = ARENA * 0.45;
  r.zone = { cx:CX, cy:CY, radius:initialR, startRadius:initialR, endRadius:initialR*0.08 };
  r.snakes = {};
  r.sparks = spawnSparks(r.players.length * 3, initialR);
  r.gameTime = 0;
  r.aliveCount = r.players.length;

  // Spawn only real players
  const n = r.players.length;
  r.players.forEach((p, i) => {
    const ang = (i/n)*Math.PI*2;
    const dist = initialR * 0.62;
    r.snakes[p.id] = makeSnake(
      CX + Math.cos(ang)*dist,
      CY + Math.sin(ang)*dist,
      ang + Math.PI, p.color, p.name
    );
  });

  io.to(roomId).emit('gameStart', {
    players: r.players.map(p=>({ id:p.id, name:p.name, color:p.color })),
    snakes:  Object.entries(r.snakes).map(([id,s])=>({ id, x:s.x, y:s.y, angle:s.angle, color:s.color, name:s.name })),
    zone:    { cx:CX, cy:CY, radius:initialR, startRadius:initialR, endRadius:initialR*0.08 },
    pot:     ROOM_CFG[r.type].fee * r.players.length,
  });

  r.gameLoop = setInterval(() => serverTick(roomId, 1/30), 33);
}

function serverTick(roomId, dt) {
  const r = rooms[roomId]; if (!r||!r.started) return;
  r.gameTime += dt;

  // Zone shrink
  const zp = Math.min(1, r.gameTime/GDUR);
  r.zone.radius = r.zone.startRadius + (r.zone.endRadius - r.zone.startRadius)*zp;

  const alive = () => Object.entries(r.snakes).filter(([,s])=>s.alive);

  // Move apenas bots (jogadores movem no cliente e enviam posição)
  // Como não há bots, este loop está vazio mas mantido para futura expansão
  for (const [id,s] of alive()) {
    if (s.isBot) moveSnake(s, dt); // sem bots ativos, nunca entra aqui
  }

  // Zone deaths
  for (const [id,s] of alive()) {
    const dc = Math.hypot(s.x-CX, s.y-CY);
    if (dc > r.zone.radius) {
      s.outsideTime += dt;
      if (s.outsideTime >= ZGRACE) serverKill(roomId, id, null, 'zona');
    } else s.outsideTime = Math.max(0, s.outsideTime - dt*0.4);
  }

  // Spark collision
  for (const [,s] of alive()) {
    for (let i = r.sparks.length-1; i >= 0; i--) {
      const sp = r.sparks[i];
      if (Math.hypot(sp.x-s.x, sp.y-s.y) < s.w*0.5+sp.sz*0.5) {
        r.sparks.splice(i, 1);
        s.mT = Math.min(s.mT+2, 300);
      }
    }
  }
  if (r.sparks.filter(sp=>!sp.isDeath).length < alive().length * 1.5)
    r.sparks.push(...spawnSparks(3, r.zone.radius));

  // Head-body collision
  const al = alive();
  for (let i=0; i<al.length; i++) {
    const [idA,a] = al[i]; if (!a.alive) continue;
    for (let j=0; j<al.length; j++) {
      if (i===j) continue;
      const [idB,b] = al[j]; if (!b.alive) continue;
      for (let k=8; k<b.trail.length-1; k++) {
        if (Math.hypot(a.x-b.trail[k].x, a.y-b.trail[k].y) < (a.w+b.w)*0.55) {
          serverKill(roomId, idA, idB, 'colisão'); break;
        }
      }
    }
    if (!a.alive) continue;
    // Head-to-head
    for (let j=i+1; j<al.length; j++) {
      const [idB,b] = al[j]; if (!b.alive) continue;
      if (Math.hypot(a.x-b.x, a.y-b.y) < (a.w+b.w)*0.5) {
        if      (a.w < b.w) serverKill(roomId,idA,idB,'cabeça-a-cabeça');
        else if (b.w < a.w) serverKill(roomId,idB,idA,'cabeça-a-cabeça');
        else { serverKill(roomId,idA,null,'empate'); serverKill(roomId,idB,null,'empate'); }
      }
    }
  }

  // Broadcast
  io.to(roomId).emit('tick', {
    zone:   { radius: r.zone.radius },
    snakes: Object.entries(r.snakes).map(([id,s]) => ({
      id, x:s.x, y:s.y, angle:s.angle, w:s.w, alive:s.alive,
      color:s.color, name:s.name,
      trail: s.trail.filter((_,i)=>i%4===0).slice(0,35),
    })),
    sparks: r.sparks.slice(0,80),
    alive:  alive().length,
  });

  // Win condition
  const living = alive();
  if (living.length <= 1 || r.gameTime >= GDUR) {
    clearInterval(r.gameLoop); r.gameLoop = null;
    let winnerId = null;
    if (living.length === 1) {
      winnerId = living[0][0];
    } else if (living.length > 1) {
      // Quem cresceu mais (maior trail) vence por tempo
      winnerId = living.sort((a,b) => (b[1].mT||50) - (a[1].mT||50))[0][0];
    }
    io.to(roomId).emit('playerWon', {
      id:   winnerId,
      name: winnerId ? r.snakes[winnerId].name : null,
    });
  }
}

function serverKill(roomId, victimId, killerId, reason) {
  const r = rooms[roomId]; if (!r) return;
  const s = r.snakes[victimId]; if (!s||!s.alive) return;
  s.alive = false; r.aliveCount--;
  const cnt = Math.max(2, Math.floor(s.trail.length/14));
  for (let i=0; i<cnt; i++) {
    const t = s.trail[Math.floor(Math.random()*s.trail.length)];
    r.sparks.push({ x:t.x+(Math.random()-.5)*18, y:t.y+(Math.random()-.5)*18, isDeath:true, sz:11 });
  }
  io.to(roomId).emit('snakeDied', { id:victimId, killerId, reason });
}

// ── SOCKETS ─────────────────────────────
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

  socket.on('input', (data) => {
    const { targetAngle, x, y, angle, w, mT, trail } = data;
    if (!myRoomId) return;
    const r = rooms[myRoomId]; if (!r?.snakes) return;
    const s = r.snakes[socket.id]; if (!s?.alive) return;
    // Use client-reported position (client is authoritative for own movement)
    if (x !== undefined) { s.x=x; s.y=y; s.angle=angle; }
    if (w  !== undefined) s.w  = w;
    if (typeof mT !== 'undefined') s.mT = mT;
    if (trail?.length) s.trail = trail;
    s.targetAngle = targetAngle;
  });

  socket.on('disconnect', () => {
    if (!myRoomId || !rooms[myRoomId]) return;
    const r = rooms[myRoomId];
    r.players = r.players.filter(p => p.id !== socket.id);
    if (r.snakes?.[socket.id]) {
      r.snakes[socket.id].alive = false;
      io.to(myRoomId).emit('snakeDied', { id:socket.id, reason:'desconectou' });
    }
    if (r.players.length === 0) {
      if (r.countdownTimer) clearInterval(r.countdownTimer);
      if (r.gameLoop)       clearInterval(r.gameLoop);
      delete rooms[myRoomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐍 SERPENTRIX online — porta ${PORT}`));
