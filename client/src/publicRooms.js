export function canJoinPublicRoomMetadata(room) {
  return room?.phase === 'lobby'
    && room.locked !== true
    && Number(room.playerCount) < Number(room.maxPlayers);
}

export function isPublicRoomAvailable(room) {
  return room?.allowSpectators !== false || canJoinPublicRoomMetadata(room);
}

export function publicRoomSelectionMode(room) {
  if (!isPublicRoomAvailable(room)) return 'unavailable';
  return room.allowSpectators === false ? 'join' : 'preview';
}
