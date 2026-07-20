import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_PROTOCOL_VERSION = 8;
export const ROOM_SCHEMA_VERSION = 3;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const CONSENT_VERSION = '2026-07-15-bff';
export const MAX_PLAYER_NAME_LENGTH = 20;
export const MAX_CHAT_LENGTH = 280;

const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;

export class PublicError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PublicError';
    this.code = code;
    this.status = status;
  }
}

export function requestId() {
  return randomUUID();
}

export function normalizeOrigin(origin, { production = false } = {}) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (production && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function clientIpFromForwarded(forwarded, fallback) {
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const candidate = forwarded.split(',').at(-1)?.trim();
    if (candidate && candidate.length <= 64 && isIP(candidate)) return candidate;
  }
  const safeFallback = String(fallback || '').trim();
  return safeFallback.length <= 64 && isIP(safeFallback) ? safeFallback : 'unknown';
}

export function normalizeRoomId(value) {
  const roomId = String(value || '').trim();
  return /^[0-9]{6}$/.test(roomId) ? roomId : '';
}

export function normalizePlayerId(value) {
  const playerId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{10,40}$/.test(playerId) ? playerId : '';
}

export function normalizeVisibleText(value, maxLength, { collapseWhitespace = true } = {}) {
  let text = String(value || '').normalize('NFKC')
    .replace(/[\u0009-\u000D]/gu, ' ')
    .replace(CONTROL_OR_BIDI, '');
  if (collapseWhitespace) text = text.replace(/\s+/gu, ' ');
  text = text.trim();
  return [...text].slice(0, maxLength).join('');
}

export function normalizePlayerName(value) {
  return normalizeVisibleText(value, MAX_PLAYER_NAME_LENGTH);
}

export function normalizeChatMessage(value) {
  const text = normalizeVisibleText(value, MAX_CHAT_LENGTH);
  if (!text || Buffer.byteLength(text, 'utf8') > 1120) return '';
  return text;
}

export function objectPayload(value, allowedKeys = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicError('invalid_payload', 'Données invalides.', 400);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PublicError('invalid_payload', 'Données invalides.', 400);
  }
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new PublicError('invalid_payload', 'Données invalides.', 400);
    }
  }
  return value;
}

export function decodeVerifiedJwtClaims(token) {
  try {
    const [, encoded] = String(token || '').split('.');
    if (!encoded) return null;
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!claims || typeof claims !== 'object') return null;
    if (!/^[0-9a-f-]{36}$/i.test(String(claims.sub || ''))) return null;
    if (!/^[0-9a-f-]{36}$/i.test(String(claims.session_id || ''))) return null;
    if (!Number.isSafeInteger(claims.exp)) return null;
    return {
      sub: claims.sub,
      sessionId: claims.session_id,
      exp: claims.exp,
      role: claims.role,
    };
  } catch {
    return null;
  }
}

export function isConfirmedUser(user) {
  return Boolean(user?.id && (user.email_confirmed_at || user.confirmed_at));
}

export function isValidRoomState(state, roomId) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.roomId !== roomId) return false;
  if (state.schemaVersion !== ROOM_SCHEMA_VERSION) return false;
  if (!Array.isArray(state.order) || state.order.length > 8) return false;
  if (!state.playersById || typeof state.playersById !== 'object' || Array.isArray(state.playersById)) return false;
  if (!['private', 'public'].includes(state.roomVisibility || 'private')) return false;
  if (!Number.isSafeInteger(state.gameSerial ?? 0) || (state.gameSerial ?? 0) < 0) return false;
  if (new Set(state.order).size !== state.order.length) return false;
  if (Object.keys(state.playersById).length !== state.order.length) return false;
  if (!Array.isArray(state.deck) || state.deck.length > 200) return false;
  if (!Array.isArray(state.discard) || state.discard.length > 200) return false;
  if (state.log && (!Array.isArray(state.log) || state.log.length > 100)) return false;
  return state.order.every((id) => {
    const player = state.playersById[id];
    if (!normalizePlayerId(id) || player?.id !== id) return false;
    if (!normalizePlayerName(player.name)) return false;
    if (!Array.isArray(player.board) || player.board.length !== 12) return false;
    return player.board.every((slot) => slot && typeof slot === 'object' && !Array.isArray(slot));
  });
}

export function publicErrorPayload(error, id = requestId()) {
  if (error instanceof PublicError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message }, requestId: id } };
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Une erreur interne est survenue.' }, requestId: id },
  };
}
