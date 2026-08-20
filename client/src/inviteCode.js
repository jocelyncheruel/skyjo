export const ROOM_CODE_PATTERN = /^[0-9]{6}$/;
const PENDING_ROOM_INVITE_KEY = 'skyjo_pending_room_invite';
const PENDING_ROOM_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export function createRoomInviteUrl(roomCode, origin) {
  const code = String(roomCode || '').trim();
  if (!ROOM_CODE_PATTERN.test(code)) return '';

  try {
    const inviteUrl = new URL('/', origin);
    inviteUrl.hash = new URLSearchParams({ room: code }).toString();
    return inviteUrl.toString();
  } catch {
    return '';
  }
}

export function extractRoomCodeFromInvite(value) {
  const input = String(value || '').trim();
  if (input.length > 512) return '';
  if (ROOM_CODE_PATTERN.test(input)) return input;

  try {
    const inviteUrl = new URL(input, 'https://skyjo.invalid/');
    const fragment = new URLSearchParams(inviteUrl.hash.replace(/^#/, ''));
    const candidate = fragment.get('room') || inviteUrl.searchParams.get('room') || '';
    return ROOM_CODE_PATTERN.test(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

export function rememberRoomInvite(roomCode, storage = globalThis.localStorage) {
  const code = extractRoomCodeFromInvite(roomCode);
  if (!code || !storage) return '';
  try {
    storage.setItem(PENDING_ROOM_INVITE_KEY, JSON.stringify({
      roomId: code,
      expiresAt: Date.now() + PENDING_ROOM_INVITE_TTL_MS,
    }));
  } catch {
    return code;
  }
  return code;
}

export function readRememberedRoomInvite(storage = globalThis.localStorage) {
  if (!storage) return '';
  try {
    const pending = JSON.parse(storage.getItem(PENDING_ROOM_INVITE_KEY) || 'null');
    if (!ROOM_CODE_PATTERN.test(pending?.roomId || '') || pending.expiresAt <= Date.now()) {
      storage.removeItem(PENDING_ROOM_INVITE_KEY);
      return '';
    }
    return pending.roomId;
  } catch {
    try { storage.removeItem(PENDING_ROOM_INVITE_KEY); } catch { /* Storage indisponible. */ }
    return '';
  }
}

export function clearRememberedRoomInvite(roomCode, storage = globalThis.localStorage) {
  if (!storage) return;
  const rememberedRoomId = readRememberedRoomInvite(storage);
  if (!roomCode || rememberedRoomId === roomCode) {
    try { storage.removeItem(PENDING_ROOM_INVITE_KEY); } catch { /* Storage indisponible. */ }
  }
}
