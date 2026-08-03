import { useEffect, useRef } from 'react';

export function useChatHistoryReload({ roomId, enabled, onReload }) {
  const previousRef = useRef({ roomId, enabled });

  useEffect(() => {
    const previous = previousRef.current;
    if (previous.roomId === roomId && previous.enabled === false && enabled === true) {
      onReload();
    }
    previousRef.current = { roomId, enabled };
  }, [enabled, onReload, roomId]);
}
