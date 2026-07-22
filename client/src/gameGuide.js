export const GAME_TUTORIAL_STORAGE_KEY = 'sj-game-tutorial-v1';

export const ACTION_GUIDE_CARDS = Object.freeze([
  {
    type: 'removeEach',
    label: 'Retirer une carte à chaque joueur',
    description: 'Choisissez chez chaque adversaire une carte de plateau ou une carte Action : elle est remplacée au hasard.',
  },
  {
    type: 'swapOwn',
    label: 'Échanger deux de vos cartes',
    description: 'Inversez la position de deux cartes de votre plateau, qu’elles soient visibles ou cachées.',
  },
  {
    type: 'extraTurns',
    label: 'Jouer deux tours supplémentaires',
    description: 'Ajoutez immédiatement deux tours à jouer après celui-ci.',
  },
  {
    type: 'drawThree',
    label: 'Piocher trois cartes',
    description: 'Regardez trois cartes, placez-en une ou défaussez-les pour retourner une carte cachée.',
  },
  {
    type: 'peekLine',
    label: 'Regarder une ligne ou une colonne',
    description: 'Consultez brièvement une ligne ou une colonne, sur votre plateau ou celui d’un adversaire.',
  },
  {
    type: 'defense',
    label: 'Défense et tour supplémentaire',
    description: 'Gardez-la pour bloquer une Action adverse, ou jouez-la pendant votre tour pour rejouer.',
  },
  {
    type: 'playDiscard',
    label: 'Jouer une Action défaussée',
    description: 'Choisissez une carte Action déjà défaussée et appliquez immédiatement son effet.',
  },
  {
    type: 'stealAction',
    label: 'Voler et jouer une Action',
    description: 'Prenez une carte Action à un adversaire et jouez-la immédiatement.',
  },
  {
    type: 'swapPlayers',
    label: 'Échanger des cartes entre joueurs',
    description: 'Intervertissez deux cartes distinctes, sur un même plateau ou entre deux joueurs.',
  },
]);

export const ACTION_LABELS = Object.freeze(Object.fromEntries(
  ACTION_GUIDE_CARDS.map(({ type, label }) => [type, label]),
));

export const ACTION_ART_URLS = Object.freeze({
  removeEach: '/action-cards/remove-each.jpg',
  swapOwn: '/action-cards/swap-own.jpg',
  extraTurns: '/action-cards/extra-turns.jpg',
  drawThree: '/action-cards/draw-three.jpg',
  peekLine: '/action-cards/peek-line.jpg',
  defense: '/action-cards/defense.jpg',
  playDiscard: '/action-cards/play-discard.jpg',
  stealAction: '/action-cards/steal-action.jpg',
  swapPlayers: '/action-cards/swap-players.jpg',
});

export function hasCompletedGameTutorial(storage) {
  try {
    const target = storage || window.localStorage;
    return target.getItem(GAME_TUTORIAL_STORAGE_KEY) === 'done';
  } catch {
    return false;
  }
}

export function completeGameTutorial(storage) {
  try {
    const target = storage || window.localStorage;
    target.setItem(GAME_TUTORIAL_STORAGE_KEY, 'done');
  } catch {
    return undefined;
  }
}
