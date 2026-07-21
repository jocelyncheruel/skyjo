export const CONNECTION_INTERRUPTED_MESSAGE = 'Connexion au serveur interrompue.';

const TECHNICAL_CONNECT_ERROR_PATTERN = /xhr (?:poll|post) error|websocket error|websocket is closed|polling error|transport (?:error|close)|network error|failed to fetch|fetch failed|connection (?:error|timeout|timed out)|connect(?:ion)? timed out|socket hang up|unexpected server response|econn(?:refused|reset|aborted)|enotfound|eai_again|net::err_|^timeout$/iu;

export function connectErrorUserMessage(error) {
  const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';
  const errorType = typeof error?.type === 'string' ? error.type.trim() : '';

  if (
    !rawMessage
    || /transporterror/iu.test(errorType)
    || TECHNICAL_CONNECT_ERROR_PATTERN.test(rawMessage)
  ) {
    return CONNECTION_INTERRUPTED_MESSAGE;
  }

  return rawMessage;
}
