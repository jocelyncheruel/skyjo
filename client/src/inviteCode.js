export const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{16}$/;

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
