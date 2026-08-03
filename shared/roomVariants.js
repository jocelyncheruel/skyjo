export const GAME_END_MODES = Object.freeze({
  SCORE_TARGET: 'scoreTarget',
  ROUND_COUNT: 'roundCount',
});

export const LEGACY_SINGLE_ROUND_MODE = 'singleRound';
export const SCORE_TARGET_PRESETS = Object.freeze([50, 100, 150]);
export const ROUND_LIMIT_PRESETS = Object.freeze([1, 3, 5]);
export const SCORE_TARGET_MIN = 10;
export const SCORE_TARGET_MAX = 1000;
export const ROUND_LIMIT_MIN = 1;
export const ROUND_LIMIT_MAX = 20;
export const DEFAULT_SCORE_TARGET = 100;
export const DEFAULT_ROUND_LIMIT = 3;
export const DEFAULT_GAME_END_MODE = GAME_END_MODES.SCORE_TARGET;

export function isValidScoreTarget(value) {
  return Number.isInteger(value) && value >= SCORE_TARGET_MIN && value <= SCORE_TARGET_MAX;
}

export function isValidRoundLimit(value) {
  return Number.isInteger(value) && value >= ROUND_LIMIT_MIN && value <= ROUND_LIMIT_MAX;
}

export function effectiveRoomVariantSettings(settings = {}) {
  const legacySingleRound = settings?.gameEndMode === LEGACY_SINGLE_ROUND_MODE;
  let roundLimit = DEFAULT_ROUND_LIMIT;
  if (legacySingleRound) roundLimit = 1;
  else if (isValidRoundLimit(settings?.roundLimit)) roundLimit = settings.roundLimit;

  return {
    gameEndMode: settings?.gameEndMode === GAME_END_MODES.ROUND_COUNT || legacySingleRound
      ? GAME_END_MODES.ROUND_COUNT
      : DEFAULT_GAME_END_MODE,
    scoreTarget: isValidScoreTarget(settings?.scoreTarget)
      ? settings.scoreTarget
      : DEFAULT_SCORE_TARGET,
    roundLimit,
  };
}

export function hasReachedGameEnd(state) {
  const variant = effectiveRoomVariantSettings(state?.roomSettings);
  if (variant.gameEndMode === GAME_END_MODES.ROUND_COUNT) {
    return Number(state?.completedRounds || 0) >= variant.roundLimit;
  }
  return (state?.order || []).some(
    (id) => Number(state?.playersById?.[id]?.totalScore || 0) >= variant.scoreTarget,
  );
}

export function roomVariantLabel(settings = {}) {
  const variant = effectiveRoomVariantSettings(settings);
  return variant.gameEndMode === GAME_END_MODES.ROUND_COUNT
    ? `${variant.roundLimit} manche${variant.roundLimit > 1 ? 's' : ''}`
    : `Objectif ${variant.scoreTarget} points`;
}
