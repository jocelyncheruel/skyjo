import React, { useMemo, useState } from 'react';
import { ChevronRight, Flame, Medal, Sparkles, Trophy } from 'lucide-react';
import { buildProgression, pluralize } from '../progression.js';

function placementTrophies(rank, playerCount) {
  if (playerCount < 2 || rank < 1 || rank > playerCount) return 0;
  if (playerCount === 2) return rank === 1 ? 20 : -5;
  const middle = Math.ceil(playerCount / 2);
  if (rank === middle) return 0;
  if (rank < middle) return Math.max(6, Math.round((20 * (middle - rank)) / (middle - 1)));
  return Math.min(-1, -Math.round((5 * (rank - middle)) / (playerCount - middle)));
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}

function statsBeforeCurrentGame(afterStats, { won, draw, roundNumber, gameMode }) {
  if (!afterStats) return null;
  const decrement = (key, amount = 1) => Math.max(0, Number(afterStats[key] || 0) - amount);
  return {
    ...afterStats,
    gamesPlayed: decrement('gamesPlayed'),
    gamesWon: decrement('gamesWon', won && !draw ? 1 : 0),
    gamesLost: decrement('gamesLost', !won && !draw ? 1 : 0),
    gamesDrawn: decrement('gamesDrawn', draw ? 1 : 0),
    roundsPlayed: decrement('roundsPlayed', Math.max(0, Number(roundNumber || 0))),
    classicGames: decrement('classicGames', gameMode === 'classic' ? 1 : 0),
    actionGames: decrement('actionGames', gameMode === 'action' ? 1 : 0),
  };
}

function playerRanking(players) {
  const sorted = [...players].sort((a, b) => a.totalScore - b.totalScore);
  return sorted.map((player, index) => ({
    ...player,
    rank: sorted.findIndex((candidate) => candidate.totalScore === player.totalScore) + 1,
    order: index + 1,
  }));
}

function confettiPieces() {
  const colors = ['#f5c451', '#63dc94', '#68a7ff', '#ef7770', '#c694ff'];
  return Array.from({ length: 28 }, (_, index) => ({
    id: index,
    color: colors[index % colors.length],
    left: `${4 + ((index * 37) % 92)}%`,
    delay: `${(index % 9) * 80}ms`,
    duration: `${1500 + (index % 6) * 170}ms`,
    rotation: `${(index * 47) % 180}deg`,
  }));
}

export default function GameEndCelebration({
  players,
  myId,
  winnerIds,
  isSpectator,
  beforeStats,
  afterStats,
  statsLoading,
  roundNumber,
  gameMode,
  isCreator,
  onNewGame,
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ranking = useMemo(() => playerRanking(players), [players]);
  const pieces = useMemo(() => confettiPieces(), []);
  const me = ranking.find((player) => player.id === myId);
  const winners = ranking.filter((player) => winnerIds.includes(player.id));
  const won = !!me && winnerIds.includes(me.id);
  const draw = winnerIds.length > 1;
  const winnerNames = new Intl.ListFormat('fr-FR', { style: 'long', type: 'conjunction' })
    .format(winners.map((player) => player.name));
  const title = isSpectator
    ? draw ? 'Égalité !' : `${winners[0]?.name || 'Un joueur'} remporte la partie !`
    : won ? draw ? 'Victoire partagée !' : 'Victoire !'
      : `${winners[0]?.name || 'Un joueur'} remporte la partie`;
  const nominalTrophyGain = me
    ? placementTrophies(me.rank, ranking.length)
      + (me.rank === 1 ? Math.min(Math.max((afterStats?.currentWinStreak || 1) - 1, 0), 5) : 0)
    : 0;
  const trophyGain = beforeStats && afterStats
    ? Number(afterStats.competitiveRating || 0) - Number(beforeStats.competitiveRating || 0)
    : nominalTrophyGain;
  const effectiveBeforeStats = beforeStats || statsBeforeCurrentGame(afterStats, {
    won,
    draw,
    roundNumber,
    gameMode,
  });
  const beforeProgression = buildProgression(effectiveBeforeStats || {});
  const afterProgression = buildProgression(afterStats || beforeStats || {});
  const xpGain = effectiveBeforeStats && afterStats
    ? Math.max(0, afterProgression.xp - beforeProgression.xp)
    : null;
  const unlockedChallenges = effectiveBeforeStats && afterStats
    ? afterProgression.challenges.filter((challenge) => (
      challenge.completed
      && !beforeProgression.challenges.find((previous) => previous.id === challenge.id)?.completed
    ))
    : [];
  const levelUp = afterProgression.level > beforeProgression.level;
  const rating = afterStats?.competitiveRating;
  const streak = afterStats?.currentWinStreak || 0;

  return (
    <section className={`sj-game-end ${won ? 'sj-game-end-win' : ''}`} aria-labelledby="game-end-title">
      {(won || isSpectator) && (
        <div className="sj-game-end-confetti" aria-hidden="true">
          {pieces.map((piece) => (
            <i key={piece.id} style={{
              '--sj-confetti-color': piece.color,
              '--sj-confetti-left': piece.left,
              '--sj-confetti-delay': piece.delay,
              '--sj-confetti-duration': piece.duration,
              '--sj-confetti-rotation': piece.rotation,
            }} />
          ))}
        </div>
      )}

      <header className="sj-game-end-hero">
        <div className="sj-game-end-emblem" aria-hidden="true">
          {won ? <Trophy size={42} /> : <Medal size={40} />}
        </div>
        <div>
          <span className="sj-game-end-kicker">Partie terminée</span>
          <h1 id="game-end-title">{title}</h1>
          <p>
            {draw
              ? `${winnerNames} terminent avec le meilleur score.`
              : me ? `Vous terminez ${me.rank === 1 ? '1er' : `${me.rank}e`} sur ${ranking.length}.`
                : `${winnerNames} termine en tête du classement.`}
          </p>
        </div>
      </header>

      {!isSpectator && me && (
        <div className="sj-game-end-rewards" aria-label="Récompenses de la partie">
          <article className={`sj-game-end-reward sj-game-end-trophies ${trophyGain < 0 ? 'is-negative' : ''}`}>
            <span className="sj-game-end-reward-icon"><Trophy aria-hidden="true" size={24} /></span>
            <div>
              <small>Trophées</small>
              <strong>{statsLoading && rating == null ? '…' : signed(trophyGain)}</strong>
              <span>{rating == null ? 'Synchronisation…' : `${rating} au total`}</span>
            </div>
          </article>
          <article className="sj-game-end-reward sj-game-end-streak">
            <span className="sj-game-end-reward-icon"><Flame aria-hidden="true" size={25} /></span>
            <div>
              <small>Série actuelle</small>
              <strong>{streak}</strong>
              <span>{pluralize(streak, 'victoire', 'victoires')} consécutive{streak > 1 ? 's' : ''}</span>
            </div>
          </article>
          <article className="sj-game-end-reward sj-game-end-xp">
            <span className="sj-game-end-reward-icon"><Sparkles aria-hidden="true" size={24} /></span>
            <div>
              <small>Expérience</small>
              <strong>{xpGain == null ? statsLoading ? '…' : '—' : `+${xpGain} XP`}</strong>
              <span>Niveau {afterProgression.level}</span>
            </div>
          </article>
        </div>
      )}

      {!isSpectator && afterStats && (
        <div className="sj-game-end-progress">
          <div>
            <span>{levelUp ? `Niveau ${afterProgression.level} atteint !` : `Niveau ${afterProgression.level}`}</span>
            <strong>{afterProgression.xp.toLocaleString('fr-FR')} XP</strong>
          </div>
          <div className="sj-game-end-progress-track" aria-label={`${Math.round(afterProgression.levelProgress * 100)} % vers le niveau suivant`}>
            <i style={{ '--sj-end-progress': `${Math.max(3, afterProgression.levelProgress * 100)}%` }} />
          </div>
          <small>{Math.max(0, afterProgression.nextLevelXp - afterProgression.xp).toLocaleString('fr-FR')} XP avant le niveau {afterProgression.level + 1}</small>
        </div>
      )}

      {unlockedChallenges.length > 0 && (
        <div className="sj-game-end-unlocks" role="status">
          <Sparkles aria-hidden="true" size={18} />
          <div>
            <strong>{unlockedChallenges.length > 1 ? 'Nouveaux défis terminés' : 'Nouveau défi terminé'}</strong>
            <span>{unlockedChallenges.map((challenge) => challenge.title).join(' · ')}</span>
          </div>
        </div>
      )}

      <button
        type="button"
        className="sj-game-end-ranking-toggle"
        aria-expanded={detailsOpen}
        aria-controls="game-end-ranking"
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <span>Classement de la partie</span>
        <ChevronRight aria-hidden="true" size={19} />
      </button>
      <ol id="game-end-ranking" className="sj-game-end-ranking" hidden={!detailsOpen}>
        {ranking.map((player) => (
          <li key={player.id} className={player.id === myId ? 'is-me' : ''}>
            <span className="sj-game-end-rank">{player.order <= 3 ? ['🥇', '🥈', '🥉'][player.order - 1] : `#${player.order}`}</span>
            <span><strong>{player.name}{player.id === myId ? ' (vous)' : ''}</strong></span>
            <strong>{player.totalScore} pts</strong>
          </li>
        ))}
      </ol>

      <footer className="sj-game-end-actions">
        {isCreator ? (
          <button className="sj-btn sj-btn-primary" onClick={onNewGame}>Nouvelle partie</button>
        ) : (
          <p>En attente du créateur pour ouvrir une nouvelle partie</p>
        )}
      </footer>
    </section>
  );
}
