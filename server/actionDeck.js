import { shuffle } from './deck.js';

export const ACTION_TYPES = [
  'removeEach',
  'swapOwn',
  'extraTurns',
  'drawThree',
  'peekLine',
  'defense',
  'playDiscard',
  'stealAction',
  'swapPlayers',
];

export function buildActionGameDeck() {
  const counts = {
    '-2': 3,
    '-1': 7,
    '0': 11,
  };
  for (let value = 1; value <= 12; value += 1) counts[String(value)] = 7;

  const numericCards = [];
  let id = 0;
  for (const [valueString, count] of Object.entries(counts)) {
    const value = parseInt(valueString, 10);
    for (let index = 0; index < count; index += 1) {
      numericCards.push({ id: `action-number-${id++}`, kind: 'number', value });
    }
  }

  const stars = Array.from({ length: 15 }, (_, index) => ({
    id: `star-${index}`,
    kind: 'star',
    value: 0,
  }));
  return shuffle([...numericCards, ...stars]);
}

export function buildActionDeck() {
  let id = 0;
  return shuffle(ACTION_TYPES.flatMap((type) =>
    Array.from({ length: 3 }, () => ({
      id: `action-${id++}`,
      kind: 'action',
      type,
    }))));
}
