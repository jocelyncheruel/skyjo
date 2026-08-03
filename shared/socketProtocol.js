export const SOCKET_PROTOCOL_VERSION = 15;

export const SOCKET_EVENTS = Object.freeze({
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  CONNECT_ERROR: 'connect_error',
  ERROR: 'errorMsg',
  JOINED: 'joined',
  STATE: 'state',
  SPECTATOR_STATE: 'spectatorState',
  PUBLIC_PREVIEW_STATE: 'publicPreviewState',
  CHAT_HISTORY: 'chatHistory',
  CHAT_MESSAGE: 'chatMessage',
  ROOM_EXPIRED: 'roomExpired',
  REMOVED_FROM_ROOM: 'removedFromRoom',
  ROOM_ACCESS_REVOKED: 'roomAccessRevoked',
  JOIN_ROOM: 'joinRoom',
  LEAVE_ROOM: 'leaveRoom',
  SUBSCRIBE_PUBLIC_PREVIEW: 'subscribePublicPreview',
  UNSUBSCRIBE_PUBLIC_PREVIEW: 'unsubscribePublicPreview',
  START_GAME: 'startGame',
  REMOVE_PLAYER_FROM_LOBBY: 'removePlayerFromLobby',
  UPDATE_ROOM_SETTINGS: 'updateRoomSettings',
  TRANSFER_ROOM_OWNERSHIP: 'transferRoomOwnership',
  KICK_ROOM_PLAYER: 'kickRoomPlayer',
  BAN_ROOM_PLAYER: 'banRoomPlayer',
  RETURN_TO_LOBBY: 'returnToLobby',
  SET_GAME_MODE: 'setGameMode',
  FLIP_INITIAL: 'flipInitial',
  DRAW_CARD: 'drawCard',
  DECIDE_DRAWN: 'decideDrawn',
  KEEP_DRAWN_AND_PLACE: 'keepDrawnAndPlace',
  PLACE_CARD: 'placeCard',
  REVEAL_CARD: 'revealCard',
  PLAY_ACTION_CARD: 'playActionCard',
  DISCARD_ACTION_CARD: 'discardActionCard',
  RESOLVE_ACTION: 'resolveAction',
  RESOLVE_DEFENSE: 'resolveDefense',
  RESOLVE_GROUP_CHOICE: 'resolveGroupChoice',
  CLAIM_STAR_ACTION: 'claimStarAction',
  SEND_CHAT_MESSAGE: 'sendChatMessage',
  LOAD_CHAT_HISTORY: 'loadChatHistory',
});

export const SOCKET_HANDSHAKE_KEYS = Object.freeze([
  'protocolVersion',
  'roomId',
  'playerName',
  'roomRole',
]);

export const SOCKET_CLIENT_PAYLOAD_KEYS = Object.freeze({
  [SOCKET_EVENTS.JOIN_ROOM]: Object.freeze(['roomId', 'playerName', 'role']),
  [SOCKET_EVENTS.LEAVE_ROOM]: Object.freeze([]),
  [SOCKET_EVENTS.SUBSCRIBE_PUBLIC_PREVIEW]: Object.freeze(['roomId']),
  [SOCKET_EVENTS.UNSUBSCRIBE_PUBLIC_PREVIEW]: Object.freeze(['roomId']),
  [SOCKET_EVENTS.START_GAME]: Object.freeze([]),
  [SOCKET_EVENTS.REMOVE_PLAYER_FROM_LOBBY]: Object.freeze(['playerId']),
  [SOCKET_EVENTS.UPDATE_ROOM_SETTINGS]: Object.freeze([
    'maxPlayers',
    'roomVisibility',
    'locked',
    'allowSpectators',
    'chatEnabled',
    'gameEndMode',
    'scoreTarget',
    'roundLimit',
  ]),
  [SOCKET_EVENTS.TRANSFER_ROOM_OWNERSHIP]: Object.freeze(['playerId']),
  [SOCKET_EVENTS.KICK_ROOM_PLAYER]: Object.freeze(['playerId']),
  [SOCKET_EVENTS.BAN_ROOM_PLAYER]: Object.freeze(['playerId']),
  [SOCKET_EVENTS.RETURN_TO_LOBBY]: Object.freeze([]),
  [SOCKET_EVENTS.SET_GAME_MODE]: Object.freeze(['gameMode']),
  [SOCKET_EVENTS.FLIP_INITIAL]: Object.freeze(['slotIndex']),
  [SOCKET_EVENTS.DRAW_CARD]: Object.freeze(['source']),
  [SOCKET_EVENTS.DECIDE_DRAWN]: Object.freeze(['keep']),
  [SOCKET_EVENTS.KEEP_DRAWN_AND_PLACE]: Object.freeze(['slotIndex']),
  [SOCKET_EVENTS.PLACE_CARD]: Object.freeze(['slotIndex']),
  [SOCKET_EVENTS.REVEAL_CARD]: Object.freeze(['slotIndex']),
  [SOCKET_EVENTS.PLAY_ACTION_CARD]: Object.freeze(['cardId']),
  [SOCKET_EVENTS.DISCARD_ACTION_CARD]: Object.freeze(['cardId']),
  [SOCKET_EVENTS.RESOLVE_ACTION]: Object.freeze([
    'draft', 'targetPlayerId', 'slotIndex', 'actionCardId', 'slots',
    'choiceIndex', 'revealSlot', 'firstSlotIndex', 'secondSlotIndex',
    'groupType', 'cardId', 'first', 'second',
  ]),
  [SOCKET_EVENTS.RESOLVE_DEFENSE]: Object.freeze(['useDefense']),
  [SOCKET_EVENTS.RESOLVE_GROUP_CHOICE]: Object.freeze(['remove']),
  [SOCKET_EVENTS.CLAIM_STAR_ACTION]: Object.freeze(['source', 'marketIndex']),
  [SOCKET_EVENTS.SEND_CHAT_MESSAGE]: Object.freeze(['text']),
  [SOCKET_EVENTS.LOAD_CHAT_HISTORY]: Object.freeze(['before']),
});

export const SOCKET_ACTION_DRAFT_KEYS = Object.freeze([
  'slots', 'choiceIndex', 'peekFirst', 'targets', 'stealTargetId', 'targetPlayerId',
]);

export const SOCKET_PEEK_FIRST_KEYS = Object.freeze(['playerId', 'slotIndex']);

export const SOCKET_SERVER_PAYLOAD_KEYS = Object.freeze({
  [SOCKET_EVENTS.ERROR]: Object.freeze(['code', 'message', 'requestId', 'retryAfter']),
  [SOCKET_EVENTS.JOINED]: Object.freeze(['roomId', 'playerId', 'role']),
  [SOCKET_EVENTS.CHAT_HISTORY]: Object.freeze(['messages', 'hasMore', 'before']),
  [SOCKET_EVENTS.CHAT_MESSAGE]: Object.freeze([
    'id', 't', 'type', 'playerId', 'playerName', 'text',
  ]),
  [SOCKET_EVENTS.ROOM_ACCESS_REVOKED]: Object.freeze(['reason', 'message']),
});

export function socketPayloadKeys(eventName) {
  return SOCKET_CLIENT_PAYLOAD_KEYS[eventName] || null;
}

function validatedSocketPayload(definitions, direction, eventName, payload) {
  const allowedKeys = definitions[eventName];
  if (!allowedKeys) throw new TypeError(`Événement Socket.IO ${direction} inconnu : ${eventName}`);
  if (allowedKeys.length === 0) {
    if (payload !== undefined) throw new TypeError(`Payload inattendu pour ${eventName}`);
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError(`Payload invalide pour ${eventName}`);
  }
  const allowed = new Set(allowedKeys);
  if (Object.keys(payload).some((key) => !allowed.has(key))) {
    throw new TypeError(`Champ de payload inconnu pour ${eventName}`);
  }
  return payload;
}

export function socketClientPayload(eventName, payload) {
  return validatedSocketPayload(
    SOCKET_CLIENT_PAYLOAD_KEYS,
    'client',
    eventName,
    payload,
  );
}

export function socketServerPayload(eventName, payload) {
  return validatedSocketPayload(
    SOCKET_SERVER_PAYLOAD_KEYS,
    'serveur',
    eventName,
    payload,
  );
}
