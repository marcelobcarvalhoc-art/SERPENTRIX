const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── ROOM CONFIG ──────────────────────────────
const ROOM_TYPES = {
  BRONZE:   { fee: 1,  maxPlayers: 20 },
  PRATA:    { fee: 5,  maxPlayers: 25 },
  OURO:     { fee: 10, maxPlayers: 30 },
  DIAMANTE: { fee: 50, maxPlayers: 10 },
};

// rooms[roomId] = { type, players[], started, countdownTimer }
const rooms = {};

function findOrCreateRoom(type) {
  const cfg = ROOM_TYPES[type];
  for (const [id, r] of Object.entries(rooms)) {
    if (r.type === type && !r.started && r.players.length < cfg.maxPlayers) return id;
  }
  const id = `${type}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  rooms[id] = { type, players: [], started: false, countdownTimer: null };
  return id;
}

function broadcastLobby(roomId) {
  const r = rooms[roomId];
  if (!r) return;
  io.to(roomId).emit('lobbyUpdate', {
    players: r.players.map(p => ({ id: p.id, name: p.name, color: p.color })),
    roomId,
    type: r.type,
    maxPlayers: ROOM_TYPES[r.type].maxPlayers,
  });
}

function startCountdown(roomId) {
  const r = rooms[roomId];
  if (!r || r.countdownTimer) return;
  let secs = 5;
  io.to(roomId).emit('countdown', { secs });
  r.countdownTimer = setInterval(() => {
    secs--;
    if (secs > 0) {
      io.to(roomId).emit('countdown', { secs });
    } else {
      clearInterval(r.countdownTimer);
      r.started = true;
      io.to(roomId).emit('gameStart', {
        players: r.players.map(p => ({ id: p.id, name: p.name, color: p.color, pat: p.pat })),
        roomType: r.type,
        pot: ROOM_TYPES[r.type].fee * r.players.length,
      });
    }
  }, 1000);
}

// ── SOCKET EVENTS ────────────────────────────
io.on('connection', socket => {
  let myRoomId = null;

  // ── JOIN ROOM ──
  socket.on('joinRoom', ({ type, name, color, pat }) => {
    if (!ROOM_TYPES[type]) return;
    myRoomId = findOrCreateRoom(type);
    const r = rooms[myRoomId];

    r.players.push({ id: socket.id, name, color, pat });
    socket.join(myRoomId);

    socket.emit('roomJoined', { roomId: myRoomId, playerId: socket.id });
    broadcastLobby(myRoomId);

    // Start countdown when 2+ players (adjust as you like)
    if (r.players.length >= 2 && !r.countdownTimer) {
      startCountdown(myRoomId);
    }
  });

  // ── PLAYER STATE (position relay) ──
  socket.on('state', data => {
    if (myRoomId) socket.to(myRoomId).emit('state', { id: socket.id, ...data });
  });

  // ── PLAYER DIED ──
  socket.on('died', data => {
    if (myRoomId) io.to(myRoomId).emit('playerDied', { id: socket.id, ...data });
  });

  // ── ENCIRCLEMENT KILL (client tells server who they killed) ──
  socket.on('killed', ({ targetId, reason }) => {
    if (myRoomId) io.to(myRoomId).emit('playerDied', { id: targetId, killedBy: socket.id, reason });
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    if (!myRoomId || !rooms[myRoomId]) return;
    const r = rooms[myRoomId];
    r.players = r.players.filter(p => p.id !== socket.id);
    io.to(myRoomId).emit('playerLeft', { id: socket.id });

    // Check win condition: 1 real player left
    if (r.started) {
      const alive = r.players;
      if (alive.length === 1) {
        io.to(myRoomId).emit('playerWon', { id: alive[0].id });
      }
    }

    // Cleanup empty rooms
    if (r.players.length === 0) {
      if (r.countdownTimer) clearInterval(r.countdownTimer);
      delete rooms[myRoomId];
    }
  });
});

// ── START ────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🐍 SERPENTRIX server on port ${PORT}`));
