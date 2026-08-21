import express from 'express';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import cors from 'cors';
import { customAlphabet, nanoid } from 'nanoid';
import { buildSupabaseClient } from './bootstrap.js';
import { createAuthBff } from './authBff.js';
import {
  SOCKET_ACTION_DRAFT_KEYS,
  SOCKET_EVENTS,
  SOCKET_HANDSHAKE_KEYS,
  SOCKET_PEEK_FIRST_KEYS,
  SOCKET_PROTOCOL_VERSION,
  socketServerPayload,
  socketPayloadKeys,
} from '../shared/socketProtocol.js';
import {
  newRoomState, addPlayer, leavePlayer, removePlayer, removeLobbyPlayer, startGame, flipInitialCard,
  drawCard, decideDrawnCard, keepDrawnAndPlace, placeDrawnCard, revealHiddenCard, nextRound,
  publicPreviewState, publicState, setGameMode, returnToLobby, playOwnedAction, resolveActionInput, claimStarAction,
  discardOwnedAction, resolveDefensePrompt, expireDefensePrompt,
  resolveGroupChoice, assertActionCardIntegrity, MAX_PLAYERS_PER_ROOM,
  banRoomPlayer, isUserBanned, kickRoomPlayer, setRoomSettings, transferRoomOwnership,
} from './game.js';
import {
  PRIVACY_CONSENT_VERSION, ROOM_SCHEMA_VERSION, ROOM_TTL_MS,
  TERMS_CONSENT_VERSION,
  PublicError, clientIpFromForwarded,
  isValidRoomState, normalizeChatMessage, normalizeOrigin,
  normalizePlayerName, normalizeRoomId, objectPayload, publicErrorPayload, requestId,
} from './security.js';
import { effectiveRoomVariantSettings } from '../shared/roomVariants.js';

const DEFAULT_PORT = 4000;
const MAX_RATE_BUCKETS = 20_000;
const MAX_SOCKETS_PER_USER = 3;
const MAX_SPECTATORS_PER_ROOM = 50;
const CHAT_PAGE_SIZE = 80;
// Public rooms release abandoned seats quickly; private rooms preserve them
// until players explicitly leave so a game can be resumed much later.
const PUBLIC_ROOM_DISCONNECT_GRACE_MS = 30 * 1000;
const SYSTEM_CHAT_PLAYER_ID = '__system__';
const SYSTEM_CHAT_PLAYER_NAME = 'Système';
const SESSION_CHECK_CACHE_MS = 30_000;
const generateRoomId = customAlphabet('0123456789', 6);
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

async function currentConsentStatus(userId) {
  const { data, error } = await supabase.from('account_consents')
    .select('terms_version, privacy_version')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const termsAccepted = data?.terms_version === TERMS_CONSENT_VERSION;
  const privacyAccepted = data?.privacy_version === PRIVACY_CONSENT_VERSION;
  return {
    accepted: termsAccepted && privacyAccepted,
    termsAccepted,
    privacyAccepted,
  };
}

async function hasCurrentConsent(userId) {
  return (await currentConsentStatus(userId)).accepted;
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
      throw new PublicError('consent_required', 'Les documents requis doivent être acceptés avant de jouer.', 403);
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

function effectiveRoomSettings(state) {
  const settings = state?.roomSettings || {};
  return {
    maxPlayers: Number.isInteger(settings.maxPlayers) ? settings.maxPlayers : MAX_PLAYERS_PER_ROOM,
    locked: settings.locked === true,
    allowSpectators: settings.allowSpectators !== false,
    chatEnabled: settings.chatEnabled !== false,
    ...effectiveRoomVariantSettings(settings),
  };
}

function assertUserRoomAccess(state, userId) {
  if (isUserBanned(state, userId)) {
    throw new PublicError('room_banned', 'Vous êtes banni de cette salle.', 403);
  }
}

function assertNewPlayerAdmission(state, userId) {
  assertUserRoomAccess(state, userId);
  const settings = effectiveRoomSettings(state);
  if (settings.locked) {
    throw new PublicError('room_locked', 'Cette salle est verrouillée.', 409);
  }
  if (state.order.length >= settings.maxPlayers) {
    throw new PublicError(
      'room_full',
      'Cette salle est complète. Vous pouvez la regarder en spectateur.',
      409,
    );
  }
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
  if (!Number.isSafeInteger(state.gameSerial) || state.gameSerial < 0) {
    state.gameSerial = state.phase === 'lobby' ? 0 : 1;
  }
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
    assertActionCardIntegrity(draft);
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

async function findLatestActiveMembership(userId) {
  const { data, error } = await supabase.from('room_members')
    .select('room_id, player_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  let latestGame = null;
  let latestLobby = null;
  for (const member of data || []) {
    const state = await getOrLoadRoom(member.room_id);
    if (!state || state.phase === 'gameEnd') continue;
    if (!state.playersById[member.player_id]) continue;
    const candidate = { member, updatedAt: state.updatedAt || 0 };
    if (state.phase === 'lobby') {
      if (!latestLobby || candidate.updatedAt > latestLobby.updatedAt) latestLobby = candidate;
    } else if (!latestGame || candidate.updatedAt > latestGame.updatedAt) {
      latestGame = candidate;
    }
  }
  return latestGame?.member || latestLobby?.member || null;
}

async function findOwnedRoomMembership(userId) {
  const { data, error } = await supabase.from('rooms')
    .select('room_id, updated_at')
    .eq('owner_user_id', userId)
    .is('quarantined_at', null)
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw error;

  for (const room of data || []) {
    const member = await findMemberByUser(room.room_id, userId);
    if (!member) continue;
    const state = await getOrLoadRoom(room.room_id);
    if (state?.playersById?.[member.player_id]) return { state, member };
  }
  return null;
}

async function createRoom({ ownerUserId, playerName, roomVisibility, maxPlayers }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const roomId = generateRoomId();
    const playerId = nanoid(12);
    const state = newRoomState(roomId);
    state.schemaVersion = ROOM_SCHEMA_VERSION;
    state.roomVisibility = roomVisibility === 'public' ? 'public' : 'private';
    if (Number.isInteger(maxPlayers) && maxPlayers >= 2 && maxPlayers <= MAX_PLAYERS_PER_ROOM) {
      state.roomSettings.maxPlayers = maxPlayers;
    }
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

async function listPublicRooms(userId) {
  const { data, error } = await supabase.from('rooms')
    .select(`
      room_id,
      players_by_id:state_json->playersById,
      player_count,
      creator_name,
      game_mode,
      phase,
      updated_at,
      room_settings:state_json->roomSettings,
      banned_user_ids:state_json->bannedUserIds
    `)
    .eq('visibility', 'public')
    .in('phase', ['lobby', 'initialFlip', 'playing', 'roundEnd'])
    .is('quarantined_at', null)
    .gt('player_count', 0)
    .gt('updated_at', new Date(Date.now() - ROOM_TTL_MS).toISOString())
    .order('updated_at', { ascending: false }).limit(30);
  if (error) throw error;
  const abandonedBefore = new Date(Date.now() - PUBLIC_ROOM_DISCONNECT_GRACE_MS).toISOString();
  const abandonedRoomIds = new Set((data || [])
    .filter((row) => {
      if (row.updated_at > abandonedBefore) return false;
      const players = Object.values(row.players_by_id || {});
      return players.length > 0 && players.every((player) => player?.connected === false);
    })
    .map((row) => row.room_id));
  if (abandonedRoomIds.size) {
    await Promise.all([...abandonedRoomIds].map(async (roomId) => {
      const { error: deleteError } = await supabase.from('rooms')
        .delete()
        .eq('room_id', roomId)
        .eq('visibility', 'public')
        .lte('updated_at', abandonedBefore);
      if (deleteError) throw deleteError;
      rooms.delete(roomId);
      roomMeta.delete(roomId);
      clearRoomTimers(roomId);
    }));
  }
  const spectatorCounts = roomSpectatorCounts();
  return (data || [])
    .filter((row) => !abandonedRoomIds.has(row.room_id))
    .filter((row) => !isUserBanned({ bannedUserIds: row.banned_user_ids }, userId))
    .map((row) => {
      const settings = effectiveRoomSettings({ roomSettings: row.room_settings });
      return {
        roomId: row.room_id,
        playerCount: row.player_count,
        maxPlayers: settings.maxPlayers,
        creatorName: normalizePlayerName(row.creator_name) || 'Salle publique',
        gameMode: row.game_mode === 'action' ? 'action' : 'classic',
        phase: ['initialFlip', 'playing', 'roundEnd', 'gameEnd'].includes(row.phase)
          ? row.phase
          : 'lobby',
        locked: settings.locked,
        allowSpectators: settings.allowSpectators,
        gameEndMode: settings.gameEndMode,
        scoreTarget: settings.scoreTarget,
        roundLimit: settings.roundLimit,
        spectatorCount: spectatorCounts.get(row.room_id) || 0,
        updatedAt: Date.parse(row.updated_at),
      };
    })
    .filter((room) => room.allowSpectators || (
      room.phase === 'lobby'
      && !room.locked
      && room.playerCount < room.maxPlayers
    ));
}

async function getPublicRoomPreview(roomId, userId) {
  const state = await getOrLoadRoom(roomId);
  if (!state || state.roomVisibility !== 'public' || state.phase === 'gameEnd') return null;
  if (isUserBanned(state, userId)) {
    throw new PublicError('room_banned', 'Vous êtes banni de cette salle.', 403);
  }
  if (!effectiveRoomSettings(state).allowSpectators) {
    throw new PublicError(
      'spectators_disabled',
      'Cette salle n’autorise pas les spectateurs.',
      403,
    );
  }
  return roomPublicPreviewState(state);
}

function connectionKey(roomId, playerId) { return `${roomId}:${playerId}`; }
function normalizeRoomRole(value) { return value === 'spectator' ? 'spectator' : 'player'; }
function publicPreviewSocketRoom(roomId) { return `public-preview:${roomId}`; }

function roomSpectatorCount(roomId) {
  return roomSpectatorCounts().get(roomId) || 0;
}

function roomSpectatorCounts() {
  const spectatorIdsByRoom = new Map();
  for (const [socketId, info] of socketToPlayer) {
    if (info.role !== 'spectator') continue;
    let roomIds = spectatorIdsByRoom.get(info.roomId);
    if (!roomIds) {
      roomIds = new Set();
      spectatorIdsByRoom.set(info.roomId, roomIds);
    }
    const userId = io.sockets.sockets.get(socketId)?.data.auth?.user?.id;
    roomIds.add(userId || `socket:${socketId}`);
  }
  const counts = new Map();
  for (const [roomId, roomIds] of spectatorIdsByRoom) {
    counts.set(roomId, roomIds.size);
  }
  return counts;
}

function roomPublicState(state, playerId, spectatorCount = roomSpectatorCount(state.roomId)) {
  return {
    ...publicState(state, playerId),
    spectatorCount,
  };
}

function roomPublicPreviewState(state, spectatorCount = roomSpectatorCount(state.roomId)) {
  return {
    ...publicPreviewState(state),
    spectatorCount,
  };
}

function clearDisconnectTimer(roomId, playerId) {
  const key = connectionKey(roomId, playerId);
  const timer = disconnectTimers.get(key);
  if (timer) clearTimeout(timer);
  disconnectTimers.delete(key);
}

function socketIdsForPlayer(roomId, playerId) {
  return [...socketToPlayer]
    .filter(([, info]) => info.role === 'player' && info.roomId === roomId && info.playerId === playerId)
    .map(([id]) => id);
}

function revokeRoomAccess(roomId, predicate, { reason, message }) {
  let revokedCount = 0;
  let spectatorAccessRevoked = false;
  for (const [socketId, info] of socketToPlayer) {
    if (info.roomId !== roomId) continue;
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!predicate(info, targetSocket)) continue;
    socketToPlayer.delete(socketId);
    revokedCount += 1;
    if (info.role === 'spectator') spectatorAccessRevoked = true;
    targetSocket?.leave(roomId);
    targetSocket?.emit(
      SOCKET_EVENTS.ROOM_ACCESS_REVOKED,
      socketServerPayload(SOCKET_EVENTS.ROOM_ACCESS_REVOKED, { reason, message }),
    );
  }
  if (spectatorAccessRevoked) broadcastRoom(roomId);
  return revokedCount;
}

function revokePublicPreviewAccess(roomId, predicate, { code, message }) {
  const previewRoom = publicPreviewSocketRoom(roomId);
  const socketIds = io.sockets.adapter.rooms.get(previewRoom) || new Set();
  for (const socketId of [...socketIds]) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket || !predicate(targetSocket)) continue;
    targetSocket.leave(previewRoom);
    if (targetSocket.data.publicPreviewRoomId === roomId) {
      targetSocket.data.publicPreviewRoomId = null;
    }
    targetSocket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
      code,
      message,
    }));
  }
}

async function attachSocket(
  socket,
  roomId,
  playerId,
  playerName,
  { removeMemberOnDisconnect = false } = {},
) {
  const previous = socketToPlayer.get(socket.id);
  if (previous && (previous.roomId !== roomId || previous.playerId !== playerId)) {
    throw new PublicError(
      'already_in_room',
      'Quittez d’abord votre salle actuelle.',
      409,
    );
  }
  const { state } = await mutateRoom(roomId, (draft) => {
    assertUserRoomAccess(draft, socket.data.auth.user.id);
    const player = draft.playersById[playerId];
    if (!player) throw new PublicError('seat_unavailable', 'Impossible de rejoindre cette salle.', 409);
    player.connected = true;
    if (playerName) player.name = playerName;
  });
  if (!socket.connected) {
    const hasAnotherSocket = socketIdsForPlayer(roomId, playerId).length > 0;
    if (!hasAnotherSocket) {
      if (removeMemberOnDisconnect) {
        await mutateRoom(
          roomId,
          (draft) => leavePlayer(draft, playerId),
          { removePlayerId: playerId },
        );
      } else {
        await mutateRoom(roomId, (draft) => removePlayer(draft, playerId));
      }
    }
    return null;
  }
  clearDisconnectTimer(roomId, playerId);
  socketToPlayer.set(socket.id, { roomId, playerId, role: 'player' });
  socket.join(roomId);
  socket.emit(
    SOCKET_EVENTS.JOINED,
    socketServerPayload(SOCKET_EVENTS.JOINED, { roomId, playerId, role: 'player' }),
  );
  broadcastRoom(roomId);
  await safelySendInitialChatHistory(socket, state);
  scheduleNextRound(roomId, state);
  scheduleDefensePrompt(roomId, state);
}

async function attachSpectator(socket, roomId) {
  if (!roomId) return null;
  const state = await enqueueRoom(roomId, async () => {
    const latest = await getOrLoadRoom(roomId);
    if (!latest) return null;
    assertUserRoomAccess(latest, socket.data.auth.user.id);
    if (!effectiveRoomSettings(latest).allowSpectators) {
      throw new PublicError('spectators_disabled', 'Cette salle n’autorise pas les spectateurs.', 403);
    }
    const previous = socketToPlayer.get(socket.id);
    if (previous && (previous.roomId !== roomId || previous.role !== 'spectator')) {
      throw new PublicError(
        'already_in_room',
        'Quittez d’abord votre salle actuelle.',
        409,
      );
    }
    const spectatorCount = [...socketToPlayer.values()]
      .filter((info) => info.roomId === roomId && info.role === 'spectator')
      .length;
    if (!previous && spectatorCount >= MAX_SPECTATORS_PER_ROOM) {
      throw new PublicError('spectator_limit', 'Le mode spectateur est complet.', 409);
    }
    if (!socket.connected) return null;
    socketToPlayer.set(socket.id, { roomId, playerId: null, role: 'spectator' });
    socket.join(roomId);
    return latest;
  });
  if (!state) return null;
  const attached = socketToPlayer.get(socket.id);
  if (attached?.roomId !== roomId || attached.role !== 'spectator') return null;
  socket.emit(
    SOCKET_EVENTS.JOINED,
    socketServerPayload(SOCKET_EVENTS.JOINED, {
      roomId,
      playerId: null,
      role: 'spectator',
    }),
  );
  socket.emit(SOCKET_EVENTS.STATE, roomPublicState(state, null));
  broadcastRoom(roomId);
  await safelySendInitialChatHistory(socket, state);
  return { role: 'spectator' };
}

async function attachExistingMember(socket, roomId, playerName = '') {
  if (!roomId) return null;
  const state = await getOrLoadRoom(roomId);
  if (!state) return null;
  if (isUserBanned(state, socket.data.auth.user.id)) {
    throw new PublicError('room_banned', 'Vous êtes banni de cette salle.', 403);
  }
  const member = await findMemberByUser(roomId, socket.data.auth.user.id);
  if (!member) return null;
  if (!state.playersById[member.player_id]) return null;
  await attachSocket(socket, roomId, member.player_id, playerName);
  return member;
}

async function attachLatestActiveMember(socket, playerName = '') {
  const member = await findLatestActiveMembership(socket.data.auth.user.id);
  if (!member) return null;
  return attachExistingMember(socket, member.room_id, playerName);
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
    socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
      code: 'invalid_session',
      message: 'Session invalide ou expirée.',
    }));
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
  if (eventName === SOCKET_EVENTS.SEND_CHAT_MESSAGE) {
    checks.push(consumeRateLimit(`chat:user:${userId}`, { limit: 8, windowMs: 60_000 }));
    const info = socketToPlayer.get(socket.id);
    if (info) checks.push(consumeRateLimit(`chat:room:${info.roomId}`, { limit: 40, windowMs: 60_000 }));
  }
  const denied = checks.find((result) => !result.allowed);
  if (denied) socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
    code: 'rate_limited',
    message: 'Trop de requêtes. Réessayez plus tard.',
    retryAfter: denied.retryAfter,
  }));
  return !denied;
}

function withSocketGuard(socket, eventName, handler) {
  return async (...args) => {
    await socket.data.attachPromise;
    if (!checkSocketRateLimit(socket, eventName)) return;
    if (!await ensureSocketSession(socket)) {
      socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
        code: 'invalid_session',
        message: 'Session invalide ou expirée.',
      }));
      socket.disconnect(true);
      return;
    }
    try {
      await handler(...args);
    } catch (error) {
      const correlationId = error instanceof PublicError ? null : logInternal(`socket:${eventName}`, error);
      socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, error instanceof PublicError
        ? { code: error.code, message: error.message }
        : { code: 'internal_error', message: 'Action impossible.', requestId: correlationId }));
    }
  };
}

function actionPayload(value) {
  const payload = objectPayload(value, socketPayloadKeys(SOCKET_EVENTS.RESOLVE_ACTION));
  if (!payload.draft) return payload;
  const draft = objectPayload(payload.draft, SOCKET_ACTION_DRAFT_KEYS);
  if (draft.peekFirst) objectPayload(draft.peekFirst, SOCKET_PEEK_FIRST_KEYS);
  return { ...payload, draft };
}

function broadcastRoom(roomId) {
  const state = rooms.get(roomId);
  if (!state) return;
  const spectatorCount = roomSpectatorCount(roomId);
  io.to(roomId).emit(
    SOCKET_EVENTS.SPECTATOR_STATE,
    roomPublicState(state, null, spectatorCount),
  );
  if (state.roomVisibility === 'public' && state.phase !== 'gameEnd') {
    io.to(publicPreviewSocketRoom(roomId)).emit(
      SOCKET_EVENTS.PUBLIC_PREVIEW_STATE,
      roomPublicPreviewState(state, spectatorCount),
    );
  } else if (state.phase === 'gameEnd') {
    revokePublicPreviewAccess(
      roomId,
      () => true,
      {
        code: 'room_unavailable',
        message: 'Cette partie publique est terminée.',
      },
    );
  }
  for (const [socketId, info] of socketToPlayer) {
    if (info.roomId !== roomId || info.role !== 'player') continue;
    if (state.playersById[info.playerId]) {
      io.to(socketId).emit(
        SOCKET_EVENTS.STATE,
        roomPublicState(state, info.playerId, spectatorCount),
      );
    }
  }
}

async function handleAction(socket, fn, mutationOptions = {}) {
  const info = socketToPlayer.get(socket.id);
  if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
  if (info.role !== 'player' || !info.playerId) {
    throw new PublicError('spectator_read_only', 'Le mode spectateur est en lecture seule.', 403);
  }
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
  }, mutationOptions);
  if (state.phase === 'lobby') clearDisconnectTimersForRoom(info.roomId);
  broadcastRoom(info.roomId);
  scheduleNextRound(info.roomId, state);
  scheduleDefensePrompt(info.roomId, state);
}

async function handleTrackedHumanAction(socket, fn, decisionEvent) {
  const info = socketToPlayer.get(socket.id);
  const previousState = info?.role === 'player' ? rooms.get(info.roomId) : null;
  const context = previousState && info?.playerId
    ? buildHumanDecisionContext(previousState, info.playerId)
    : null;
  await handleAction(socket, fn);
  const state = info ? rooms.get(info.roomId) : null;
  if (info && state && context) {
    void persistHumanDecision({
      socket,
      info,
      state,
      context,
      type: decisionEvent.type,
      decision: decisionEvent.decision,
    });
  }
}

function buildHumanDecisionContext(state, playerId) {
  const view = publicState(state, playerId);
  return {
    gameSerial: view.gameSerial,
    roundNumber: view.roundNumber,
    turnSerial: view.turnSerial,
    gameMode: view.gameMode,
    phase: view.phase,
    turnStage: view.turnStage,
    roundEnderId: view.roundEnderId || null,
    discardTop: view.discardTop || null,
    deckCount: view.deckCount,
    drawnCard: view.drawnCard || null,
    players: view.players.map((player) => ({
      id: player.id,
      isActor: player.id === playerId,
      totalScore: player.totalScore,
      hasTotalScore: player.hasTotalScore,
      board: player.board.map(({ faceUp, removed, value, kind }) => ({
        faceUp,
        removed,
        value,
        kind,
      })),
    })),
    actionMarket: view.actionMarket || null,
    actionDiscardTop: view.actionDiscardTop || null,
    playersAction: view.playersAction || null,
    pendingAction: view.pendingAction || null,
    pendingStarClaim: view.pendingStarClaim || null,
    pendingGroupChoice: view.pendingGroupChoice || null,
    pendingGroupChoices: view.pendingGroupChoices || null,
  };
}

async function persistHumanDecision({ socket, info, state, context, type, decision }) {
  try {
    const userId = socket.data.auth.user.id;
    const { error } = await supabase.from('game_decision_events').insert({
      room_id: info.roomId,
      game_serial: context.gameSerial,
      round_number: context.roundNumber,
      turn_serial: context.turnSerial || 0,
      user_id: userId,
      player_id: info.playerId,
      game_mode: context.gameMode || state.gameMode || 'classic',
      decision_type: type,
      decision_context: context,
      decision,
    });
    if (error) throw error;
  } catch (error) {
    logInternal('game_decision_event', error);
  }
}

function clearDisconnectTimersForRoom(roomId) {
  for (const [key, timer] of disconnectTimers) {
    if (!key.startsWith(`${roomId}:`)) continue;
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

function clearRoomTimers(roomId) {
  for (const timers of [nextRoundTimers, defensePromptTimers]) {
    const timer = timers.get(roomId);
    if (timer) clearTimeout(timer);
    timers.delete(roomId);
  }
  clearDisconnectTimersForRoom(roomId);
}

function scheduleNextRound(roomId, state, retryDelayMs = 0) {
  const existing = nextRoundTimers.get(roomId);
  if (existing) clearTimeout(existing);
  nextRoundTimers.delete(roomId);
  if (state.phase !== 'roundEnd' || !state.nextRoundAt) return;
  const timer = setTimeout(async () => {
    nextRoundTimers.delete(roomId);
    try {
      const { state: latest } = await mutateRoom(roomId, (draft) => {
        if (draft.phase !== 'roundEnd' || !draft.nextRoundAt || draft.nextRoundAt > Date.now()) return;
        nextRound(draft);
      });
      broadcastRoom(roomId);
      scheduleNextRound(roomId, latest);
      scheduleDefensePrompt(roomId, latest);
    } catch (error) {
      logInternal('next_round', error);
      const latest = rooms.get(roomId);
      if (latest) scheduleNextRound(roomId, latest, 1_000);
    }
  }, Math.max(retryDelayMs, state.nextRoundAt - Date.now(), 0));
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
    id: row.message_id, t: Date.parse(row.sent_at),
    type: row.player_id === SYSTEM_CHAT_PLAYER_ID ? 'system' : 'user',
    playerId: row.player_id,
    playerName: row.player_name, text: row.body,
  };
}

async function appendSystemChatMessage(roomId, text) {
  const body = normalizeChatMessage(text);
  if (!body) throw new Error('invalid_system_chat_message');
  await enqueueRoom(roomId, async () => {
    const state = await getOrLoadRoom(roomId);
    if (!state || !effectiveRoomSettings(state).chatEnabled) return;
    const messageId = nanoid(18);
    const { data, error } = await supabase.rpc('append_skyjo_message', {
      p_room_id: roomId,
      p_message_id: messageId,
      p_player_id: SYSTEM_CHAT_PLAYER_ID,
      p_player_name: SYSTEM_CHAT_PLAYER_NAME,
      p_body: body,
      p_sent_at: new Date().toISOString(),
    });
    if (error || !data?.[0]) throw error || new Error('system_message_not_persisted');
    state.updatedAt = Date.now();
    io.to(roomId).emit(
      SOCKET_EVENTS.CHAT_MESSAGE,
      socketServerPayload(SOCKET_EVENTS.CHAT_MESSAGE, mapMessage(data[0])),
    );
  });
}

async function safelyAppendSystemChatMessage(roomId, text) {
  try {
    await appendSystemChatMessage(roomId, text);
  } catch (error) {
    logInternal('system_chat_message', error);
  }
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
  const state = await getOrLoadRoom(info.roomId);
  if (!state || !effectiveRoomSettings(state).chatEnabled) {
    throw new PublicError('chat_disabled', 'Le chat est désactivé dans cette salle.', 403);
  }
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
  const latestInfo = socketToPlayer.get(socket.id);
  if (!latestInfo
    || latestInfo.roomId !== info.roomId
    || latestInfo.playerId !== info.playerId
    || latestInfo.role !== info.role) return;
  const rows = (data || []).slice(0, CHAT_PAGE_SIZE);
  const messages = rows.map(mapMessage).reverse();
  socket.emit(SOCKET_EVENTS.CHAT_HISTORY, socketServerPayload(SOCKET_EVENTS.CHAT_HISTORY, {
    messages,
    hasMore: (data || []).length > CHAT_PAGE_SIZE,
    before: encodeChatCursor(rows.at(-1)),
  }));
}

async function safelySendInitialChatHistory(socket, state) {
  if (!effectiveRoomSettings(state).chatEnabled) return;
  try {
    await sendChatHistory(socket, null);
  } catch (error) {
    if (error instanceof PublicError && ['chat_disabled', 'not_in_room'].includes(error.code)) {
      return;
    }
    logInternal('initial_chat_history', error);
  }
}

async function appendChatMessage(socket, value) {
  const info = socketToPlayer.get(socket.id);
  if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
  if (info.role !== 'player' || !info.playerId) {
    throw new PublicError('spectator_read_only', 'Le chat est en lecture seule pour les spectateurs.', 403);
  }
  const text = normalizeChatMessage(value);
  if (!text) throw new PublicError('invalid_message', 'Message vide ou trop long.', 400);
  await enqueueRoom(info.roomId, async () => {
    const latestInfo = socketToPlayer.get(socket.id);
    if (!latestInfo
      || latestInfo.roomId !== info.roomId
      || latestInfo.playerId !== info.playerId
      || latestInfo.role !== 'player') {
      throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
    }
    const state = await getOrLoadRoom(info.roomId);
    if (!state || !effectiveRoomSettings(state).chatEnabled) {
      throw new PublicError('chat_disabled', 'Le chat est désactivé dans cette salle.', 403);
    }
    const player = state.playersById[info.playerId];
    if (!player) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
    const messageId = nanoid(18);
    const { data, error } = await supabase.rpc('append_skyjo_message', {
      p_room_id: info.roomId, p_message_id: messageId, p_player_id: info.playerId,
      p_player_name: normalizePlayerName(player.name), p_body: text,
      p_sent_at: new Date().toISOString(),
    });
    if (error || !data?.[0]) throw error || new Error('message_not_persisted');
    state.updatedAt = Date.now();
    io.to(info.roomId).emit(
      SOCKET_EVENTS.CHAT_MESSAGE,
      socketServerPayload(SOCKET_EVENTS.CHAT_MESSAGE, mapMessage(data[0])),
    );
  });
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
      io.to(socketId).emit(SOCKET_EVENTS.ROOM_EXPIRED);
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
app.use(httpRateLimit({ keyPrefix: 'preauth', limit: 120, windowMs: 60_000 }));
app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true, inflate: false }));

app.get('/health', (req, res) => res.json({ ok: true, clientProtocolVersion: SOCKET_PROTOCOL_VERSION }));
app.use('/api/auth', authBff.router);

app.get('/api/account/consent', requireHttpAuth, authBff.requireStandardSession, async (req, res, next) => {
  try {
    const status = await currentConsentStatus(req.auth.user.id);
    res.json({
      ...status,
      termsVersion: TERMS_CONSENT_VERSION,
      privacyVersion: PRIVACY_CONSENT_VERSION,
    });
  } catch (error) { next(error); }
});

app.post('/api/account/consent', requireHttpAuth, authBff.requireStandardSession, authBff.requireCsrf, httpRateLimit({ keyPrefix: 'consent', limit: 5, windowMs: 60_000, user: true }), async (req, res, next) => {
  try {
    const payload = objectPayload(req.body, ['termsVersion', 'privacyVersion']);
    const status = await currentConsentStatus(req.auth.user.id);
    if (
      (!status.termsAccepted && payload.termsVersion !== TERMS_CONSENT_VERSION)
      || (!status.privacyAccepted && payload.privacyVersion !== PRIVACY_CONSENT_VERSION)
      || (payload.termsVersion !== undefined && payload.termsVersion !== TERMS_CONSENT_VERSION)
      || (payload.privacyVersion !== undefined && payload.privacyVersion !== PRIVACY_CONSENT_VERSION)
    ) {
      throw new PublicError('invalid_consent', 'Version de consentement invalide.', 400);
    }
    const provider = String(req.auth.user.app_metadata?.provider || 'unknown').slice(0, 32);
    const { error } = await supabase.from('account_consents').upsert({
      user_id: req.auth.user.id, terms_version: TERMS_CONSENT_VERSION,
      privacy_version: PRIVACY_CONSENT_VERSION, accepted_at: new Date().toISOString(), provider,
    }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({
      accepted: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: TERMS_CONSENT_VERSION,
      privacyVersion: PRIVACY_CONSENT_VERSION,
    });
  } catch (error) { next(error); }
});

app.post('/api/rooms', requireHttpAuth, authBff.requireStandardSession, authBff.requireCsrf, requireConsent,
  httpRateLimit({ keyPrefix: 'create-room', limit: 5, windowMs: 60_000, user: true }),
  async (req, res, next) => {
    try {
      const payload = objectPayload(req.body, ['playerName', 'roomVisibility', 'maxPlayers']);
      const playerName = normalizePlayerName(payload.playerName);
      if (!playerName) throw new PublicError('invalid_player_name', 'Choisissez un nom de joueur.', 400);
      const maxPlayers = payload.maxPlayers === undefined
        ? MAX_PLAYERS_PER_ROOM
        : Number(payload.maxPlayers);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > MAX_PLAYERS_PER_ROOM) {
        throw new PublicError(
          'invalid_room_settings',
          `Le nombre maximal de joueurs doit être compris entre 2 et ${MAX_PLAYERS_PER_ROOM}.`,
          400,
        );
      }
      const existingRoom = await findOwnedRoomMembership(req.auth.user.id);
      if (existingRoom) {
        res.json({
          roomId: existingRoom.state.roomId,
          playerId: existingRoom.member.player_id,
          existing: true,
        });
        return;
      }
      let createdRoom;
      try {
        createdRoom = await createRoom({
          ownerUserId: req.auth.user.id, playerName,
          roomVisibility: payload.roomVisibility === 'public' ? 'public' : 'private',
          maxPlayers,
        });
      } catch (createError) {
        if (!String(createError?.message || '').includes('active_room_exists')) throw createError;
        const concurrentRoom = await findOwnedRoomMembership(req.auth.user.id);
        if (!concurrentRoom) throw createError;
        res.json({
          roomId: concurrentRoom.state.roomId,
          playerId: concurrentRoom.member.player_id,
          existing: true,
        });
        return;
      }
      const { state, playerId } = createdRoom;
      res.status(201).json({ roomId: state.roomId, playerId });
    } catch (error) { next(error); }
  });

app.get('/api/rooms/public', requireHttpAuth, authBff.requireStandardSession, requireConsent,
  httpRateLimit({ keyPrefix: 'list-public-rooms', limit: 60, windowMs: 60_000, user: true }),
  async (req, res, next) => {
    try { res.json({ rooms: await listPublicRooms(req.auth.user.id) }); }
    catch (error) { next(error); }
  });

app.get('/api/rooms/public/:roomId/preview', requireHttpAuth, authBff.requireStandardSession, requireConsent,
  httpRateLimit({ keyPrefix: 'preview-public-room', limit: 90, windowMs: 60_000, user: true }),
  async (req, res, next) => {
    try {
      const roomId = normalizeRoomId(req.params.roomId);
      const preview = roomId
        ? await getPublicRoomPreview(roomId, req.auth.user.id)
        : null;
      if (!preview) throw new PublicError('room_unavailable', 'Cette partie publique n’est plus disponible.', 404);
      res.json({ room: preview });
    } catch (error) { next(error); }
  });

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Ressource introuvable.' } }));
app.use((error, req, res, next) => {
  void next;
  const id = requestId();
  const normalized = error?.type === 'entity.too.large'
    ? new PublicError('payload_too_large', 'Corps JSON trop volumineux.', 413)
    : error?.type === 'encoding.unsupported'
      ? new PublicError('unsupported_encoding', 'Compression du corps non autorisée.', 415)
    : error instanceof SyntaxError && 'body' in error
      ? new PublicError('invalid_json', 'Corps JSON invalide.', 400)
      : error;
  if (!(normalized instanceof PublicError)) logInternal('http', normalized, id);
  const payload = publicErrorPayload(normalized, id);
  res.status(payload.status).json(payload.body);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true },
  allowRequest: (req, callback) => {
    const originAllowed = Boolean(
      (!isProduction || req.headers.origin) && isAllowedOrigin(req.headers.origin),
    );
    if (!originAllowed) {
      callback(null, false);
      return;
    }
    const ip = clientIpFromForwarded(
      req.headers['x-forwarded-for'],
      req.socket?.remoteAddress || req.connection?.remoteAddress,
    );
    callback(
      null,
      consumeRateLimit(`transport-handshake:${ip}`, { limit: 20, windowMs: 60_000 }).allowed,
    );
  },
  maxHttpBufferSize: 20_000,
});

io.use(async (socket, next) => {
  try {
    const handshake = objectPayload(socket.handshake.auth || {}, SOCKET_HANDSHAKE_KEYS);
    if (Number(handshake.protocolVersion) !== SOCKET_PROTOCOL_VERSION) {
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
  const initialRoomRole = normalizeRoomRole(socket.handshake.auth?.roomRole);
  const discoverActiveRoom = socket.handshake.auth?.discoverActiveRoom === true;
  const initialAttach = initialRoomRole === 'spectator'
    ? attachSpectator(socket, initialRoomId)
    : initialRoomId
      ? attachExistingMember(
        socket,
        initialRoomId,
        normalizePlayerName(socket.handshake.auth?.playerName),
      )
      : discoverActiveRoom
        ? attachLatestActiveMember(
          socket,
          normalizePlayerName(socket.handshake.auth?.playerName),
        )
        : Promise.resolve(null);
  socket.data.attachPromise = initialAttach.then((connection) => {
    if (initialRoomId && !connection) {
      socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
        code: 'room_unavailable',
        message: 'Cette salle n\'est plus disponible.',
      }));
    }
    return connection;
  }).catch((error) => {
    if (error instanceof PublicError) {
      socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
        code: error.code,
        message: error.message,
      }));
    } else {
      logInternal('socket_auto_attach', error);
      socket.emit(SOCKET_EVENTS.ERROR, socketServerPayload(SOCKET_EVENTS.ERROR, {
        code: 'reconnect_failed',
        message: 'Impossible de retrouver cette salle pour le moment.',
      }));
    }
    return null;
  });

  socket.on(SOCKET_EVENTS.JOIN_ROOM, withSocketGuard(socket, SOCKET_EVENTS.JOIN_ROOM, async (payload = {}) => {
    const data = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.JOIN_ROOM));
    const roomId = normalizeRoomId(data.roomId);
    const role = normalizeRoomRole(data.role);
    const playerName = normalizePlayerName(data.playerName);
    if (!roomId || (role === 'player' && !playerName)) {
      throw new PublicError('invalid_join', 'Impossible de rejoindre cette salle.', 400);
    }
    const currentRoom = socketToPlayer.get(socket.id);
    if (currentRoom && (currentRoom.roomId !== roomId || currentRoom.role !== role)) {
      throw new PublicError(
        'already_in_room',
        'Quittez d’abord votre salle actuelle.',
        409,
      );
    }
    const joinUserLimit = consumeRateLimit(`join-attempt:user:${socket.data.auth.user.id}`, { limit: 10, windowMs: 60_000 });
    const joinIpLimit = consumeRateLimit(`join-attempt:ip:${socketIp(socket)}`, { limit: 40, windowMs: 60_000 });
    if (!joinUserLimit.allowed || !joinIpLimit.allowed) {
      throw new PublicError('rate_limited', 'Trop de tentatives. Réessayez plus tard.', 429);
    }
    let state = await getOrLoadRoom(roomId);
    if (!state) {
      const userLimit = consumeRateLimit(`join-failure:user:${socket.data.auth.user.id}`, { limit: 5, windowMs: 600_000 });
      const ipLimit = consumeRateLimit(`join-failure:ip:${socketIp(socket)}`, { limit: 20, windowMs: 600_000 });
      if (!userLimit.allowed || !ipLimit.allowed) {
        throw new PublicError('rate_limited', 'Trop de tentatives. Réessayez plus tard.', 429);
      }
      throw new PublicError('room_unavailable', 'Impossible de rejoindre cette salle.', 404);
    }
    assertUserRoomAccess(state, socket.data.auth.user.id);
    if (role === 'spectator') {
      await attachSpectator(socket, roomId);
      return;
    }
    let member = await findMemberByUser(roomId, socket.data.auth.user.id);
    let memberCreated = false;
    if (!member) {
      assertNewPlayerAdmission(state, socket.data.auth.user.id);
      const playerId = nanoid(12);
      try {
        const result = await mutateRoom(roomId, (draft) => {
          if (draft.phase !== 'lobby') throw new PublicError('room_unavailable', 'Impossible de rejoindre cette salle.', 409);
          assertNewPlayerAdmission(draft, socket.data.auth.user.id);
          addPlayer(draft, playerId, playerName);
        }, { member: { userId: socket.data.auth.user.id, playerId } });
        state = result.state;
        member = { player_id: playerId, user_id: socket.data.auth.user.id };
        memberCreated = true;
      } catch (error) {
        if (error?.code !== '23505' && !String(error?.message || '').includes('duplicate')) throw error;
        member = await findMemberByUser(roomId, socket.data.auth.user.id);
        state = await getOrLoadRoom(roomId);
        if (!member || !state) throw error;
      }
    }
    if (!state.playersById[member.player_id]) throw new PublicError('seat_unavailable', 'Impossible de rejoindre cette salle.', 409);
    await attachSocket(socket, roomId, member.player_id, playerName, {
      removeMemberOnDisconnect: memberCreated,
    });
  }));

  socket.on(SOCKET_EVENTS.LEAVE_ROOM, withSocketGuard(socket, SOCKET_EVENTS.LEAVE_ROOM, async (acknowledge) => {
    const info = socketToPlayer.get(socket.id);
    if (!info) { if (typeof acknowledge === 'function') acknowledge({ ok: true }); return; }
    if (info.role === 'spectator') {
      socketToPlayer.delete(socket.id);
      socket.leave(info.roomId);
      broadcastRoom(info.roomId);
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
      return;
    }
    const allSocketIds = socketIdsForPlayer(info.roomId, info.playerId);
    let leavingPlayerName = '';
    const { state } = await mutateRoom(info.roomId, async (draft) => {
      leavingPlayerName = normalizePlayerName(draft.playersById[info.playerId]?.name);
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
    if (leavingPlayerName) {
      await safelyAppendSystemChatMessage(info.roomId, `${leavingPlayerName} a quitté la salle.`);
    }
    if (typeof acknowledge === 'function') acknowledge({ ok: true });
  }));

  socket.on(SOCKET_EVENTS.SUBSCRIBE_PUBLIC_PREVIEW, withSocketGuard(
    socket,
    SOCKET_EVENTS.SUBSCRIBE_PUBLIC_PREVIEW,
    async (payload) => {
      const limit = consumeRateLimit(
        `public-preview:user:${socket.data.auth.user.id}`,
        { limit: 60, windowMs: 60_000 },
      );
      if (!limit.allowed) {
        throw new PublicError('rate_limited', 'Trop de prévisualisations. Réessayez plus tard.', 429);
      }
      const roomId = normalizeRoomId(
        objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.SUBSCRIBE_PUBLIC_PREVIEW)).roomId,
      );
      const preview = roomId
        ? await getPublicRoomPreview(roomId, socket.data.auth.user.id)
        : null;
      if (!preview) {
        throw new PublicError('room_unavailable', 'Cette partie publique n’est plus disponible.', 404);
      }
      const previousRoomId = socket.data.publicPreviewRoomId;
      if (previousRoomId && previousRoomId !== roomId) {
        socket.leave(publicPreviewSocketRoom(previousRoomId));
      }
      socket.data.publicPreviewRoomId = roomId;
      socket.join(publicPreviewSocketRoom(roomId));
      socket.emit(SOCKET_EVENTS.PUBLIC_PREVIEW_STATE, preview);
    },
  ));

  socket.on(SOCKET_EVENTS.UNSUBSCRIBE_PUBLIC_PREVIEW, withSocketGuard(
    socket,
    SOCKET_EVENTS.UNSUBSCRIBE_PUBLIC_PREVIEW,
    (payload) => {
      const roomId = normalizeRoomId(
        objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.UNSUBSCRIBE_PUBLIC_PREVIEW)).roomId,
      );
      if (!roomId || socket.data.publicPreviewRoomId !== roomId) return;
      socket.leave(publicPreviewSocketRoom(roomId));
      socket.data.publicPreviewRoomId = null;
    },
  ));

  socket.on(SOCKET_EVENTS.START_GAME, withSocketGuard(socket, SOCKET_EVENTS.START_GAME, () => handleAction(socket, startGame)));
  socket.on(SOCKET_EVENTS.REMOVE_PLAYER_FROM_LOBBY, withSocketGuard(socket, SOCKET_EVENTS.REMOVE_PLAYER_FROM_LOBBY, async (payload) => {
    const targetPlayerId = objectPayload(
      payload,
      socketPayloadKeys(SOCKET_EVENTS.REMOVE_PLAYER_FROM_LOBBY),
    ).playerId;
    const info = socketToPlayer.get(socket.id);
    const targetSocketIds = info ? socketIdsForPlayer(info.roomId, targetPlayerId) : [];
    await handleAction(
      socket,
      (state, playerId) => removeLobbyPlayer(state, playerId, targetPlayerId),
      { removePlayerId: targetPlayerId },
    );
    if (!info) return;
    clearDisconnectTimer(info.roomId, targetPlayerId);
    for (const targetSocketId of targetSocketIds) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      socketToPlayer.delete(targetSocketId);
      targetSocket?.leave(info.roomId);
      targetSocket?.emit(SOCKET_EVENTS.REMOVED_FROM_ROOM);
    }
  }));
  socket.on(SOCKET_EVENTS.UPDATE_ROOM_SETTINGS, withSocketGuard(
    socket,
    SOCKET_EVENTS.UPDATE_ROOM_SETTINGS,
    async (payload) => {
      const settings = objectPayload(
        payload,
        socketPayloadKeys(SOCKET_EVENTS.UPDATE_ROOM_SETTINGS),
      );
      const info = socketToPlayer.get(socket.id);
      await handleAction(socket, (state, playerId) => setRoomSettings(state, playerId, settings));
      if (!info) return;
      const latest = rooms.get(info.roomId);
      if (latest && !effectiveRoomSettings(latest).allowSpectators) {
        revokeRoomAccess(
          info.roomId,
          (candidate) => candidate.role === 'spectator',
          {
            reason: 'spectators_disabled',
            message: 'Les spectateurs ont été désactivés dans cette salle.',
          },
        );
      }
      if (latest && (
        latest.roomVisibility !== 'public'
        || !effectiveRoomSettings(latest).allowSpectators
      )) {
        revokePublicPreviewAccess(
          info.roomId,
          () => true,
          {
            code: latest.roomVisibility !== 'public'
              ? 'room_unavailable'
              : 'spectators_disabled',
            message: latest.roomVisibility !== 'public'
              ? 'Cette salle n’est plus publique.'
              : 'Les spectateurs ont été désactivés dans cette salle.',
          },
        );
      }
    },
  ));
  socket.on(SOCKET_EVENTS.TRANSFER_ROOM_OWNERSHIP, withSocketGuard(
    socket,
    SOCKET_EVENTS.TRANSFER_ROOM_OWNERSHIP,
    async (payload) => {
      const targetPlayerId = objectPayload(
        payload,
        socketPayloadKeys(SOCKET_EVENTS.TRANSFER_ROOM_OWNERSHIP),
      ).playerId;
      const info = socketToPlayer.get(socket.id);
      if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
      const targetMember = await findMemberByPlayer(info.roomId, targetPlayerId);
      if (!targetMember) throw new PublicError('invalid_target', 'Ce joueur n’est plus dans la salle.', 404);
      await handleAction(socket, (state, playerId) => {
        transferRoomOwnership(state, playerId, targetPlayerId);
        roomMeta.get(info.roomId).ownerUserId = targetMember.user_id;
      });
    },
  ));
  socket.on(SOCKET_EVENTS.KICK_ROOM_PLAYER, withSocketGuard(
    socket,
    SOCKET_EVENTS.KICK_ROOM_PLAYER,
    async (payload) => {
      const targetPlayerId = objectPayload(
        payload,
        socketPayloadKeys(SOCKET_EVENTS.KICK_ROOM_PLAYER),
      ).playerId;
      const info = socketToPlayer.get(socket.id);
      if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
      const targetSocketIds = socketIdsForPlayer(info.roomId, targetPlayerId);
      await handleAction(
        socket,
        (state, playerId) => kickRoomPlayer(state, playerId, targetPlayerId),
        { removePlayerId: targetPlayerId },
      );
      clearDisconnectTimer(info.roomId, targetPlayerId);
      revokeRoomAccess(
        info.roomId,
        (candidate) => candidate.role === 'player' && candidate.playerId === targetPlayerId,
        { reason: 'kicked', message: 'Le propriétaire vous a exclu de la salle.' },
      );
      for (const socketId of targetSocketIds) socketToPlayer.delete(socketId);
    },
  ));
  socket.on(SOCKET_EVENTS.BAN_ROOM_PLAYER, withSocketGuard(
    socket,
    SOCKET_EVENTS.BAN_ROOM_PLAYER,
    async (payload) => {
      const targetPlayerId = objectPayload(
        payload,
        socketPayloadKeys(SOCKET_EVENTS.BAN_ROOM_PLAYER),
      ).playerId;
      const info = socketToPlayer.get(socket.id);
      if (!info) throw new PublicError('not_in_room', "Vous ne faites partie d'aucune salle.", 403);
      const targetMember = await findMemberByPlayer(info.roomId, targetPlayerId);
      if (!targetMember) throw new PublicError('invalid_target', 'Ce joueur n’est plus dans la salle.', 404);
      await handleAction(
        socket,
        (state, playerId) => banRoomPlayer(
          state,
          playerId,
          targetPlayerId,
          targetMember.user_id,
        ),
        { removePlayerId: targetPlayerId },
      );
      clearDisconnectTimer(info.roomId, targetPlayerId);
      revokeRoomAccess(
        info.roomId,
        (candidate, targetSocket) => (
          (candidate.role === 'player' && candidate.playerId === targetPlayerId)
          || targetSocket?.data.auth?.user?.id === targetMember.user_id
        ),
        { reason: 'banned', message: 'Vous avez été banni de cette salle.' },
      );
      revokePublicPreviewAccess(
        info.roomId,
        (targetSocket) => targetSocket.data.auth?.user?.id === targetMember.user_id,
        { code: 'room_banned', message: 'Vous avez été banni de cette salle.' },
      );
    },
  ));
  socket.on(SOCKET_EVENTS.RETURN_TO_LOBBY, withSocketGuard(socket, SOCKET_EVENTS.RETURN_TO_LOBBY, () => handleAction(socket, returnToLobby)));
  socket.on(SOCKET_EVENTS.SET_GAME_MODE, withSocketGuard(socket, SOCKET_EVENTS.SET_GAME_MODE, (payload) => handleAction(socket, (s, p) => setGameMode(s, p, objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.SET_GAME_MODE)).gameMode))));
  socket.on(SOCKET_EVENTS.FLIP_INITIAL, withSocketGuard(socket, SOCKET_EVENTS.FLIP_INITIAL, (payload) => {
    const { slotIndex } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.FLIP_INITIAL));
    return handleTrackedHumanAction(
      socket,
      (s, p) => flipInitialCard(s, p, slotIndex),
      { type: 'initial_flip', decision: { slotIndex } },
    );
  }));
  socket.on(SOCKET_EVENTS.DRAW_CARD, withSocketGuard(socket, SOCKET_EVENTS.DRAW_CARD, (payload) => {
    const { source } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.DRAW_CARD));
    return handleTrackedHumanAction(
      socket,
      (s, p) => drawCard(s, p, source),
      { type: 'draw_source', decision: { source } },
    );
  }));
  socket.on(SOCKET_EVENTS.DECIDE_DRAWN, withSocketGuard(socket, SOCKET_EVENTS.DECIDE_DRAWN, (payload) => {
    const { keep } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.DECIDE_DRAWN));
    return handleTrackedHumanAction(
      socket,
      (s, p) => decideDrawnCard(s, p, keep),
      { type: 'drawn_card', decision: { keep } },
    );
  }));
  socket.on(SOCKET_EVENTS.KEEP_DRAWN_AND_PLACE, withSocketGuard(socket, SOCKET_EVENTS.KEEP_DRAWN_AND_PLACE, (payload) => {
    const { slotIndex } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.KEEP_DRAWN_AND_PLACE));
    return handleTrackedHumanAction(
      socket,
      (s, p) => keepDrawnAndPlace(s, p, slotIndex),
      { type: 'place_card', decision: { slotIndex, keepDrawn: true } },
    );
  }));
  socket.on(SOCKET_EVENTS.PLACE_CARD, withSocketGuard(socket, SOCKET_EVENTS.PLACE_CARD, (payload) => {
    const { slotIndex } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.PLACE_CARD));
    return handleTrackedHumanAction(
      socket,
      (s, p) => placeDrawnCard(s, p, slotIndex),
      { type: 'place_card', decision: { slotIndex } },
    );
  }));
  socket.on(SOCKET_EVENTS.REVEAL_CARD, withSocketGuard(socket, SOCKET_EVENTS.REVEAL_CARD, (payload) => {
    const { slotIndex } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.REVEAL_CARD));
    return handleTrackedHumanAction(
      socket,
      (s, p) => revealHiddenCard(s, p, slotIndex),
      { type: 'reveal_card', decision: { slotIndex } },
    );
  }));
  socket.on(SOCKET_EVENTS.PLAY_ACTION_CARD, withSocketGuard(socket, SOCKET_EVENTS.PLAY_ACTION_CARD, (payload) => {
    const { cardId } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.PLAY_ACTION_CARD));
    return handleTrackedHumanAction(
      socket,
      (s, p) => playOwnedAction(s, p, cardId),
      { type: 'play_action', decision: { cardId } },
    );
  }));
  socket.on(SOCKET_EVENTS.DISCARD_ACTION_CARD, withSocketGuard(socket, SOCKET_EVENTS.DISCARD_ACTION_CARD, (payload) => {
    const { cardId } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.DISCARD_ACTION_CARD));
    return handleTrackedHumanAction(
      socket,
      (s, p) => discardOwnedAction(s, p, cardId),
      { type: 'discard_action', decision: { cardId } },
    );
  }));
  socket.on(SOCKET_EVENTS.RESOLVE_ACTION, withSocketGuard(socket, SOCKET_EVENTS.RESOLVE_ACTION, (payload) => {
    const decision = actionPayload(payload);
    return handleTrackedHumanAction(
      socket,
      (s, p) => resolveActionInput(s, p, decision),
      { type: 'resolve_action', decision },
    );
  }));
  socket.on(SOCKET_EVENTS.RESOLVE_DEFENSE, withSocketGuard(socket, SOCKET_EVENTS.RESOLVE_DEFENSE, (payload) => {
    const { useDefense } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.RESOLVE_DEFENSE));
    return handleTrackedHumanAction(
      socket,
      (s, p) => resolveDefensePrompt(s, p, useDefense),
      { type: 'resolve_defense', decision: { useDefense } },
    );
  }));
  socket.on(SOCKET_EVENTS.RESOLVE_GROUP_CHOICE, withSocketGuard(socket, SOCKET_EVENTS.RESOLVE_GROUP_CHOICE, (payload) => {
    const { remove } = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.RESOLVE_GROUP_CHOICE));
    return handleTrackedHumanAction(
      socket,
      (s, p) => resolveGroupChoice(s, p, remove),
      { type: 'resolve_group', decision: { remove } },
    );
  }));
  socket.on(SOCKET_EVENTS.CLAIM_STAR_ACTION, withSocketGuard(socket, SOCKET_EVENTS.CLAIM_STAR_ACTION, (payload) => {
    const data = objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.CLAIM_STAR_ACTION));
    return handleTrackedHumanAction(
      socket,
      (s, p) => claimStarAction(s, p, data.source, data.marketIndex),
      { type: 'claim_star_action', decision: { source: data.source, marketIndex: data.marketIndex } },
    );
  }));
  socket.on(SOCKET_EVENTS.SEND_CHAT_MESSAGE, withSocketGuard(socket, SOCKET_EVENTS.SEND_CHAT_MESSAGE, (payload) => appendChatMessage(socket, objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.SEND_CHAT_MESSAGE)).text)));
  socket.on(SOCKET_EVENTS.LOAD_CHAT_HISTORY, withSocketGuard(socket, SOCKET_EVENTS.LOAD_CHAT_HISTORY, (payload) => sendChatHistory(socket, objectPayload(payload, socketPayloadKeys(SOCKET_EVENTS.LOAD_CHAT_HISTORY)).before)));

  socket.on(SOCKET_EVENTS.DISCONNECT, () => {
    if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
    const info = socketToPlayer.get(socket.id);
    socketToPlayer.delete(socket.id);
    if (info?.role === 'spectator') {
      broadcastRoom(info.roomId);
      return;
    }
    if (!info || socketIdsForPlayer(info.roomId, info.playerId).length) return;
    const key = connectionKey(info.roomId, info.playerId);
    clearDisconnectTimer(info.roomId, info.playerId);
    void mutateRoom(info.roomId, (draft) => removePlayer(draft, info.playerId))
      .then(({ state }) => {
        broadcastRoom(info.roomId);
        if (state.roomVisibility !== 'public'
          || socketIdsForPlayer(info.roomId, info.playerId).length) {
          return;
        }
        const timer = setTimeout(async () => {
          disconnectTimers.delete(key);
          if (socketIdsForPlayer(info.roomId, info.playerId).length) return;
          try {
            let leavingPlayerName = '';
            const { state: nextState } = await mutateRoom(info.roomId, async (draft) => {
              leavingPlayerName = normalizePlayerName(draft.playersById[info.playerId]?.name);
              leavePlayer(draft, info.playerId);
              if (draft.creatorId) {
                const nextOwner = await findMemberByPlayer(info.roomId, draft.creatorId);
                if (nextOwner) roomMeta.get(info.roomId).ownerUserId = nextOwner.user_id;
              }
            }, { removePlayerId: info.playerId });
            broadcastRoom(info.roomId);
            scheduleNextRound(info.roomId, nextState);
            scheduleDefensePrompt(info.roomId, nextState);
            if (leavingPlayerName) {
              await safelyAppendSystemChatMessage(info.roomId, `${leavingPlayerName} a quitté la salle.`);
            }
          } catch (error) { logInternal('disconnect_cleanup', error); }
        }, PUBLIC_ROOM_DISCONNECT_GRACE_MS);
        timer.unref?.();
        disconnectTimers.set(key, timer);
      })
      .catch((error) => logInternal('disconnect_mark_offline', error));
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
    console.log(`Skyjo server v${SOCKET_PROTOCOL_VERSION} listening on ${HOST}:${PORT}`);
  });
}
