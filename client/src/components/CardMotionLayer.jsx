import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Card from './Card.jsx';

const MOTION_MIN_DURATION_MS = 480;
const MOTION_MAX_DURATION_MS = 720;
const MOTION_STAGGER_MS = 55;
const MOTION_HANDOFF_PROGRESS = 0.84;
const MOTION_FLIP_DURATION_MS = 320;

function boardAnchor(playerId, slotIndex) {
  return `board:${playerId}:${slotIndex}`;
}

function pileAnchor(source) {
  return `pile:${source}`;
}

function slotSignature(slot) {
  return [
    slot?.cardId || '',
    slot?.faceUp ? 'up' : 'down',
    slot?.removed ? 'removed' : 'present',
    slot?.value ?? '',
    slot?.kind || '',
  ].join('|');
}

function cardVisual(card, faceUp = true) {
  if (!card) return { faceUp: false, value: null, kind: 'number' };
  return {
    id: card.id || card.cardId || '',
    faceUp,
    value: card.value ?? null,
    kind: card.kind || 'number',
  };
}

function slotVisual(slot) {
  return cardVisual(slot, !!slot?.faceUp);
}

function playersById(state) {
  return new Map((state?.players || []).map((player) => [player.id, player]));
}

function stateCardMoves(state) {
  if (Array.isArray(state?.cardMoves) && state.cardMoves.length > 0) {
    return state.cardMoves.filter((move) => move?.id);
  }
  return state?.lastCardMove?.id ? [state.lastCardMove] : [];
}

function freshCardMoves(previousState, nextState) {
  const previousIds = new Set(stateCardMoves(previousState).map((move) => move.id));
  return stateCardMoves(nextState).filter((move) => !previousIds.has(move.id));
}

function changedSlots(previousState, nextState, playerId) {
  const previousPlayer = playersById(previousState).get(playerId);
  const nextPlayer = playersById(nextState).get(playerId);
  if (!previousPlayer || !nextPlayer) return [];

  return nextPlayer.board.flatMap((nextSlot, slotIndex) => {
    const previousSlot = previousPlayer.board[slotIndex];
    if (slotSignature(previousSlot) === slotSignature(nextSlot)) return [];
    return [{ playerId, slotIndex, previousSlot, nextSlot }];
  });
}

function allChangedSlots(previousState, nextState) {
  return (nextState?.players || []).flatMap((player) => (
    changedSlots(previousState, nextState, player.id)
  ));
}

function addMotion(motions, seen, motion) {
  if (!motion?.from || !motion?.to || motion.from === motion.to) return;
  const key = `${motion.from}>${motion.to}:${motion.card?.id || ''}:${motion.card?.value ?? ''}:${motion.card?.faceUp}`;
  if (seen.has(key)) return;
  seen.add(key);
  motions.push(motion);
}

function addKnownBoardMoves(previousState, nextState, motions, seen, cardMoves) {
  const swapMoves = cardMoves.filter((cardMove) => (
    cardMove.type === 'swap' && Array.isArray(cardMove.moves)
  ));
  if (swapMoves.length > 0) {
    let swapIndex = 0;
    for (const cardMove of swapMoves) {
      cardMove.moves.forEach((move) => {
        const destinationSlot = playersById(nextState)
          .get(move.toPlayerId)?.board?.[move.toSlotIndex];
        addMotion(motions, seen, {
          from: boardAnchor(move.fromPlayerId, move.fromSlotIndex),
          to: boardAnchor(move.toPlayerId, move.toSlotIndex),
          card: cardVisual(move.card, !!move.faceUp),
          tone: 'swap',
          stack: swapIndex % 2 === 0 ? 'front' : 'back',
          clearedOnArrival: !!destinationSlot?.removed,
        });
        swapIndex += 1;
      });
    }
    return;
  }

  const previousLocations = new Map();
  const nextLocations = new Map();
  let swapIndex = 0;

  for (const player of previousState.players || []) {
    player.board.forEach((slot, slotIndex) => {
      if (slot?.cardId) previousLocations.set(slot.cardId, {
        anchor: boardAnchor(player.id, slotIndex),
        card: slotVisual(slot),
      });
    });
  }

  for (const player of nextState.players || []) {
    player.board.forEach((slot, slotIndex) => {
      if (slot?.cardId) nextLocations.set(slot.cardId, boardAnchor(player.id, slotIndex));
    });
  }

  for (const [cardId, previousLocation] of previousLocations) {
    const nextLocation = nextLocations.get(cardId);
    if (!nextLocation || nextLocation === previousLocation.anchor) continue;
    addMotion(motions, seen, {
      from: previousLocation.anchor,
      to: nextLocation,
      card: previousLocation.card,
      tone: 'swap',
      stack: swapIndex % 2 === 0 ? 'front' : 'back',
    });
    swapIndex += 1;
  }
}

function addDrawResolution(previousState, nextState, motions, seen, cardMoves) {
  const drawn = previousState.drawnCard;
  if (!drawn || nextState.drawnCard) return;

  const source = pileAnchor(drawn.from || 'deck');
  const actorId = previousState.currentPlayerId;
  const changes = changedSlots(previousState, nextState, actorId);
  const drawnId = drawn.card?.id || '';
  const recordedMove = [...cardMoves].reverse().find((cardMove) => (
    (!cardMove.type || cardMove.type === 'placement')
    && cardMove.playerId === actorId
  )) || null;
  const recordedDestination = recordedMove
    ? changes.find(({ slotIndex }) => slotIndex === recordedMove.slotIndex)
    : null;
  const destination = recordedDestination || (drawnId
    ? changes.find(({ nextSlot }) => nextSlot?.cardId === drawnId)
    : changes.find(({ nextSlot }) => nextSlot?.faceUp && !nextSlot?.removed));

  if (!destination) {
    if (slotSignature(previousState.discardTop) !== slotSignature(nextState.discardTop)) {
      addMotion(motions, seen, {
        from: source,
        to: pileAnchor('discard'),
        card: cardVisual(drawn.card || nextState.discardTop, true),
        tone: 'discard',
      });
    }
    return;
  }

  const destinationAnchor = boardAnchor(actorId, destination.slotIndex);
  const placedCard = recordedMove?.newCard
    ? cardVisual(recordedMove.newCard, true)
    : slotVisual(destination.nextSlot);
  const handoffGroup = `draw:${actorId}:${destination.slotIndex}:${placedCard.id || drawnId || 'hidden'}`;
  if (destination.previousSlot && !destination.previousSlot.removed) {
    const revealedOldCard = recordedMove?.oldCard
      ? cardVisual(recordedMove.oldCard, true)
      : null;
    const revealBeforeMove = !destination.previousSlot.faceUp && !!revealedOldCard;
    addMotion(motions, seen, {
      from: destinationAnchor,
      to: pileAnchor('discard'),
      card: revealBeforeMove
        ? revealedOldCard
        : slotVisual(destination.previousSlot),
      tone: 'discard',
      handoffGroup,
      handoffRole: 'outgoing',
      flipBeforeMove: revealBeforeMove,
    });
  }
  addMotion(motions, seen, {
    from: source,
    to: destinationAnchor,
    card: placedCard,
    tone: 'place',
    handoffGroup,
    handoffRole: 'incoming',
    clearedOnArrival: !!destination.nextSlot?.removed,
  });
}

function addActionReplacement(previousState, nextState, motions, seen, cardMoves) {
  if (previousState.drawnCard) return;
  const replacementMoves = cardMoves.filter((cardMove) => cardMove.type === 'replacement');
  if (replacementMoves.length > 0) {
    for (const cardMove of replacementMoves) {
      const previousPlayer = playersById(previousState).get(cardMove.playerId);
      const nextPlayer = playersById(nextState).get(cardMove.playerId);
      const previousSlot = previousPlayer?.board?.[cardMove.slotIndex];
      const nextSlot = nextPlayer?.board?.[cardMove.slotIndex];
      if (!previousSlot || !nextSlot) continue;

      const target = boardAnchor(cardMove.playerId, cardMove.slotIndex);
      const placedCard = cardVisual(cardMove.newCard || nextSlot, true);
      const handoffGroup = `action:${cardMove.playerId}:${cardMove.slotIndex}:${placedCard.id || 'hidden'}`;
      if (!previousSlot.removed) {
        const revealBeforeMove = !previousSlot.faceUp
          && !!cardMove.oldCard
          && !!cardMove.revealOldCard;
        addMotion(motions, seen, {
          from: target,
          to: pileAnchor('discard'),
          card: cardMove.oldCard
            ? cardVisual(cardMove.oldCard, previousSlot.faceUp || revealBeforeMove)
            : slotVisual(previousSlot),
          tone: 'discard',
          handoffGroup,
          handoffRole: 'outgoing',
          flipBeforeMove: revealBeforeMove,
        });
      }
      addMotion(motions, seen, {
        from: pileAnchor(cardMove.source || 'deck'),
        to: target,
        card: placedCard,
        tone: 'place',
        handoffGroup,
        handoffRole: 'incoming',
        clearedOnArrival: !!nextSlot.removed,
      });
    }
    return;
  }

  const pendingType = previousState.pendingAction?.type;
  if (!['removeEach', 'drawThree'].includes(pendingType)) return;
  const drawnCardIds = new Set(
    (previousState.pendingAction?.drawn || []).map((card) => card.id).filter(Boolean),
  );

  const replacements = allChangedSlots(previousState, nextState)
    .filter(({ previousSlot, nextSlot }) => (
      !previousSlot?.removed
      && !nextSlot?.removed
      && nextSlot?.faceUp
      && previousSlot?.cardId !== nextSlot?.cardId
      && (pendingType !== 'drawThree' || drawnCardIds.has(nextSlot?.cardId))
    ));

  for (const replacement of replacements) {
    const target = boardAnchor(replacement.playerId, replacement.slotIndex);
    const handoffGroup = `action:${replacement.playerId}:${replacement.slotIndex}:${replacement.nextSlot?.cardId || 'hidden'}`;
    if (pendingType === 'removeEach') {
      addMotion(motions, seen, {
        from: target,
        to: pileAnchor('discard'),
        card: slotVisual(replacement.previousSlot),
        tone: 'discard',
        handoffGroup,
        handoffRole: 'outgoing',
      });
    }
    addMotion(motions, seen, {
      from: pileAnchor('deck'),
      to: target,
      card: slotVisual(replacement.nextSlot),
      tone: 'place',
      handoffGroup,
      handoffRole: 'incoming',
    });
  }
}

function addDrawThreeDiscards(motions, seen, cardMoves) {
  const resolutionMoves = cardMoves.filter((cardMove) => (
    ['replacement', 'reveal'].includes(cardMove.type)
    && Array.isArray(cardMove.discardedCards)
    && cardMove.discardedCards.length > 0
    && cardMove.animateDiscardedCards !== false
  ));

  for (const cardMove of resolutionMoves) {
    cardMove.discardedCards.forEach((card, index) => {
      addMotion(motions, seen, {
        from: pileAnchor('deck'),
        to: pileAnchor('discard'),
        card: cardVisual(card, true),
        tone: 'discard',
        delay: index * MOTION_STAGGER_MS,
        afterPlacement: cardMove.type === 'replacement',
      });
    });
  }
}

function addRemovedCards(previousState, nextState, motions, seen, cardMoves) {
  const revealedCards = new Map();
  const clearedCards = new Map();
  const clearOrder = new Map();
  let clearIndex = 0;

  for (const cardMove of cardMoves) {
    if (!['reveal', 'roundReveal', 'clear'].includes(cardMove.type)) continue;
    for (const entry of cardMove.cards || []) {
      const key = `${entry.playerId}:${entry.slotIndex}`;
      if (['reveal', 'roundReveal'].includes(cardMove.type)) {
        revealedCards.set(key, entry.card);
      }
      if (cardMove.type === 'clear') {
        clearedCards.set(key, entry.card);
        clearOrder.set(key, clearIndex);
        clearIndex += 1;
      }
    }
  }

  const removedCards = allChangedSlots(previousState, nextState)
    .filter(({ previousSlot, nextSlot }) => !previousSlot?.removed && nextSlot?.removed);
  removedCards.sort((first, second) => {
    const firstOrder = clearOrder.get(`${first.playerId}:${first.slotIndex}`);
    const secondOrder = clearOrder.get(`${second.playerId}:${second.slotIndex}`);
    if (firstOrder == null && secondOrder == null) return 0;
    if (firstOrder == null) return 1;
    if (secondOrder == null) return -1;
    return firstOrder - secondOrder;
  });

  removedCards.forEach((removedCard, index) => {
    const source = boardAnchor(removedCard.playerId, removedCard.slotIndex);
    const placedCard = motions.find((motion) => (
      motion.to === source
      && motion.clearedOnArrival
    ));
    const key = `${removedCard.playerId}:${removedCard.slotIndex}`;
    const revealedCard = revealedCards.get(key);
    const clearedCard = clearedCards.get(key);
    const recordedCard = clearedCard || revealedCard;
    addMotion(motions, seen, {
      from: source,
      to: pileAnchor('discard'),
      card: placedCard?.card
        || (recordedCard ? cardVisual(recordedCard, true) : slotVisual(removedCard.previousSlot)),
      tone: 'clear',
      delay: index * MOTION_STAGGER_MS,
      clearAfterPlacement: !!placedCard,
      flipBeforeMove: !placedCard && !removedCard.previousSlot.faceUp && !!recordedCard,
    });
  });
}

function buildCardMotions(previousState, nextState) {
  if (!previousState || !nextState || previousState.roomId !== nextState.roomId) return [];
  if (previousState.roundNumber !== nextState.roundNumber || previousState.phase !== 'playing') return [];

  const motions = [];
  const seen = new Set();
  const cardMoves = freshCardMoves(previousState, nextState);
  addKnownBoardMoves(previousState, nextState, motions, seen, cardMoves);
  addDrawResolution(previousState, nextState, motions, seen, cardMoves);
  addActionReplacement(previousState, nextState, motions, seen, cardMoves);
  addDrawThreeDiscards(motions, seen, cardMoves);
  addRemovedCards(previousState, nextState, motions, seen, cardMoves);
  const previousDiscard = previousState.discardTop
    ? cardVisual(previousState.discardTop, true)
    : null;
  if (previousDiscard) {
    for (const motion of motions) {
      if (motion.to === pileAnchor('discard')) motion.targetCard = previousDiscard;
    }
  }
  return motions;
}

function findAnchor(anchor, anchorRoot) {
  const root = anchorRoot || document;
  return [...root.querySelectorAll('[data-sj-card-anchor]')]
    .find((element) => element.dataset.sjCardAnchor === anchor) || null;
}

function measuredFlight(specification, sequence, anchorRoot) {
  const source = findAnchor(specification.from, anchorRoot);
  const destination = findAnchor(specification.to, anchorRoot);
  if (!source || !destination) return null;

  const from = source.getBoundingClientRect();
  const to = destination.getBoundingClientRect();
  if (!from.width || !from.height || !to.width || !to.height) return null;

  const deltaX = to.left - from.left;
  const deltaY = to.top - from.top;
  const distance = Math.hypot(deltaX, deltaY);
  const duration = Math.round(Math.min(
    MOTION_MAX_DURATION_MS,
    Math.max(MOTION_MIN_DURATION_MS, 420 + distance * 0.42),
  ));
  const delay = specification.delay || 0;

  return {
    ...specification,
    id: `card-flight-${sequence}`,
    destination,
    destinationRect: to,
    from,
    deltaX,
    deltaY,
    path: `path("M 0 0 L ${deltaX.toFixed(2)} ${deltaY.toFixed(2)}")`,
    scaleX: to.width / from.width,
    scaleY: to.height / from.height,
    duration,
    delay,
  };
}

function flightArrivalTime(flight) {
  const progress = flight.lateHandoff ? 1 : MOTION_HANDOFF_PROGRESS;
  return flight.delay + Math.round(flight.duration * progress);
}

function prepareDestinationSnapshots(flights) {
  const flightsByDestination = new Map();
  for (const flight of flights) {
    const group = flightsByDestination.get(flight.destination) || [];
    group.push(flight);
    flightsByDestination.set(flight.destination, group);
  }

  for (const group of flightsByDestination.values()) {
    group.sort((first, second) => flightArrivalTime(first) - flightArrivalTime(second));
    const initialTarget = group.find((flight) => flight.targetCard)?.targetCard || null;
    for (const flight of group) flight.targetCard = null;
    if (initialTarget) group[0].targetCard = initialTarget;

    for (let index = 0; index < group.length - 1; index += 1) {
      const current = group[index];
      const next = group[index + 1];
      const settledAt = flightArrivalTime(current);
      current.settledCard = current.card;
      current.settledDelay = settledAt;
      current.settledDuration = Math.max(1, flightArrivalTime(next) - settledAt);
    }
  }

  return flightsByDestination;
}

export default function CardMotionLayer({ state, enabled, onMotionBatch, anchorRootRef, layerClassName = '' }) {
  const previousStateRef = useRef(state);
  const sequenceRef = useRef(0);
  const timersRef = useRef(new Set());
  const destinationsRef = useRef(new Set());
  const [flights, setFlights] = useState([]);

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    for (const destination of destinationsRef.current) {
      destination.classList.remove('sj-card-motion-destination');
      destination.classList.remove('sj-card-motion-destination-late');
      delete destination.dataset.sjCardMotionBatch;
      destination.style.removeProperty('--sj-card-arrival-duration');
      destination.style.removeProperty('--sj-card-arrival-delay');
    }
  }, []);

  useLayoutEffect(() => {
    const previousState = previousStateRef.current;
    if (!enabled) return;

    previousStateRef.current = state;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    const specifications = buildCardMotions(previousState, state);
    if (!specifications.length) return;

    const batch = `${Date.now()}-${++sequenceRef.current}`;
    const nextFlights = specifications
      .map((specification, index) => measuredFlight(
        specification,
        `${sequenceRef.current}-${index}`,
        anchorRootRef?.current,
      ))
      .filter(Boolean);
    const incomingByHandoff = new Map(
      nextFlights
        .filter((flight) => flight.handoffRole === 'incoming')
        .map((flight) => [flight.handoffGroup, flight]),
    );
    for (const flight of nextFlights) {
      if (flight.handoffRole !== 'outgoing') continue;
      const incoming = incomingByHandoff.get(flight.handoffGroup);
      const handoffDelay = incoming
        ? incoming.delay + Math.round(incoming.duration * MOTION_HANDOFF_PROGRESS)
        : 0;
      flight.delay = flight.flipBeforeMove
        ? Math.max(MOTION_FLIP_DURATION_MS, handoffDelay)
        : handoffDelay;
      if (flight.flipBeforeMove) {
        if (incoming) incoming.lateHandoff = true;
      }
    }
    if (nextFlights.some((flight) => flight.afterPlacement)) {
      const placementEnd = Math.max(
        0,
        ...nextFlights
          .filter((flight) => !flight.afterPlacement && flight.tone !== 'clear')
          .map((flight) => flight.delay + flight.duration),
      );
      for (const flight of nextFlights) {
        if (flight.afterPlacement) flight.delay += placementEnd + MOTION_STAGGER_MS;
      }
    }
    if (nextFlights.some((flight) => flight.tone === 'clear' && flight.flipBeforeMove)) {
      for (const flight of nextFlights) {
        if (flight.tone === 'clear') flight.delay += MOTION_FLIP_DURATION_MS;
      }
    }
    if (nextFlights.some((flight) => flight.clearAfterPlacement)) {
      const placementEnd = Math.max(
        0,
        ...nextFlights
          .filter((flight) => flight.tone !== 'clear')
          .map((flight) => flight.delay + flight.duration),
      );
      for (const flight of nextFlights) {
        if (flight.tone === 'clear') flight.delay += placementEnd + MOTION_STAGGER_MS;
      }
    }
    if (!nextFlights.length) return;

    const flightsByDestination = prepareDestinationSnapshots(nextFlights);

    for (const [destination, destinationFlights] of flightsByDestination) {
      const finalFlight = destinationFlights.at(-1);
      destination.dataset.sjCardMotionBatch = batch;
      destination.style.setProperty('--sj-card-arrival-duration', `${finalFlight.duration}ms`);
      destination.style.setProperty('--sj-card-arrival-delay', `${finalFlight.delay}ms`);
      destination.classList.add('sj-card-motion-destination');
      destination.classList.toggle(
        'sj-card-motion-destination-late',
        !!finalFlight.lateHandoff,
      );
      destinationsRef.current.add(destination);
    }
    setFlights((current) => [...current, ...nextFlights]);

    const lifetime = Math.max(...nextFlights.map((flight) => flight.duration + flight.delay)) + 80;
    onMotionBatch?.(Date.now() + lifetime);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(timer);
      setFlights((current) => current.filter((flight) => !nextFlights.some(({ id }) => id === flight.id)));
      for (const flight of nextFlights) {
        if (flight.destination.dataset.sjCardMotionBatch !== batch) continue;
        flight.destination.classList.remove('sj-card-motion-destination');
        flight.destination.classList.remove('sj-card-motion-destination-late');
        delete flight.destination.dataset.sjCardMotionBatch;
        flight.destination.style.removeProperty('--sj-card-arrival-duration');
        flight.destination.style.removeProperty('--sj-card-arrival-delay');
        destinationsRef.current.delete(flight.destination);
      }
    }, lifetime);
    timersRef.current.add(timer);
  }, [anchorRootRef, enabled, onMotionBatch, state]);

  if (!flights.length) return null;

  return createPortal(
    <div className={`sj-card-motion-layer ${layerClassName}`.trim()} aria-hidden="true">
      {flights.map((flight) => (
        <React.Fragment key={flight.id}>
          {flight.targetCard && (
            <div
              className="sj-card-target-hold"
              style={{
                left: `${flight.destinationRect.left}px`,
                top: `${flight.destinationRect.top}px`,
                width: `${flight.destinationRect.width}px`,
                height: `${flight.destinationRect.height}px`,
                '--sj-flight-duration': `${flight.duration}ms`,
                '--sj-flight-delay': `${flight.delay}ms`,
              }}
            >
              <Card
                value={flight.targetCard.value}
                kind={flight.targetCard.kind}
                faceUp={flight.targetCard.faceUp !== false}
                size="pile"
                suppressRevealAnimation
              />
            </div>
          )}
          {flight.settledCard && (
            <div
              className="sj-card-target-settled"
              style={{
                left: `${flight.destinationRect.left}px`,
                top: `${flight.destinationRect.top}px`,
                width: `${flight.destinationRect.width}px`,
                height: `${flight.destinationRect.height}px`,
                '--sj-settle-delay': `${flight.settledDelay}ms`,
                '--sj-settle-hide-delay': `${flight.settledDelay + flight.settledDuration}ms`,
              }}
            >
              <Card
                value={flight.settledCard.value}
                kind={flight.settledCard.kind}
                faceUp={flight.settledCard.faceUp !== false}
                size="pile"
                suppressRevealAnimation
              />
            </div>
          )}
          <div
            className={[
              'sj-card-flight',
            `sj-card-flight-${flight.tone || 'place'}`,
            flight.stack ? `sj-card-flight-${flight.tone}-${flight.stack}` : '',
            flight.handoffRole ? `sj-card-flight-handoff-${flight.handoffRole}` : '',
            flight.lateHandoff ? 'sj-card-flight-late-handoff' : '',
            ].filter(Boolean).join(' ')}
            style={{
              left: `${flight.from.left}px`,
              top: `${flight.from.top}px`,
              width: `${flight.from.width}px`,
              height: `${flight.from.height}px`,
              offsetPath: flight.path,
              '--sj-flight-scale-x': flight.scaleX,
                '--sj-flight-scale-y': flight.scaleY,
                '--sj-flight-duration': `${flight.duration}ms`,
                '--sj-flight-delay': `${flight.delay}ms`,
              }}
            >
            <div className="sj-card-flight-card">
              {flight.flipBeforeMove ? (
                <div className="sj-card-flight-flip">
                  <div className="sj-card-flight-flip-layer sj-card-flight-flip-underlay">
                    <Card faceUp={false} size="pile" suppressRevealAnimation />
                  </div>
                  <div className="sj-card-flight-flip-layer sj-card-flight-flip-reveal">
                    <Card
                      value={flight.card?.value}
                      kind={flight.card?.kind}
                      faceUp
                      size="pile"
                      animateFlip
                      suppressRevealAnimation
                    />
                  </div>
                </div>
              ) : (
                <Card
                  value={flight.card?.value}
                  kind={flight.card?.kind}
                  faceUp={flight.card?.faceUp !== false}
                  size="pile"
                  suppressRevealAnimation
                />
              )}
            </div>
          </div>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}
