import { useEffect, useState } from 'react';
import {
  effectiveRoomVariantSettings,
  GAME_END_MODES,
  isValidRoundLimit,
  isValidScoreTarget,
  ROUND_LIMIT_MAX,
  ROUND_LIMIT_MIN,
  ROUND_LIMIT_PRESETS,
  SCORE_TARGET_MAX,
  SCORE_TARGET_MIN,
  SCORE_TARGET_PRESETS,
} from '../../../shared/roomVariants.js';

export default function LobbyGameFormat({ roomSettings, disabled, onUpdate }) {
  const variant = effectiveRoomVariantSettings(roomSettings);
  const isRoundCount = variant.gameEndMode === GAME_END_MODES.ROUND_COUNT;
  const activeValue = isRoundCount ? variant.roundLimit : variant.scoreTarget;
  const presets = isRoundCount ? ROUND_LIMIT_PRESETS : SCORE_TARGET_PRESETS;
  const [customValue, setCustomValue] = useState('');

  useEffect(() => {
    setCustomValue(presets.includes(activeValue) ? '' : String(activeValue));
  }, [activeValue, presets]);

  const commitCustomValue = () => {
    const numericValue = Number(customValue);
    const valid = isRoundCount
      ? isValidRoundLimit(numericValue)
      : isValidScoreTarget(numericValue);
    if (!valid) {
      setCustomValue(presets.includes(activeValue) ? '' : String(activeValue));
      return;
    }
    onUpdate(isRoundCount ? { roundLimit: numericValue } : { scoreTarget: numericValue });
  };

  return (
    <div className="sj-lobby-format">
      <strong className="sj-lobby-format-title">Format de partie</strong>
      <div
        className={`sj-room-visibility sj-lobby-format-mode ${isRoundCount ? 'sj-room-visibility-public' : 'sj-room-visibility-private'}`}
        role="group"
        aria-label="Format de partie"
      >
        <button
          type="button"
          className={`sj-room-visibility-option ${!isRoundCount ? 'sj-room-visibility-option-active' : ''}`}
          aria-pressed={!isRoundCount}
          disabled={disabled}
          onClick={() => onUpdate({ gameEndMode: GAME_END_MODES.SCORE_TARGET })}
        >
          <strong>Points</strong>
        </button>
        <button
          type="button"
          className={`sj-room-visibility-option ${isRoundCount ? 'sj-room-visibility-option-active' : ''}`}
          aria-pressed={isRoundCount}
          disabled={disabled}
          onClick={() => onUpdate({ gameEndMode: GAME_END_MODES.ROUND_COUNT })}
        >
          <strong>Manches</strong>
        </button>
      </div>

      <div className="sj-admin-variant-presets sj-lobby-format-values" role="group" aria-label={isRoundCount ? 'Nombre de manches' : 'Objectif de points'}>
        {presets.map((value) => (
          <button
            key={value}
            type="button"
            className={activeValue === value ? 'sj-admin-variant-active' : ''}
            aria-pressed={activeValue === value}
            disabled={disabled}
            onClick={() => {
              setCustomValue('');
              onUpdate(isRoundCount ? { roundLimit: value } : { scoreTarget: value });
            }}
          >
            {value}
          </button>
        ))}
        <label className={`sj-admin-custom-number ${customValue !== '' ? 'sj-admin-custom-number-active' : ''}`}>
          <input
            type="number"
            min={isRoundCount ? ROUND_LIMIT_MIN : SCORE_TARGET_MIN}
            max={isRoundCount ? ROUND_LIMIT_MAX : SCORE_TARGET_MAX}
            inputMode="numeric"
            aria-label={isRoundCount ? 'Nombre personnalisé de manches' : 'Objectif personnalisé en points'}
            placeholder="—"
            value={customValue}
            disabled={disabled}
            onChange={(event) => setCustomValue(event.target.value)}
            onBlur={commitCustomValue}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </label>
      </div>
    </div>
  );
}
