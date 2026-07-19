import express from 'express';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import cors from 'cors';
import { customAlphabet, nanoid } from 'nanoid';
import { buildSupabaseClient } from './bootstrap.js';
import { createAuthBff } from './authBff.js';
import {
  newRoomState, addPlayer, leavePlayer, startGame, flipInitialCard,
  drawCard, decideDrawnCard, keepDrawnAndPlace, placeDrawnCard, revealHiddenCard, nextRound,
  publicState, setGameMode, playOwnedAction, resolveActionInput, claimStarAction,
  discardOwnedAction, resolveDefensePrompt, expireDefensePrompt,
  resolveGroupChoice, MAX_PLAYERS_PER_ROOM,
} from './game.js';
import {
  CLIENT_PROTOCOL_VERSION, CONSENT_VERSION, ROOM_SCHEMA_VERSION, ROOM_TTL_MS,
  PublicError, clientIpFromForwarded,
  isValidRoomState, normalizeChatMessage, normalizeOrigin,
  normalizePlayerName, normalizeRoomId, objectPayload, publicErrorPayload, requestId,
} from './security.js';

const DEFAULT_PORT = 4000;
const MAX_RATE_BUCKETS = 20_000;
const MAX_SOCKETS_PER_USER = 3;
const CHAT_PAGE_SIZE = 80;
const DISCONNECT_GRACE_MS = 30_000;
const SESSION_CHECK_CACHE_MS = 30_000;
const generateRoomId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-', 16);
const NODE_ENV = process.env.NODE_ENV || 'development';
if (!['development', 'test', 'production'].includes(NODE_ENV)) {
  console.error('❌  NODE_ENV doit valoir development, test ou production.');
  process.exit(1);
}
const isProduction = NODE_ENV === 'production';

function parseInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

const PORT = parseInteger(process.env.PORT, DEFAULT_PORT, { min: 1, max: 65535 });
const HOST = process.env.HOST || '0.0.0.0';
const JSON_BODY_LIMIT = '20kb';
const SUPABASE_URL = normalizeOrigin(process.env.SUPABASE_URL, { production: isProduction });
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || '').trim();
const SUPABASE_PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const AUTH_SESSION_ENCRYPTION_KEY = String(process.env.AUTH_SESSION_ENCRYPTION_KEY || '').trim();
const PUBLIC_SERVER_URL = String(process.env.PUBLIC_SERVER_URL || `http://localhost:${PORT}`).trim();
const TURNSTILE_SECRET_KEY = String(process.env.TURNSTILE_SECRET_KEY || '').trim();

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SUPABASE_PUBLISHABLE_KEY) {
  console.error('❌  SUPABASE_URL, SUPABASE_SECRET_KEY et SUPABASE_PUBLISHABLE_KEY sont obligatoires.');
  process.exit(1);
}
if (!SUPABASE_SECRET_KEY.startsWith('sb_secret_') || SUPABASE_SECRET_KEY.length < 32) {
  console.error('❌  SUPABASE_SECRET_KEY doit être une clé Supabase Secret valide.');
  process.exit(1);
}
if (!AUTH_SESSION_ENCRYPTION_KEY) {
  console.error('❌  AUTH_SESSION_ENCRYPTION_KEY est obligatoire.');
  process.exit(1);
}
if (isProduction && (TURNSTILE_SECRET_KEY.length < 20 || TURNSTILE_SECRET_KEY.length > 2048)) {
  console.error('❌  TURNSTILE_SECRET_KEY est obligatoire et invalide en production.');
  process.exit(1);
}
if (isProduction && !process.env.CLIENT_ORIGINS) {
  console.error('❌  CLIENT_ORIGINS est obligatoire en production.');
  process.exit(1);
}
if (!['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost'].includes(HOST)) {
  console.error('❌  HOST n\'est pas autorisé.');
  process.exit(1);
}
if (process.env.ROOM_TTL_MS && Number(process.env.ROOM_TTL_MS) !== ROOM_TTL_MS) {
  console.error('❌  ROOM_TTL_MS doit rester fixé à 86400000 (24 heures).');
  process.exit(1);
}

const supabase = buildSupabaseClient({ url: SUPABASE_URL, secretKey: SUPABASE_SECRET_KEY });

function parseAllowedOrigins(value) {
  const rawOrigins = String(value || '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (rawOrigins.length > 10 || rawOrigins.some((origin) => origin.length > 2048)) {
    throw new Error('CLIENT_ORIGINS invalide.');
  }
  const origins = rawOrigins.map((origin) => normalizeOrigin(origin, { production: isProduction }));
  if (origins.some((origin) => !origin)) throw new Error('CLIENT_ORIGINS contient une origine invalide.');
  return new Set(origins);
}

let configuredOrigins;
try {
  configuredOrigins = parseAllowedOrigins(process.env.CLIENT_ORIGINS);
} catch {
  console.error('❌  CLIENT_ORIGINS doit contenir uniquement des origines exactes valides.');
  process.exit(1);
}

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
  const normalized = normalizeOrigin(origin, { production: isProduction });
  return Boolean(normalized && (configuredOrigins.has(normalized) || isPrivateDevOrigin(normalized)));
}

function cookieSite(origin) {
  try {
    const labels = new URL(origin).hostname.toLowerCase().split('.');
    return labels.length >= 2 ? labels.slice(-2).join('.') : labels[0];
  } catch {
    return '';
  }
}

if (isProduction) {
  const serverSite = cookieSite(PUBLIC_SERVER_URL);
  const incompatibleOrigin = [...configuredOrigins].find((origin) => cookieSite(origin) !== serverSite);
  if (!serverSite || incompatibleOrigin) {
    console.error('❌  PUBLIC_SERVER_URL et CLIENT_ORIGINS doivent partager le même site pour les cookies SameSite=Strict.');
    process.exit(1);
  }
}

function corsOrigin(origin, callback) {
  const allowed = isAllowedOrigin(origin);
  callback(allowed ? null : new PublicError('origin_denied', 'Origine non autorisée.', 403), allowed);
}

function socketIp(socket) {
  return clientIpFromForwarded(
    socket.handshake.headers['x-forwarded-for'],
    socket.handshake.address || socket.conn.remoteAddress,
  );
}

const rooms = new Map();
const roomMeta = new Map();
const roomQueues = new Map();
const socketToPlayer = new Map();
const disconnectTimers = new Map();
const nextRoundTimers = new Map();
const defensePromptTimers = new Map();
const rateBuckets = new Map();

function redactInternalLogValue(value, maxLength = 500) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email-redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/gu, '[jwt-redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, '[token-redacted]')
    .slice(0, maxLength);
}

function internalErrorPayload(error) {
  if (error instanceof Error) {
    return {
      message: redactInternalLogValue(error.message || error.name),
      ...(error.cause ? { cause: redactInternalLogValue(error.cause, 300) } : {}),
    };
  }
  if (error && typeof error === 'object') {
    const message = error.message || error.error_description || error.details || error.code;
    let fallback = '';
    if (!message) {
      try { fallback = JSON.stringify(error); }
      catch { fallback = Object.prototype.toString.call(error); }
    }
    return {
      message: redactInternalLogValue(message || fallback || 'Erreur structurée sans message'),
      ...(error.code ? { code: redactInternalLogValue(error.code, 100) } : {}),
      ...(error.details && error.details !== message
        ? { details: redactInternalLogValue(error.details, 500) }
        : {}),
      ...(error.hint ? { hint: redactInternalLogValue(error.hint, 300) } : {}),
      ...(Number.isFinite(Number(error.status)) ? { status: Number(error.status) } : {}),
    };
  }
  return { message: redactInternalLogValue(error || 'Erreur inconnue') };
}

function logInternal(label, error, correlationId = requestId()) {
  console.error(JSON.stringify({
    level: 'error',
    label,
    correlationId,
    ...internalErrorPayload(error),
  }));
  return correlationId;
}

function consumeRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldest = rateBuckets.keys().next().value;
      if (oldest) rateBuckets.delete(oldest);
    }
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

function cleanupRateBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}

async function hasCurrentConsent(userId) {
  const { data, error } = await supabase.from('account_consents')
    .select('terms_version, privacy_version')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.terms_version === CONSENT_VERSION && data?.privacy_version === CONSENT_VERSION;
}

function httpRateLimit({ limit, windowMs, keyPrefix, user = false }) {
  return (req, res, next) => {
    const identity = user
      ? req.auth?.user?.id
      : clientIpFromForwarded(req.headers['x-forwarded-for'], req.socket.remoteAddress);
    const result = consumeRateLimit(`${keyPrefix}:${identity || 'unknown'}`, { limit, windowMs });
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      res.status(429).json({ error: { code: 'rate_limited', message: 'Trop de requêtes. Réessayez plus tard.' } });
      return;
    }
    next();
  };
}

async function requireConsent(req, res, next) {
  try {
    if (!await hasCurrentConsent(req.auth.user.id)) {
      throw new PublicError('consent_required', 'Les conditions doivent être acceptées avant de jouer.', 403);
    }
    next();
  } catch (error) {
    const payload = publicErrorPayload(error);
    res.status(payload.status).json(payload.body);
  }
}

function roomPlayerCount(state) {
  return state.order.filter((id) => state.playersById[id]).length;
}

function roomMetadata(state, ownerUserId) {
  const creator = state.playersById[state.creatorId] || state.playersById[state.order[0]];
  return {
    p_schema_version: ROOM_SCHEMA_VERSION,
    p_owner_user_id: ownerUserId || null,
    p_visibility: state.roomVisibility === 'public' ? 'public' : 'private',
    p_phase: String(state.phase || 'lobby').slice(0, 32),
    p_game_mode: String(state.gameMode || 'classic').slice(0, 32),
    p_player_count: roomPlayerCount(state),
    p_creator_name: normalizePlayerName(creator?.name) || '',
  };
}

async function commitRoomState(state, expectedRevision, { member = null, removePlayerId = null } = {}) {
  const meta = roomMeta.get(state.roomId) || {};
  state.schemaVersion = ROOM_SCHEMA_VERSION;
  state.updatedAt = Date.now();
  if (!isValidRoomState(state, state.roomId)) throw new Error('invalid_room_state');
  const serializedSize = Buffer.byteLength(JSON.stringify(state));
  if (serializedSize > 2 * 1024 * 1024) throw new Error('room_state_too_large');

  const { data, error } = await supabase.rpc('commit_skyjo_room', {
    p_room_id: state.roomId,
    p_state_json: state,
    p_expected_revision: expectedRevision,
    ...roomMetadata(state, meta.ownerUserId),
    p_member_user_id: member?.userId || null,
    p_member_player_id: member?.playerId || null,
    p_remove_member_player_id: removePlayerId || null,
  });
  if (error) {
    if (error.code === '40001' || String(error.message).includes('room_revision_conflict')) {
      throw new PublicError('room_conflict', 'La salle a changé. Réessayez.', 409);
    }
    throw error;
  }
  const revision = Number(data);
  roomMeta.set(state.roomId, { ...meta, revision, ownerUserId: meta.ownerUserId || null });
  return revision;
}

async function loadRoom(roomId) {
  const { data, error } = await supabase.from('rooms')
    .select('state_json, updated_at, owner_user_id, state_revision, state_schema_version, quarantined_at')
    .eq('room_id', roomId).maybeSingle();
  if (error) throw error;
  if (!data || data.quarantined_at) return null;
  if (Date.parse(data.updated_at) <= Date.now() - ROOM_TTL_MS) {
    await supabase.from('rooms').delete().eq('room_id', roomId).lt('updated_at', new Date(Date.now() - ROOM_TTL_MS).toISOString());
    return null;
  }
  const state = structuredClone(data.state_json);
  state.roomId = roomId;
  state.updatedAt = Date.parse(data.updated_at);
  if (Number(data.state_schema_version) !== ROOM_SCHEMA_VERSION || !isValidRoomState(state, roomId)) {
    const { error: quarantineError } = await supabase.from('rooms').update({
      quarantined_at: new Date().toISOString(),
      quarantine_reason: 'invalid_or_unknown_state_schema',
    }).eq('room_id', roomId);
    if (quarantineError) throw quarantineError;
    return null;
  }
  roomMeta.set(roomId, {
    revision: Number(data.state_revision || 0),
    ownerUserId: data.owner_user_id || null,
  });
  rooms.set(roomId, state);
  return state;
}

async function getOrLoadRoom(roomId) {
  const cached = rooms.get(roomId);
  if (cached) return cached;
  return loadRoom(roomId);
}

function enqueueRoom(roomId, task) {
  const previous = roomQueues.get(roomId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  roomQueues.set(roomId, current);
  current.finally(() => {
    if (roomQueues.get(roomId) === current) roomQueues.delete(roomId);
  }).catch(() => {});
  return current;
}

async function mutateRoom(roomId, mutation, options = {}) {
  return enqueueRoom(roomId, async () => {
    const current = await getOrLoadRoom(roomId);
    if (!current) throw new PublicError('room_unavailable', 'Impossible de rejoindre cette salle.', 404);
    const draft = structuredClone(current);
    const originalMeta = { ...(roomMeta.get(roomId) || {}) };
    const result = await mutation(draft);
    try {
      await commitRoomState(draft, originalMeta.revision ?? 0, options);
    } catch (error) {
      roomMeta.set(roomId, originalMeta);
      throw error;
    }
    rooms.set(roomId, draft);
    return { state: draft, result };
  });
}

async function findMemberByUser(roomId, userId) {
  const { data, error } = await supabase.from('room_members')
    .select('player_id, user_id').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findMemberByPlayer(roomId, playerId) {
  const { data, error } = await supabase.from('room_members')
    .select('player_id, user_id').eq('room_id', roomId).eq('player_id', playerId).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function createRoom({ ownerUserId, playerName, roomVisibility }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const roomId = generateRoomId();
    const playerId = nanoid(12);
    const state = newRoomState(roomId);
    state.schemaVersion = ROOM_SCHEMA_VERSION;
    state.roomVisibility = roomVisibility === 'public' ? 'public' : 'private';
    addPlayer(state, playerId, playerName);
    state.playersById[playerId].connected = false;
    roomMeta.set(roomId, { revision: -1, ownerUserId });
    try {
      await commitRoomState(state, -1, { member: { userId: ownerUserId, playerId } });
      rooms.set(roomId, state);
      return { state, playerId };
    } catch (error) {
      roomMeta.delete(roomId);
      if (error?.code === '23505' || String(error?.message).includes('duplicate')) continue;
      throw error;
    }
  }
  throw new Error('room_id_generation_failed');
}

async function listPublicRooms() {
  const { data, error } = await supabase.from('rooms')
    .select('room_id, player_count, creator_name, game_mode, updated_at')
    .eq('visibility', 'public').eq('phase', 'lobby')
    .is('quarantined_at', null)
    .gt('player_count', 0).lt('player_count', MAX_PLAYERS_PER_ROOM)
    .gt('updated_at', new Date(Date.now() - ROOM_TTL_MS).toISOString())
    .order('updated_at', { ascending: false }).limit(30);
  if (error) throw error;
  return (data || []).map((row) => ({
    roomId: row.room_id, playerCount: row.player_count, maxPlayers: MAX_PLAYERS_PER_ROOM,
    creatorName: normalizePlayerName(row.creator_name) || 'Salle publique',
    gameMode: row.game_mode === 'action' ? 'action' : 'classic',
    updatedAt: Date.parse(row.updated_at),
  }));
}

function connectionKey(roomId, playerId) { return `${roomId}:${playerId}`; }

function clearDisconnectTimer(roomId, playerId) {
  const key = connectionKey(roomId, playerId);
  const timer = disconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  disconnectTimers.delete(key);
}

function socketIdsForPlayer(roomId, playerId) {
  return [...socketToPlayer].filter(([, info]) => info.roomId === roomId && info.playerId === playerId).map(([id]) => id);
}

async function attachSocket(socket, roomId, playerId, playerName) {
  clearDisconnectTimer(roomId, playerId);
  const previous = socketToPlayer.get(socket.id);
  if (previous && (previous.roomId !== roomId || previous.playerId !== playerId)) {
    socket.leave(previous.roomId);
    socketToPlayer.delete(socket.id);
  }
  socketToPlayer.set(socket.id, { roomId, playerId });
  socket.join(roomId);
  const { state } = await mutateRoom(roomId, (draft) => {
    const player = draft.playersById[playerId];
    if (!player) throw new PublicError('seat_unavailable', 'Impossible de rejoindre cette salle.', 409);
    player.connected = true;
    if (playerName) player.name = playerName;
  });
  socket.emit('joined', { roomId, playerId });
  await sendChatHistory(socket, null);
  broadcastRoom(roomId);
  scheduleNextRound(roomId, state);
  scheduleDefensePrompt(roomId, state);
}

async function attachExistingMember(socket, roomId, playerName = '') {
  if (!roomId) return null;
  const state = await getOrLoadRoom(roomId);
  if (!state) return null;
  const member = await findMemberByUser(roomId, socket.data.auth.user.id);
  if (!member) return null;
  if (!state.playersById[member.player_id]) return null;
  await attachSocket(socket, roomId, member.player_id, playerName);
  return member;
}

async function ensureSocketSession(socket, { force = false } = {}) {
  const current = socket.data.auth;
  if (!current) return false;
  if (!force && socket.data.sessionCheckedAt > Date.now() - SESSION_CHECK_CACHE_MS) return true;
  try {
    const auth = await authBff.sessionFromCookieHeader(socket.handshake.headers.cookie);
    if (!auth || auth.user.id !== current.user.id) return false;
    socket.data.auth = auth;
    socket.data.sessionCheckedAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

function scheduleSocketExpiry(socket) {
  if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
  socket.data.expiryTimer = setTimeout(async () => {
    if (await ensureSocketSession(socket, { force: true })) {
      scheduleSocketExpiry(socket);
      return;
    }
    socket.emit('errorMsg', { code: 'invalid_session', message: 'Session invalide ou expirée.' });
    socket.disconnect(true);
  }, SESSION_CHECK_CACHE_MS);
  socket.data.expiryTimer.unref?.();
}

function checkSocketRateLimit(socket, eventName) {
  const userId = socket.data.auth?.user?.id || 'anonymous';
  const ip = socketIp(socket);
  const checks = [
    consumeRateLimit(`event:socket:${socket.id}`, { limit: 60, windowMs: 10_000 }),
    consumeRateLimit(`event:user:${userId}`, { limit: 120, windowMs: 10_000 }),
    consumeRateLimit(`event:ip:${ip}`, { limit: 240, windowMs: 10_000 }),
  ];
  if (eventName === 'sendChatMessage') {
    checks.push(consumeRateLimit(`chat:user:${userId}`, { limit: 8, windowMs: 60_000 }));
    const info = socketToPlayer.get(socket.id);
    if (info) checks.push(consumeRateLimit(`chat:room:${info.roomId}`, { limit: 40, windowMs: 60_000 }));
  }
  const denied = checks.find((result) => !result.allowed);
  if (denied) socket.emit('errorMsg', {
    code: 'rate_limited',
    message: 'Trop de requêtes. Réessayez plus tard.',
    retryAfter: denied.retryAfter,
  });
  return !denied;
}

function withSocketGuard(socket, eventName, handler) {
  return async (...args) => {
    await socket.data.attachPromise;
    if (!checkSocketRateLimit(socket, eventName)) return;
    if (!await ensureSocketSession(socket)) {
      socket.emit('errorMsg', { code: 'invalid_session', message: 'Session invalide ou expirée.' });
      socket.disconnect(true);
      return;
    }
    try {
      await handler(...args);
    } catch (error) {
      const correlationId = error instanceof PublicError ? null : logInternal(`socket:${eventName}`, error);
      socket.emit('errorMsg', error instanceof PublicError
        ? { code: error.code, message: error.message }
        : { code: 'internal_error', message: 'Action impossible.', requestId: correlationId });
    }
  };
}

function actionPayload(value) {
  const payload = objectPayload(value, [
    'draft', 'targetPlayerId', 'slotIndex', 'actionCardId', 'slots',
    'choiceIndex', 'revealSlot', 'firstSlotIndex', 'secondSlotIndex',
    'groupType', 'cardId', 'first', 'second',
  ]);
  if (!payload.draft) return payload;
  const draft = objectPayload(payload.draft, [
    'slots', 'choiceIndex', 'peekFirst', 'targets', 'stealTargetId', 'targetPlayerId',
  ]);
  if (draft.peekFirst) objectPayload(draft.peekFirst, ['playerId', 'slotIndex']);
  return { ...payload, draft };
}

function broadcastRoom(roomId) {
  const state = rooms.get(roomId);
  if (!state) return;
  for (const [socketId, info] of socketToPlayer) {
    if (info.roomId !== roomId || !state.playersById[info.playerId]) continue;
    io.to(socketId).emit('state', publicState(state, info.playerId));
  }
}

async function handleAction(socket, fn) {
  const info = socketToPlayer.get(socket.id);
  if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
  const { state } = await mutateRoom(info.roomId, (draft) => {
    try {
      return fn(draft, info.playerId);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      const message = error instanceof TypeError
        ? 'Action invalide.'
        : String(error?.message || 'Action invalide.');
      throw new PublicError(
        'invalid_action',
        message.length <= 180 ? message : 'Action invalide.',
        400,
      );
    }
  });
  broadcastRoom(info.roomId);
  scheduleNextRound(info.roomId, state);
  scheduleDefensePrompt(info.roomId, state);
}

function clearRoomTimers(roomId) {
  for (const timers of [nextRoundTimers, defensePromptTimers]) {
    const timer = timers.get(roomId);
    if (timer) clearTimeout(timer);
    timers.delete(roomId);
  }
  for (const [key, timer] of disconnectTimers) {
    if (!key.startsWith(`${roomId}:`)) continue;
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

function scheduleNextRound(roomId, state) {
  const existing = nextRoundTimers.get(roomId);
  if (existing) clearTimeout(existing);
  nextRoundTimers.delete(roomId);
  if (state.phase !== 'roundEnd' || !state.nextRoundAt) return;
  const timer = setTimeout(async () => {
    nextRoundTimers.delete(roomId);
    try {
      const { state: latest } = await mutateRoom(roomId, (draft) => {
        if (draft.phase !== 'roundEnd' || (draft.nextRoundAt && draft.nextRoundAt > Date.now())) return;
        nextRound(draft);
      });
      broadcastRoom(roomId);
      scheduleDefensePrompt(roomId, latest);
    } catch (error) { logInternal('next_round', error); }
  }, Math.max(0, state.nextRoundAt - Date.now()));
  timer.unref?.();
  nextRoundTimers.set(roomId, timer);
}

function scheduleDefensePrompt(roomId, state) {
  const existing = defensePromptTimers.get(roomId);
  if (existing) clearTimeout(existing);
  defensePromptTimers.delete(roomId);
  const prompt = state.pendingAction?.defensePrompt;
  if (!prompt?.expiresAt) return;
  const timer = setTimeout(async () => {
    defensePromptTimers.delete(roomId);
    try {
      const { state: latest } = await mutateRoom(roomId, (draft) => {
        if (draft.pendingAction?.defensePrompt?.id === prompt.id) expireDefensePrompt(draft);
      });
      broadcastRoom(roomId);
      scheduleNextRound(roomId, latest);
      scheduleDefensePrompt(roomId, latest);
    } catch (error) { logInternal('defense_timeout', error); }
  }, Math.max(0, prompt.expiresAt - Date.now()));
  timer.unref?.();
  defensePromptTimers.set(roomId, timer);
}

function mapMessage(row) {
  return {
    id: row.message_id, t: Date.parse(row.sent_at), playerId: row.player_id,
    playerName: row.player_name, text: row.body,
  };
}

function encodeChatCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ t: Date.parse(row.sent_at), id: row.message_id }), 'utf8').toString('base64url');
}

function decodeChatCursor(value) {
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(String(value || ''))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(parsed?.t) || parsed.t <= 0 || !/^[A-Za-z0-9_-]{10,80}$/.test(parsed?.id || '')) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function sendChatHistory(socket, before) {
  const info = socketToPlayer.get(socket.id);
  if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
  let query = supabase.from('room_messages')
    .select('message_id, player_id, player_name, body, sent_at')
    .eq('room_id', info.roomId).order('sent_at', { ascending: false })
    .order('message_id', { ascending: false }).limit(CHAT_PAGE_SIZE + 1);
  if (before) {
    const cursor = decodeChatCursor(before);
    if (!cursor) throw new PublicError('invalid_cursor', 'Curseur de chat invalide.', 400);
    const timestamp = new Date(cursor.t).toISOString();
    query = query.or(`sent_at.lt.${timestamp},and(sent_at.eq.${timestamp},message_id.lt.${cursor.id})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []).slice(0, CHAT_PAGE_SIZE);
  const messages = rows.map(mapMessage).reverse();
  socket.emit('chatHistory', {
    messages,
    hasMore: (data || []).length > CHAT_PAGE_SIZE,
    before: encodeChatCursor(rows.at(-1)),
  });
}

async function appendChatMessage(socket, value) {
  const info = socketToPlayer.get(socket.id);
  if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
  const text = normalizeChatMessage(value);
  if (!text) throw new PublicError('invalid_message', 'Message vide ou trop long.', 400);
  const state = await getOrLoadRoom(info.roomId);
  const player = state?.playersById[info.playerId];
  if (!player) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
  const messageId = nanoid(18);
  const { data, error } = await supabase.rpc('append_skyjo_message', {
    p_room_id: info.roomId, p_message_id: messageId, p_player_id: info.playerId,
    p_player_name: normalizePlayerName(player.name), p_body: text,
    p_sent_at: new Date().toISOString(),
  });
  if (error || !data?.[0]) throw error || new Error('message_not_persisted');
  state.updatedAt = Date.now();
  io.to(info.roomId).emit('chatMessage', mapMessage(data[0]));
}

async function cleanupStaleRooms() {
  const { error } = await supabase.rpc('delete_stale_skyjo_rooms');
  if (error) throw error;
  const { error: sessionCleanupError } = await supabase.rpc('delete_expired_skyjo_app_sessions');
  if (sessionCleanupError) throw sessionCleanupError;
  for (const [roomId, state] of rooms) {
    if ((state.updatedAt || Date.now()) > Date.now() - ROOM_TTL_MS) continue;
    rooms.delete(roomId);
    roomMeta.delete(roomId);
    clearRoomTimers(roomId);
    for (const [socketId, info] of socketToPlayer) {
      if (info.roomId !== roomId) continue;
      io.to(socketId).emit('roomExpired');
      io.sockets.sockets.get(socketId)?.leave(roomId);
      socketToPlayer.delete(socketId);
    }
  }
}

const authBff = createAuthBff({
  supabaseUrl: SUPABASE_URL,
  publishableKey: SUPABASE_PUBLISHABLE_KEY,
  serviceClient: supabase,
  encryptionKey: AUTH_SESSION_ENCRYPTION_KEY,
  production: isProduction,
  isAllowedOrigin,
  publicServerUrl: PUBLIC_SERVER_URL,
  turnstileSecret: TURNSTILE_SECRET_KEY,
  logInternal,
  rateLimit: (keyPrefix, limit, windowMs) => httpRateLimit({ keyPrefix, limit, windowMs }),
});
const requireHttpAuth = authBff.requireAuth;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.disable('etag');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({
  origin: corsOrigin, methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CSRF-Token'], credentials: true, maxAge: 600,
}));
app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));
app.use(httpRateLimit({ keyPrefix: 'preauth', limit: 120, windowMs: 60_000 }));

app.get('/health', (req, res) => res.json({ ok: true, clientProtocolVersion: CLIENT_PROTOCOL_VERSION }));
app.use('/api/auth', authBff.router);

app.get('/api/account/consent', requireHttpAuth, authBff.requireStandardSession, async (req, res, next) => {
  try { res.json({ accepted: await hasCurrentConsent(req.auth.user.id), version: CONSENT_VERSION }); }
  catch (error) { next(error); }
});

app.post('/api/account/consent', requireHttpAuth, authBff.requireStandardSession, authBff.requireCsrf, httpRateLimit({ keyPrefix: 'consent', limit: 5, windowMs: 60_000, user: true }), async (req, res, next) => {
  try {
    const payload = objectPayload(req.body, ['termsVersion', 'privacyVersion']);
    if (payload.termsVersion !== CONSENT_VERSION || payload.privacyVersion !== CONSENT_VERSION) {
      throw new PublicError('invalid_consent', 'Version de consentement invalide.', 400);
    }
    const provider = String(req.auth.user.app_metadata?.provider || 'unknown').slice(0, 32);
    const { error } = await supabase.from('account_consents').upsert({
      user_id: req.auth.user.id, terms_version: CONSENT_VERSION,
      privacy_version: CONSENT_VERSION, accepted_at: new Date().toISOString(), provider,
    }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ accepted: true, version: CONSENT_VERSION });
  } catch (error) { next(error); }
});

app.post('/api/rooms', requireHttpAuth, authBff.requireStandardSession, authBff.requireCsrf, requireConsent,
  httpRateLimit({ keyPrefix: 'create-room', limit: 5, windowMs: 60_000, user: true }),
  async (req, res, next) => {
    try {
      const payload = objectPayload(req.body, ['playerName', 'roomVisibility']);
      const playerName = normalizePlayerName(payload.playerName);
      if (!playerName) throw new PublicError('invalid_player_name', 'Choisissez un nom de joueur.', 400);
      const { state, playerId } = await createRoom({
        ownerUserId: req.auth.user.id, playerName,
        roomVisibility: payload.roomVisibility === 'public' ? 'public' : 'private',
      });
      res.status(201).json({ roomId: state.roomId, playerId });
    } catch (error) { next(error); }
  });

app.get('/api/rooms/public', requireHttpAuth, authBff.requireStandardSession, requireConsent,
  httpRateLimit({ keyPrefix: 'list-public-rooms', limit: 60, windowMs: 60_000, user: true }),
  async (req, res, next) => {
    try { res.json({ rooms: await listPublicRooms() }); }
    catch (error) { next(error); }
  });

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Ressource introuvable.' } }));
app.use((error, req, res, next) => {
  void next;
  const id = requestId();
  const normalized = error instanceof SyntaxError && 'body' in error
    ? new PublicError('invalid_json', 'Corps JSON invalide.', 400)
    : error;
  if (!(normalized instanceof PublicError)) logInternal('http', normalized, id);
  const payload = publicErrorPayload(normalized, id);
  res.status(payload.status).json(payload.body);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
  allowRequest: (req, callback) => callback(
    null,
    Boolean((!isProduction || req.headers.origin) && isAllowedOrigin(req.headers.origin)),
  ),
  maxHttpBufferSize: 20_000,
});

io.use(async (socket, next) => {
  try {
    const handshake = objectPayload(socket.handshake.auth || {}, [
      'protocolVersion', 'roomId', 'playerName',
    ]);
    if (Number(handshake.protocolVersion) !== CLIENT_PROTOCOL_VERSION) {
      return next(new Error('Mise à jour du client requise.'));
    }
    const ip = socketIp(socket);
    if (!consumeRateLimit(`handshake:${ip}`, { limit: 20, windowMs: 60_000 }).allowed) {
      return next(new Error('Trop de connexions. Réessayez plus tard.'));
    }
    const auth = await authBff.sessionFromCookieHeader(socket.handshake.headers.cookie);
    if (!auth) return next(new Error('Session invalide ou expirée.'));
    if (auth.authContext === 'recovery') return next(new Error('Choisissez un nouveau mot de passe avant de jouer.'));
    if (!await hasCurrentConsent(auth.user.id)) return next(new Error('Consentement requis.'));
    const activeSockets = [...io.sockets.sockets.values()].filter((candidate) => candidate.data.auth?.user?.id === auth.user.id).length;
    if (activeSockets >= MAX_SOCKETS_PER_USER) return next(new Error('Trop de connexions simultanées.'));
    socket.data.auth = auth;
    socket.data.sessionCheckedAt = Date.now();
    return next();
  } catch (error) {
    logInternal('socket_handshake', error);
    return next(new Error('Impossible de vérifier la session.'));
  }
});

io.on('connection', (socket) => {
  scheduleSocketExpiry(socket);
  const initialRoomId = normalizeRoomId(socket.handshake.auth?.roomId);
  socket.data.attachPromise = attachExistingMember(
    socket,
    initialRoomId,
    normalizePlayerName(socket.handshake.auth?.playerName),
  ).then((member) => {
    if (initialRoomId && !member) {
      socket.emit('errorMsg', {
        code: 'room_unavailable',
        message: 'Cette salle n\'est plus disponible.',
      });
    }
    return member;
  }).catch((error) => {
    logInternal('socket_auto_attach', error);
    socket.emit('errorMsg', {
      code: 'reconnect_failed',
      message: 'Impossible de retrouver cette salle pour le moment.',
    });
    return null;
  });

  socket.on('joinRoom', withSocketGuard(socket, 'joinRoom', async (payload = {}) => {
    const data = objectPayload(payload, ['roomId', 'playerName']);
    const roomId = normalizeRoomId(data.roomId);
    const playerName = normalizePlayerName(data.playerName);
    if (!roomId || !playerName) throw new PublicError('invalid_join', 'Impossible de rejoindre cette salle.', 400);
    let state = await getOrLoadRoom(roomId);
    if (!state) {
      const userLimit = consumeRateLimit(`join-failure:user:${socket.data.auth.user.id}`, { limit: 5, windowMs: 600_000 });
      const ipLimit = consumeRateLimit(`join-failure:ip:${socketIp(socket)}`, { limit: 20, windowMs: 600_000 });
      if (!userLimit.allowed || !ipLimit.allowed) {
        throw new PublicError('rate_limited', 'Trop de tentatives. Réessayez plus tard.', 429);
      }
      throw new PublicError('room_unavailable', 'Impossible de rejoindre cette salle.', 404);
    }
    let member = await findMemberByUser(roomId, socket.data.auth.user.id);
    if (!member) {
      const playerId = nanoid(12);
      try {
        const result = await mutateRoom(roomId, (draft) => {
          if (draft.phase !== 'lobby') throw new PublicError('room_unavailable', 'Impossible de rejoindre cette salle.', 409);
          addPlayer(draft, playerId, playerName);
        }, { member: { userId: socket.data.auth.user.id, playerId } });
        state = result.state;
        member = { player_id: playerId, user_id: socket.data.auth.user.id };
      } catch (error) {
        if (error?.code !== '23505' && !String(error?.message || '').includes('duplicate')) throw error;
        member = await findMemberByUser(roomId, socket.data.auth.user.id);
        state = await getOrLoadRoom(roomId);
        if (!member || !state) throw error;
      }
    }
    if (!state.playersById[member.player_id]) throw new PublicError('seat_unavailable', 'Impossible de rejoindre cette salle.', 409);
    await attachSocket(socket, roomId, member.player_id, playerName);
  }));

  socket.on('leaveRoom', withSocketGuard(socket, 'leaveRoom', async (acknowledge) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) { if (typeof acknowledge === 'function') acknowledge({ ok: true }); return; }
    const allSocketIds = socketIdsForPlayer(info.roomId, info.playerId);
    const { state } = await mutateRoom(info.roomId, async (draft) => {
      leavePlayer(draft, info.playerId);
      if (draft.creatorId) {
        const nextOwner = await findMemberByPlayer(info.roomId, draft.creatorId);
        if (nextOwner) roomMeta.get(info.roomId).ownerUserId = nextOwner.user_id;
      }
    }, { removePlayerId: info.playerId });
    for (const socketId of allSocketIds) {
      socketToPlayer.delete(socketId);
      io.sockets.sockets.get(socketId)?.leave(info.roomId);
    }
    broadcastRoom(info.roomId);
    scheduleNextRound(info.roomId, state);
    scheduleDefensePrompt(info.roomId, state);
    if (typeof acknowledge === 'function') acknowledge({ ok: true });
  }));

  socket.on('startGame', withSocketGuard(socket, 'startGame', () => handleAction(socket, startGame)));
  socket.on('setGameMode', withSocketGuard(socket, 'setGameMode', (payload) => handleAction(socket, (s, p) => setGameMode(s, p, objectPayload(payload, ['gameMode']).gameMode))));
  socket.on('flipInitial', withSocketGuard(socket, 'flipInitial', (payload) => handleAction(socket, (s, p) => flipInitialCard(s, p, objectPayload(payload, ['slotIndex']).slotIndex))));
  socket.on('drawCard', withSocketGuard(socket, 'drawCard', (payload) => handleAction(socket, (s, p) => drawCard(s, p, objectPayload(payload, ['source']).source))));
  socket.on('decideDrawn', withSocketGuard(socket, 'decideDrawn', (payload) => handleAction(socket, (s, p) => decideDrawnCard(s, p, objectPayload(payload, ['keep']).keep))));
  socket.on('keepDrawnAndPlace', withSocketGuard(socket, 'keepDrawnAndPlace', (payload) => handleAction(socket, (s, p) => keepDrawnAndPlace(s, p, objectPayload(payload, ['slotIndex']).slotIndex))));
  socket.on('placeCard', withSocketGuard(socket, 'placeCard', (payload) => handleAction(socket, (s, p) => placeDrawnCard(s, p, objectPayload(payload, ['slotIndex']).slotIndex))));
  socket.on('revealCard', withSocketGuard(socket, 'revealCard', (payload) => handleAction(socket, (s, p) => revealHiddenCard(s, p, objectPayload(payload, ['slotIndex']).slotIndex))));
  socket.on('playActionCard', withSocketGuard(socket, 'playActionCard', (payload) => handleAction(socket, (s, p) => playOwnedAction(s, p, objectPayload(payload, ['cardId']).cardId))));
  socket.on('discardActionCard', withSocketGuard(socket, 'discardActionCard', (payload) => handleAction(socket, (s, p) => discardOwnedAction(s, p, objectPayload(payload, ['cardId']).cardId))));
  socket.on('resolveAction', withSocketGuard(socket, 'resolveAction', (payload) => handleAction(socket, (s, p) => resolveActionInput(s, p, actionPayload(payload)))));
  socket.on('resolveDefense', withSocketGuard(socket, 'resolveDefense', (payload) => handleAction(socket, (s, p) => resolveDefensePrompt(s, p, objectPayload(payload, ['useDefense']).useDefense))));
  socket.on('resolveGroupChoice', withSocketGuard(socket, 'resolveGroupChoice', (payload) => handleAction(socket, (s, p) => resolveGroupChoice(s, p, objectPayload(payload, ['remove']).remove))));
  socket.on('claimStarAction', withSocketGuard(socket, 'claimStarAction', (payload) => {
    const data = objectPayload(payload, ['source', 'marketIndex']);
    return handleAction(socket, (s, p) => claimStarAction(s, p, data.source, data.marketIndex));
  }));
  socket.on('sendChatMessage', withSocketGuard(socket, 'sendChatMessage', (payload) => appendChatMessage(socket, objectPayload(payload, ['text']).text)));
  socket.on('loadChatHistory', withSocketGuard(socket, 'loadChatHistory', (payload) => sendChatHistory(socket, objectPayload(payload, ['before']).before)));

  socket.on('disconnect', () => {
    if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
    const info = socketToPlayer.get(socket.id);
    socketToPlayer.delete(socket.id);
    if (!info || socketIdsForPlayer(info.roomId, info.playerId).length) return;
    const key = connectionKey(info.roomId, info.playerId);
    clearDisconnectTimer(info.roomId, info.playerId);
    const timer = setTimeout(async () => {
      disconnectTimers.delete(key);
      if (socketIdsForPlayer(info.roomId, info.playerId).length) return;
      try {
        const { state } = await mutateRoom(info.roomId, async (draft) => {
          leavePlayer(draft, info.playerId);
          if (draft.creatorId) {
            const nextOwner = await findMemberByPlayer(info.roomId, draft.creatorId);
            if (nextOwner) roomMeta.get(info.roomId).ownerUserId = nextOwner.user_id;
          }
        }, { removePlayerId: info.playerId });
        broadcastRoom(info.roomId);
        scheduleNextRound(info.roomId, state);
        scheduleDefensePrompt(info.roomId, state);
      } catch (error) { logInternal('disconnect_cleanup', error); }
    }, DISCONNECT_GRACE_MS);
    timer.unref?.();
    disconnectTimers.set(key, timer);
  });
});

server.on('error', (error) => {
  logInternal('server', error);
  process.exitCode = 1;
});

const cleanupInterval = setInterval(() => {
  cleanupRateBuckets();
  cleanupStaleRooms().catch((error) => logInternal('cleanup', error));
}, 60 * 60 * 1000);
cleanupInterval.unref?.();

export { app, server, io };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cleanupStaleRooms().catch((error) => logInternal('initial_cleanup', error));
  server.listen(PORT, HOST, () => {
    console.log(`Skyjo server v${CLIENT_PROTOCOL_VERSION} listening on ${HOST}:${PORT}`);
  });
}
