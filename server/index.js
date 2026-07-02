import express from 'express';
import http from 'http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Server } from 'socket.io';
import cors from 'cors';
import { customAlphabet, nanoid } from 'nanoid';
import { createClient } from '@supabase/supabase-js';
import {
  newRoomState, addPlayer, removePlayer, leavePlayer, startGame, flipInitialCard,
  drawCard, decideDrawnCard, keepDrawnAndPlace, placeDrawnCard, revealHiddenCard, nextRound,
  publicState, setGameMode, playOwnedAction, resolveActionInput, claimStarAction,
  discardOwnedAction, resolveDefensePrompt, expireDefensePrompt,
  resolveGroupChoice, addChatMessage,
  MAX_PLAYERS_PER_ROOM,
} from './game.js';

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const CLIENT_PROTOCOL_VERSION = 3;
const generateRoomId = customAlphabet('0123456789', 6);
const isProduction = process.env.NODE_ENV === 'production';
const ROOM_TTL_MS = Number.parseInt(process.env.ROOM_TTL_MS || '', 10) || 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = Math.min(60 * 60 * 1000, Math.max(60_000, Math.floor(ROOM_TTL_MS / 4)));
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '20kb';
const SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || (isProduction ? '' : 'skyjo-dev-session-token-secret');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SESSION_TOKEN_SECRET) {
  console.error('❌  Variables manquantes : SUPABASE_URL, SUPABASE_SECRET_KEY et SESSION_TOKEN_SECRET sont obligatoires.');
  process.exit(1);
}

if (!SUPABASE_SECRET_KEY.startsWith('sb_secret_')) {
  console.error('❌  SUPABASE_SECRET_KEY doit être une clé Supabase Secret au format sb_secret_... et jamais une clé publishable/anon.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function normalizeOrigin(origin) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return '';
  }
}

function parseAllowedOrigins(value) {
  return new Set(String(value || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean));
}

const configuredOrigins = parseAllowedOrigins(process.env.CLIENT_ORIGINS || process.env.CLIENT_ORIGIN);

function isPrivateDevOrigin(origin) {
  if (isProduction) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    if (!['http:', 'https:'].includes(protocol)) return false;
    if (['localhost', '127.0.0.1', '::1'].includes(hostname)) return true;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname);
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return configuredOrigins.has(normalized) || isPrivateDevOrigin(normalized);
}

function corsOrigin(origin, callback) {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error('Origine non autorisée.'), false);
}

function generateSessionToken() {
  return randomBytes(32).toString('base64url');
}

function normalizeSessionToken(value) {
  const token = String(value || '').trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : '';
}

function hashSessionToken(token) {
  const normalizedToken = normalizeSessionToken(token);
  if (!normalizedToken) return '';
  return createHmac('sha256', SESSION_TOKEN_SECRET)
    .update(normalizedToken)
    .digest('base64url');
}

function safeTokenEqual(expected, received) {
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function stripPlainSessionTokens(state) {
  if (!state?.playersById) return;
  for (const player of Object.values(state.playersById)) {
    if (player && Object.prototype.hasOwnProperty.call(player, 'sessionToken')) {
      delete player.sessionToken;
    }
  }
}

function issuePlayerSessionToken(player) {
  const token = generateSessionToken();
  player.sessionTokenHash = hashSessionToken(token);
  delete player.sessionToken;
  return token;
}

function authorizePlayerSession(player, token) {
  if (!player) return false;
  return safeTokenEqual(player.sessionTokenHash, hashSessionToken(token));
}

async function persist(state) {
  state.updatedAt = Date.now();
  stripPlainSessionTokens(state);
  const { error } = await supabase
    .from('rooms')
    .upsert(
      {
        room_id: state.roomId,
        state_json: state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'room_id' }
    );
  if (error) console.error('Supabase persist error:', error.message);
}

async function loadRoom(roomId) {
  const { data, error } = await supabase
    .from('rooms')
    .select('state_json, updated_at')
    .eq('room_id', roomId)
    .single();
  if (error || !data) return null;
  const state = data.state_json;
  state.updatedAt = Date.parse(data.updated_at) || Date.now();
  stripPlainSessionTokens(state);
  return state;
}

const rooms = new Map();
const socketToPlayer = new Map();
const disconnectTimers = new Map();
const nextRoundTimers = new Map();
const defensePromptTimers = new Map();

function clearRoomTimers(roomId) {
  const nextRoundTimer = nextRoundTimers.get(roomId);
  if (nextRoundTimer) clearTimeout(nextRoundTimer);
  nextRoundTimers.delete(roomId);

  const defensePromptTimer = defensePromptTimers.get(roomId);
  if (defensePromptTimer) clearTimeout(defensePromptTimer);
  defensePromptTimers.delete(roomId);

  for (const [key, timer] of disconnectTimers.entries()) {
    if (!key.startsWith(`${roomId}:`)) continue;
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

async function cleanupStaleRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [roomId, state] of rooms.entries()) {
    if ((state.updatedAt || cutoff + 1) > cutoff) continue;
    rooms.delete(roomId);
    clearRoomTimers(roomId);
  }

  const { error } = await supabase
    .from('rooms')
    .delete()
    .lt('updated_at', new Date(cutoff).toISOString());
  if (error) console.error('Supabase cleanup error:', error.message);
}

function scheduleNextRound(roomId, state) {
  const existingTimer = nextRoundTimers.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    nextRoundTimers.delete(roomId);
  }

  if (state.phase !== 'roundEnd' || !state.nextRoundAt) return;

  const delay = Math.max(0, state.nextRoundAt - Date.now());
  const timer = setTimeout(async () => {
    nextRoundTimers.delete(roomId);
    const latestState = rooms.get(roomId);
    if (!latestState || latestState.phase !== 'roundEnd') return;

    if (latestState.nextRoundAt && latestState.nextRoundAt > Date.now()) {
      scheduleNextRound(roomId, latestState);
      return;
    }

    try {
      nextRound(latestState);
      await persist(latestState);
      broadcastRoom(roomId);
    } catch (error) {
      console.error('Next round error:', error);
    }
  }, delay);
  timer.unref?.();
  nextRoundTimers.set(roomId, timer);
}

function scheduleDefensePrompt(roomId, state) {
  const existingTimer = defensePromptTimers.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    defensePromptTimers.delete(roomId);
  }

  const prompt = state.pendingAction?.defensePrompt;
  if (!prompt?.expiresAt) return;

  const delay = Math.max(0, prompt.expiresAt - Date.now());
  const promptId = prompt.id;
  const timer = setTimeout(async () => {
    defensePromptTimers.delete(roomId);
    const latestState = rooms.get(roomId);
    if (!latestState || latestState.pendingAction?.defensePrompt?.id !== promptId) return;

    try {
      if (expireDefensePrompt(latestState)) {
        await persist(latestState);
        broadcastRoom(roomId);
        scheduleNextRound(roomId, latestState);
        scheduleDefensePrompt(roomId, latestState);
      }
    } catch (error) {
      console.error('Defense prompt expiration error:', error);
    }
  }, delay);
  timer.unref?.();
  defensePromptTimers.set(roomId, timer);
}

async function getOrLoadRoom(roomId) {
  if (rooms.has(roomId)) {
    const state = rooms.get(roomId);
    scheduleNextRound(roomId, state);
    scheduleDefensePrompt(roomId, state);
    return state;
  }
  const state = await loadRoom(roomId);
  if (state) {
    if (state.phase === 'roundEnd' && !state.nextRoundAt) {
      state.nextRoundAt = Date.now() + 10_000;
      await persist(state);
    }
    rooms.set(roomId, state);
    scheduleNextRound(roomId, state);
    scheduleDefensePrompt(roomId, state);
    return state;
  }
  return null;
}

function normalizeRoomVisibility(value) {
  return value === 'public' ? 'public' : 'private';
}

function roomPlayerCount(state) {
  if (!state?.playersById || !Array.isArray(state.order)) return 0;
  return state.order.filter((id) => state.playersById[id]).length;
}

function publicRoomSummary(state) {
  const playerCount = roomPlayerCount(state);
  const creator = state.playersById?.[state.creatorId] || state.playersById?.[state.order?.[0]];
  return {
    roomId: state.roomId,
    playerCount,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    creatorName: creator?.name || 'Salle publique',
    gameMode: state.gameMode || 'classic',
    updatedAt: state.updatedAt || Date.now(),
  };
}

function isJoinablePublicRoom(state) {
  const playerCount = roomPlayerCount(state);
  return state
    && state.roomVisibility === 'public'
    && state.phase === 'lobby'
    && playerCount > 0
    && playerCount < MAX_PLAYERS_PER_ROOM;
}

async function listPublicRooms() {
  const statesByRoomId = new Map();

  const { data, error } = await supabase
    .from('rooms')
    .select('room_id, state_json, updated_at')
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) {
    throw error;
  }

  for (const row of data || []) {
    const state = row.state_json;
    if (!state || typeof state !== 'object') continue;
    state.roomId ||= row.room_id;
    state.updatedAt = Date.parse(row.updated_at) || state.updatedAt || 0;
    statesByRoomId.set(state.roomId, state);
  }

  for (const [roomId, state] of rooms.entries()) {
    statesByRoomId.set(roomId, state);
  }

  const cutoff = Date.now() - ROOM_TTL_MS;
  return [...statesByRoomId.values()]
    .filter((state) => (state.updatedAt || Date.now()) > cutoff)
    .filter(isJoinablePublicRoom)
    .map(publicRoomSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
}

async function createRoom({ roomVisibility = 'private' } = {}) {
  let roomId = '';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generateRoomId();
    if (rooms.has(candidate)) continue;

    const existingRoom = await getOrLoadRoom(candidate);
    if (!existingRoom && !rooms.has(candidate)) {
      roomId = candidate;
      break;
    }
  }

  if (!roomId) {
    throw new Error('Impossible de générer un code de salle unique.');
  }

  const state = newRoomState(roomId);
  state.roomVisibility = normalizeRoomVisibility(roomVisibility);
  rooms.set(roomId, state);
  await persist(state);
  return state;
}

function connectionKey(roomId, playerId) {
  return `${roomId}:${playerId}`;
}

function clearDisconnectTimer(roomId, playerId) {
  const key = connectionKey(roomId, playerId);
  const timer = disconnectTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  disconnectTimers.delete(key);
}

function normalizeRoomId(value) {
  return String(value || '').toUpperCase().replace(/\D/g, '').slice(0, 6);
}

function normalizePlayerId(value) {
  const playerId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{6,40}$/.test(playerId) ? playerId : '';
}

function normalizePlayerName(value) {
  return String(value || '').trim().slice(0, 32);
}

function objectPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const rateBuckets = new Map();

function consumeRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

function cleanupRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

function socketIp(socket) {
  const forwardedFor = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return socket.handshake.address || socket.conn.remoteAddress || 'unknown';
}

function checkSocketRateLimit(socket, eventName) {
  const ip = socketIp(socket);
  const allowed = consumeRateLimit(`socket:${socket.id}`, { limit: 90, windowMs: 10_000 })
    && consumeRateLimit(`socket-ip:${ip}`, { limit: 240, windowMs: 10_000 })
    && (eventName !== 'sendChatMessage'
      || consumeRateLimit(`chat:${socket.id}`, { limit: 12, windowMs: 60_000 }));
  if (!allowed) {
    socket.emit('errorMsg', 'Trop de requêtes. Réessayez dans quelques secondes.');
  }
  return allowed;
}

function withSocketGuard(socket, eventName, handler) {
  return (...args) => {
    if (!checkSocketRateLimit(socket, eventName)) return undefined;
    try {
      const result = handler(...args);
      if (result?.catch) {
        result.catch((error) => {
          console.error(`Socket handler error (${eventName}):`, error.message || error);
          socket.emit('errorMsg', 'Action invalide.');
        });
      }
      return result;
    } catch (error) {
      console.error(`Socket handler error (${eventName}):`, error.message || error);
      socket.emit('errorMsg', 'Action invalide.');
      return undefined;
    }
  };
}

function httpRateLimit({ limit, windowMs, keyPrefix }) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    if (!consumeRateLimit(key, { limit, windowMs })) {
      res.status(429).json({ error: 'Trop de requêtes. Réessayez dans quelques secondes.' });
      return;
    }
    next();
  };
}

async function attachSocketToExistingPlayer(socket, payload = {}) {
  const roomId = normalizeRoomId(payload.roomId);
  const playerId = normalizePlayerId(payload.playerId);
  if (roomId.length !== 6 || !playerId) return null;

  const state = await getOrLoadRoom(roomId);
  const player = state?.playersById?.[playerId];
  if (!state || !player) return null;
  if (!authorizePlayerSession(player, payload.sessionToken)) return null;

  clearDisconnectTimer(roomId, playerId);
  player.connected = true;
  const cleanPlayerName = normalizePlayerName(payload.playerName);
  if (cleanPlayerName) player.name = cleanPlayerName;

  const previousInfo = socketToPlayer.get(socket.id);
  if (previousInfo?.roomId && previousInfo.roomId !== roomId) {
    socket.leave(previousInfo.roomId);
  }
  socketToPlayer.set(socket.id, { roomId, playerId });
  socket.join(roomId);
  await persist(state);
  socket.emit('joined', { roomId, playerId });
  broadcastRoom(roomId);
  scheduleNextRound(roomId, state);
  scheduleDefensePrompt(roomId, state);
  return { roomId, playerId };
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600,
}));
app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

app.get('/health', (req, res) => res.json({ ok: true, clientProtocolVersion: CLIENT_PROTOCOL_VERSION }));

app.post('/api/rooms', httpRateLimit({ keyPrefix: 'create-room', limit: 20, windowMs: 60_000 }), async (req, res) => {
  try {
    const payload = objectPayload(req.body);
    const state = await createRoom({ roomVisibility: normalizeRoomVisibility(payload.roomVisibility) });
    res.json({ roomId: state.roomId });
  } catch (error) {
    console.error('Room creation error:', error);
    res.status(503).json({ error: 'Impossible de créer une salle.' });
  }
});

app.get('/api/rooms/public', httpRateLimit({ keyPrefix: 'list-public-rooms', limit: 60, windowMs: 60_000 }), async (req, res) => {
  try {
    const publicRooms = await listPublicRooms();
    res.json({ rooms: publicRooms });
  } catch (error) {
    console.error('Public room list error:', error);
    res.status(503).json({ error: 'Impossible de charger les salles publiques.' });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 20_000,
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Le port ${PORT} est déjà utilisé. Arrêtez l'autre serveur ou changez PORT dans server/.env.`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

function broadcastRoom(roomId) {
  const state = rooms.get(roomId);
  if (!state) return;
  for (const id of state.order) {
    const p = state.playersById[id];
    if (!p.connected) continue;
    const sockets = [...socketToPlayer.entries()]
      .filter(([, v]) => v.roomId === roomId && v.playerId === id)
      .map(([sid]) => sid);
    for (const sid of sockets) {
      io.to(sid).emit('state', publicState(state, id));
    }
  }
}

async function handleAction(socket, fn) {
  if (!socketToPlayer.has(socket.id) && socket.data.attachPromise) {
    await socket.data.attachPromise.catch(() => null);
  }

  const info = socketToPlayer.get(socket.id);
  if (!info) {
    const auth = socket.handshake.auth || {};
    socket.emit('errorMsg', auth.roomId && auth.playerId
      ? 'Reconnexion à la salle en cours. Réessayez dans un instant.'
      : "Vous ne faites partie d'aucune salle.");
    return;
  }

  const state = await getOrLoadRoom(info.roomId);
  if (!state) {
    socket.emit('errorMsg', 'Salle introuvable.');
    return;
  }
  try {
    await fn(state, info.playerId);
    await persist(state);
    broadcastRoom(info.roomId);
    scheduleNextRound(info.roomId, state);
    scheduleDefensePrompt(info.roomId, state);
  } catch (err) {
    socket.emit('errorMsg', err.message || 'Action invalide.');
  }
}

io.on('connection', (socket) => {
  socket.data.attachPromise = attachSocketToExistingPlayer(socket, socket.handshake.auth)
    .catch((error) => {
      console.error('Socket auto attach error:', error);
      return null;
    });

  socket.on('joinRoom', withSocketGuard(socket, 'joinRoom', async (payload = {}) => {
    const { playerName, playerId, sessionToken: rawSessionToken } = objectPayload(payload);
    let { roomId } = objectPayload(payload);
    roomId = normalizeRoomId(roomId);
    const cleanPlayerName = normalizePlayerName(playerName);
    if (!cleanPlayerName) {
      socket.emit('errorMsg', 'Entrez un nom pour rejoindre la salle.');
      return;
    }
    const state = await getOrLoadRoom(roomId);
    if (!state) {
      socket.emit('errorMsg', "Cette salle n'existe pas.");
      return;
    }
    const pid = normalizePlayerId(playerId) || nanoid(10);
    clearDisconnectTimer(roomId, pid);
    let sessionToken = '';
    if (!state.playersById[pid]) {
      if (state.phase !== 'lobby') {
        socket.emit('errorMsg', 'La partie a déjà commencé.');
        return;
      }
      try {
        addPlayer(state, pid, cleanPlayerName);
      } catch (err) {
        socket.emit('errorMsg', err.message || 'Impossible de rejoindre la salle.');
        return;
      }
      sessionToken = issuePlayerSessionToken(state.playersById[pid]);
    } else {
      if (!authorizePlayerSession(state.playersById[pid], rawSessionToken)) {
        socket.emit('errorMsg', 'Session invalide. Rejoignez à nouveau la salle.');
        return;
      }
      state.playersById[pid].connected = true;
      state.playersById[pid].name = cleanPlayerName;
    }
    const previousInfo = socketToPlayer.get(socket.id);
    if (previousInfo?.roomId && previousInfo.roomId !== roomId) {
      socket.leave(previousInfo.roomId);
    }
    socketToPlayer.set(socket.id, { roomId, playerId: pid });
    socket.join(roomId);
    await persist(state);
    socket.emit('joined', { roomId, playerId: pid, sessionToken });
    broadcastRoom(roomId);
  }));

  socket.on('leaveRoom', withSocketGuard(socket, 'leaveRoom', async (acknowledge) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) {
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
      return;
    }

    clearDisconnectTimer(info.roomId, info.playerId);
    const state = await getOrLoadRoom(info.roomId);
    socketToPlayer.delete(socket.id);
    socket.leave(info.roomId);

    if (state) {
      leavePlayer(state, info.playerId);
      await persist(state);
      broadcastRoom(info.roomId);
      scheduleNextRound(info.roomId, state);
      scheduleDefensePrompt(info.roomId, state);
    }

    if (typeof acknowledge === 'function') acknowledge({ ok: true });
  }));

  socket.on('startGame', withSocketGuard(socket, 'startGame', () =>
    handleAction(socket, (state, pid) => startGame(state, pid))));

  socket.on('setGameMode', withSocketGuard(socket, 'setGameMode', (payload = {}) => {
    const { gameMode } = objectPayload(payload);
    return handleAction(socket, (state, pid) => setGameMode(state, pid, gameMode));
  }));

  socket.on('flipInitial', withSocketGuard(socket, 'flipInitial', (payload = {}) => {
    const { slotIndex } = objectPayload(payload);
    return handleAction(socket, (state, pid) => flipInitialCard(state, pid, slotIndex));
  }));

  socket.on('drawCard', withSocketGuard(socket, 'drawCard', (payload = {}) => {
    const { source } = objectPayload(payload);
    return handleAction(socket, (state, pid) => drawCard(state, pid, source));
  }));

  socket.on('decideDrawn', withSocketGuard(socket, 'decideDrawn', (payload = {}) => {
    const { keep } = objectPayload(payload);
    return handleAction(socket, (state, pid) => decideDrawnCard(state, pid, keep));
  }));

  socket.on('keepDrawnAndPlace', withSocketGuard(socket, 'keepDrawnAndPlace', (payload = {}) => {
    const { slotIndex } = objectPayload(payload);
    return handleAction(socket, (state, pid) => keepDrawnAndPlace(state, pid, slotIndex));
  }));

  socket.on('placeCard', withSocketGuard(socket, 'placeCard', (payload = {}) => {
    const { slotIndex } = objectPayload(payload);
    return handleAction(socket, (state, pid) => placeDrawnCard(state, pid, slotIndex));
  }));

  socket.on('revealCard', withSocketGuard(socket, 'revealCard', (payload = {}) => {
    const { slotIndex } = objectPayload(payload);
    return handleAction(socket, (state, pid) => revealHiddenCard(state, pid, slotIndex));
  }));

  socket.on('playActionCard', withSocketGuard(socket, 'playActionCard', (payload = {}) => {
    const { cardId } = objectPayload(payload);
    return handleAction(socket, (state, pid) => playOwnedAction(state, pid, cardId));
  }));

  socket.on('discardActionCard', withSocketGuard(socket, 'discardActionCard', (payload = {}) => {
    const { cardId } = objectPayload(payload);
    return handleAction(socket, (state, pid) => discardOwnedAction(state, pid, cardId));
  }));

  socket.on('resolveAction', withSocketGuard(socket, 'resolveAction', (payload = {}) =>
    handleAction(socket, (state, pid) => resolveActionInput(state, pid, objectPayload(payload)))));

  socket.on('resolveDefense', withSocketGuard(socket, 'resolveDefense', (payload = {}) => {
    const { useDefense } = objectPayload(payload);
    return handleAction(socket, (state, pid) => resolveDefensePrompt(state, pid, useDefense));
  }));

  socket.on('resolveGroupChoice', withSocketGuard(socket, 'resolveGroupChoice', (payload = {}) => {
    const { remove } = objectPayload(payload);
    return handleAction(socket, (state, pid) => resolveGroupChoice(state, pid, remove));
  }));

  socket.on('claimStarAction', withSocketGuard(socket, 'claimStarAction', (payload = {}) => {
    const { source, marketIndex } = objectPayload(payload);
    return handleAction(socket, (state, pid) => claimStarAction(state, pid, source, marketIndex));
  }));

  socket.on('sendChatMessage', withSocketGuard(socket, 'sendChatMessage', (payload = {}) => {
    const { text } = objectPayload(payload);
    return handleAction(socket, (state, pid) => addChatMessage(state, pid, text));
  }));

  socket.on('disconnect', async () => {
    const info = socketToPlayer.get(socket.id);
    socketToPlayer.delete(socket.id);
    if (!info) return;
    const state = await getOrLoadRoom(info.roomId);
    if (!state) return;
    const stillConnected = [...socketToPlayer.values()]
      .some(v => v.roomId === info.roomId && v.playerId === info.playerId);
    if (!stillConnected) {
      const key = connectionKey(info.roomId, info.playerId);
      const timer = setTimeout(async () => {
        disconnectTimers.delete(key);
        const latestState = await getOrLoadRoom(info.roomId);
        if (!latestState) return;
        const reconnected = [...socketToPlayer.values()]
          .some(v => v.roomId === info.roomId && v.playerId === info.playerId);
        if (reconnected) return;
        removePlayer(latestState, info.playerId);
        await persist(latestState);
        broadcastRoom(info.roomId);
        scheduleNextRound(info.roomId, latestState);
        scheduleDefensePrompt(info.roomId, latestState);
      }, 2500);
      timer.unref?.();
      disconnectTimers.set(key, timer);
    }
  });
});

const cleanupInterval = setInterval(() => {
  cleanupRateBuckets();
  cleanupStaleRooms().catch((error) => {
    console.error('Room cleanup error:', error.message || error);
  });
}, CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`🎴 Skyjo server (Supabase) listening on ${HOST}:${PORT}`);
});
