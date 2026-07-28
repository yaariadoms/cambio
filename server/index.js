const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');
const { runBotTurn } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();
// socket.id -> { roomCode, playerId }
const socketMeta = new Map();
// roomCode -> timeout handle, pending deletion of an empty room
const emptyRoomTimers = new Map();
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000; // let a lone disconnected player refresh and rejoin
const MAX_PLAYERS = 4;
const BOT_TURN_DELAY_MS = [3000, 5000]; // [min, max) - slow enough to leave a real window to glue
const DEAL_PEEK_MS = 4000; // must exceed the client's peek-flash duration (3500ms)

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cancelEmptyRoomTimer(code) {
  const handle = emptyRoomTimers.get(code);
  if (handle) {
    clearTimeout(handle);
    emptyRoomTimers.delete(code);
  }
}

function scheduleEmptyRoomCleanup(code) {
  cancelEmptyRoomTimer(code);
  const handle = setTimeout(() => {
    const room = rooms.get(code);
    if (room && room.isEmpty()) rooms.delete(code);
    emptyRoomTimers.delete(code);
  }, EMPTY_ROOM_GRACE_MS);
  emptyRoomTimers.set(code, handle);
}

function broadcastRoom(room) {
  for (const player of room.players) {
    if (player.isBot) continue;
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket && player.connected) socket.emit('state', room.getStateFor(player.id));
  }
  scheduleBotTurnIfNeeded(room);
}

function scheduleBotTurnIfNeeded(room) {
  const cur = room.currentPlayer();
  if (room.phase !== 'play' || !cur || !cur.isBot || room.botTurnScheduled) return;
  room.botTurnScheduled = true;
  const delay = BOT_TURN_DELAY_MS[0] + Math.random() * (BOT_TURN_DELAY_MS[1] - BOT_TURN_DELAY_MS[0]);
  setTimeout(() => {
    room.botTurnScheduled = false;
    if (rooms.get(room.code) !== room || room.phase !== 'play') return;
    const stillCur = room.currentPlayer();
    if (!stillCur || !stillCur.isBot) return;
    try {
      runBotTurn(room, stillCur.id);
    } catch (err) {
      console.error(`Bot turn failed in room ${room.code}:`, err);
    }
    // Safety net: if the bot's turn didn't fully resolve (e.g. an
    // unexpected error mid-decision), force it to a clean end rather than
    // stalling the room forever on a card nobody can act on.
    try {
      if (room.phase === 'play' && room.currentPlayer() && room.currentPlayer().id === stillCur.id) {
        if (room.drawnCard) {
          if (room.drawnFrom === 'discard') room.decideSwap(stillCur.id, 0);
          else room.decideDiscard(stillCur.id);
        }
        if (room.pendingPower && room.pendingPower.playerId === stillCur.id) room.skipPower(stillCur.id);
      }
    } catch (err) {
      console.error(`Bot turn recovery failed in room ${room.code}:`, err);
    }
    broadcastRoom(room);
  }, delay);
}

function scheduleBeginPlay(room) {
  setTimeout(() => {
    if (rooms.get(room.code) !== room || room.phase !== 'dealing') return;
    room.beginPlay();
    broadcastRoom(room);
  }, DEAL_PEEK_MS);
}

function sendJoined(socket, room, player) {
  socket.emit('joined', { roomCode: room.code, playerId: player.id, token: player.token });
}

function withRoom(socket, handler) {
  const meta = socketMeta.get(socket.id);
  if (!meta) {
    socket.emit('errorMsg', 'You are not in a room.');
    return;
  }
  const room = rooms.get(meta.roomCode);
  if (!room) {
    socket.emit('errorMsg', 'Room no longer exists.');
    return;
  }
  try {
    handler(room, meta.playerId);
    broadcastRoom(room);
  } catch (err) {
    socket.emit('errorMsg', err.message || 'Action failed');
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    const code = generateRoomCode();
    const room = new Room(code);
    rooms.set(code, room);
    const player = room.addPlayer(socket.id, name);
    socketMeta.set(socket.id, { roomCode: code, playerId: player.id });
    sendJoined(socket, room, player);
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ roomCode, name }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('errorMsg', 'Room not found.');
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('errorMsg', 'That game has already started.');
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('errorMsg', `Room is full (max ${MAX_PLAYERS} players).`);
      return;
    }
    const player = room.addPlayer(socket.id, name);
    socketMeta.set(socket.id, { roomCode: code, playerId: player.id });
    sendJoined(socket, room, player);
    room.addLog(`${player.name} joined the room.`);
    broadcastRoom(room);
  });

  socket.on('rejoin', ({ roomCode, playerId, token }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) {
      socket.emit('rejoinFailed');
      return;
    }
    const player = room.reconnectPlayer(playerId, token, socket.id);
    if (!player) {
      socket.emit('rejoinFailed');
      return;
    }
    socketMeta.set(socket.id, { roomCode: code, playerId: player.id });
    cancelEmptyRoomTimer(code);
    sendJoined(socket, room, player);
    broadcastRoom(room);
  });

  socket.on('startGame', () => withRoom(socket, (room, playerId) => {
    if (room.hostId !== playerId) throw new Error('Only the host can start the game');
    room.startGame();
    scheduleBeginPlay(room);
  }));

  socket.on('addBot', () => withRoom(socket, (room, playerId) => {
    if (room.hostId !== playerId) throw new Error('Only the host can add a bot');
    if (room.phase !== 'lobby') throw new Error('Cannot add a bot after the game has started');
    if (room.players.length >= MAX_PLAYERS) throw new Error(`Room is full (max ${MAX_PLAYERS} players).`);
    room.addBot();
  }));

  socket.on('removeBot', ({ playerId: botId }) => withRoom(socket, (room, playerId) => {
    if (room.hostId !== playerId) throw new Error('Only the host can remove a bot');
    room.removeBot(botId);
  }));

  socket.on('drawFromDeck', () => withRoom(socket, (room, playerId) => room.drawFromDeck(playerId)));
  socket.on('drawFromDiscard', () => withRoom(socket, (room, playerId) => room.drawFromDiscard(playerId)));
  socket.on('decideSwap', ({ index }) => withRoom(socket, (room, playerId) => room.decideSwap(playerId, index)));
  socket.on('decideDiscard', () => withRoom(socket, (room, playerId) => room.decideDiscard(playerId)));
  socket.on('skipPower', () => withRoom(socket, (room, playerId) => room.skipPower(playerId)));
  socket.on('powerAction', (payload) => withRoom(socket, (room, playerId) => room.powerAction(playerId, payload)));
  socket.on('attemptGlue', ({ targetPlayerId, targetIndex }) => withRoom(socket, (room, playerId) => room.attemptGlue(playerId, targetPlayerId, targetIndex)));
  socket.on('resolveGive', ({ index }) => withRoom(socket, (room, playerId) => room.resolveGive(playerId, index)));
  socket.on('callCambio', () => withRoom(socket, (room, playerId) => room.callCambio(playerId)));
  socket.on('playAgain', () => withRoom(socket, (room, playerId) => {
    if (room.hostId !== playerId) throw new Error('Only the host can start a new round');
    room.startGame();
    scheduleBeginPlay(room);
  }));

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    socketMeta.delete(socket.id);
    if (!room) return;
    room.removeBySocket(socket.id);
    if (room.isEmpty()) {
      scheduleEmptyRoomCleanup(meta.roomCode);
    } else {
      broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Cambio server running at http://localhost:${PORT}`);
});
