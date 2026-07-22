export const ROOM_CODE_PATTERN = /^[0-9]{6}$/;

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
