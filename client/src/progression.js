export const PROGRESSION_MILESTONES = [
  { id: 'games_1', title: 'Premiers pas', description: 'Terminer 1 partie', metric: 'completedGames', target: 1, xp: 40 },
  { id: 'games_10', title: 'Habitué', description: 'Terminer 10 parties', metric: 'completedGames', target: 10, xp: 100 },
  { id: 'games_25', title: 'Joueur régulier', description: 'Terminer 25 parties', metric: 'completedGames', target: 25, xp: 180 },
  { id: 'games_50', title: 'Passionné', description: 'Terminer 50 parties', metric: 'completedGames', target: 50, xp: 300 },
  { id: 'games_100', title: 'Vétéran', description: 'Terminer 100 parties', metric: 'completedGames', target: 100, xp: 500 },
  { id: 'games_250', title: 'Inépuisable', description: 'Terminer 250 parties', metric: 'completedGames', target: 250, xp: 900 },
  { id: 'games_500', title: 'Légende des tables', description: 'Terminer 500 parties', metric: 'completedGames', target: 500, xp: 1500 },

  { id: 'wins_1', title: 'Première victoire', description: 'Remporter 1 partie', metric: 'gamesWon', target: 1, xp: 60 },
  { id: 'wins_5', title: 'Prétendant', description: 'Remporter 5 parties', metric: 'gamesWon', target: 5, xp: 120 },
  { id: 'wins_15', title: 'Challenger', description: 'Remporter 15 parties', metric: 'gamesWon', target: 15, xp: 220 },
  { id: 'wins_30', title: 'Compétiteur', description: 'Remporter 30 parties', metric: 'gamesWon', target: 30, xp: 350 },
  { id: 'wins_75', title: 'Champion', description: 'Remporter 75 parties', metric: 'gamesWon', target: 75, xp: 650 },
  { id: 'wins_150', title: 'Maître du Skyjo', description: 'Remporter 150 parties', metric: 'gamesWon', target: 150, xp: 1200 },

  { id: 'rounds_25', title: 'Mise en jambes', description: 'Jouer 25 manches', metric: 'roundsPlayed', target: 25, xp: 80 },
  { id: 'rounds_100', title: 'Endurant', description: 'Jouer 100 manches', metric: 'roundsPlayed', target: 100, xp: 180 },
  { id: 'rounds_250', title: 'Marathonien', description: 'Jouer 250 manches', metric: 'roundsPlayed', target: 250, xp: 320 },
  { id: 'rounds_500', title: 'Infatigable', description: 'Jouer 500 manches', metric: 'roundsPlayed', target: 500, xp: 500 },
  { id: 'rounds_1000', title: 'Mille manches', description: 'Jouer 1 000 manches', metric: 'roundsPlayed', target: 1000, xp: 850 },
  { id: 'rounds_2500', title: 'Éternel joueur', description: 'Jouer 2 500 manches', metric: 'roundsPlayed', target: 2500, xp: 1500 },

  { id: 'action_10', title: 'Explorateur Action', description: 'Terminer 10 parties Action', metric: 'actionGames', target: 10, xp: 100 },
  { id: 'action_50', title: 'Tacticien', description: 'Terminer 50 parties Action', metric: 'actionGames', target: 50, xp: 300 },
  { id: 'action_100', title: 'Stratège', description: 'Terminer 100 parties Action', metric: 'actionGames', target: 100, xp: 550 },
  { id: 'action_250', title: 'Maître des actions', description: 'Terminer 250 parties Action', metric: 'actionGames', target: 250, xp: 1100 },
];

const METRIC_LABELS = {
  completedGames: { action: 'Terminer', singular: 'partie', plural: 'parties' },
  gamesWon: { action: 'Remporter', singular: 'partie', plural: 'parties' },
  roundsPlayed: { action: 'Jouer', singular: 'manche', plural: 'manches' },
  actionGames: { action: 'Terminer', singular: 'partie Action', plural: 'parties Action' },
};

export function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count) > 1 ? plural : singular;
}

export function challengeDescription(challenge) {
  const labels = METRIC_LABELS[challenge.metric];
  if (!labels) return challenge.description;
  return `${labels.action} ${challenge.target.toLocaleString('fr-FR')} ${pluralize(challenge.target, labels.singular, labels.plural)}`;
}

export function xpForLevel(level) {
  const safeLevel = Math.max(1, Math.trunc(Number(level) || 1));
  return 600 * (safeLevel - 1) * safeLevel;
}

export function levelFromXp(xp) {
  const safeXp = Math.max(0, Math.trunc(Number(xp) || 0));
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + (safeXp * 4) / 600)) / 2));
}

export function buildProgression(stats = {}) {
  const value = (key) => Math.max(0, Math.trunc(Number(stats[key]) || 0));
  const completedGames = value('gamesWon') + value('gamesLost') + value('gamesDrawn');
  const metrics = {
    ...stats,
    completedGames,
    gamesWon: value('gamesWon'),
    roundsPlayed: value('roundsPlayed'),
    actionGames: value('actionGames'),
  };
  const challenges = PROGRESSION_MILESTONES.map((challenge) => {
    const current = Math.min(
      challenge.target,
      Math.max(0, Math.trunc(Number(metrics[challenge.metric]) || 0)),
    );
    return { ...challenge, current, completed: current >= challenge.target };
  });
  const achievementXp = challenges.reduce((total, challenge) => (
    total + (challenge.completed ? challenge.xp : 0)
  ), 0);
  const gameXp = completedGames * 30
    + value('gamesWon') * 60
    + value('gamesDrawn') * 20
    + value('roundsPlayed') * 4
    + value('actionGames') * 8;
  const xp = gameXp + achievementXp;
  const level = levelFromXp(xp);
  const levelStartXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const timelineStartLevel = Math.max(1, level - 1);
  const levelTimeline = Array.from({ length: 5 }, (_, index) => {
    const timelineLevel = timelineStartLevel + index;
    return {
      level: timelineLevel,
      xp: xpForLevel(timelineLevel),
      completed: timelineLevel < level,
      current: timelineLevel === level,
    };
  });
  const timelineCurrentIndex = level - timelineStartLevel;
  const timelineProgress = (timelineCurrentIndex + (
    nextLevelXp === levelStartXp ? 0 : (xp - levelStartXp) / (nextLevelXp - levelStartXp)
  )) / (levelTimeline.length - 1);
  const activeChallenges = [...new Set(PROGRESSION_MILESTONES.map(({ metric }) => metric))]
    .map((metric) => challenges.find((challenge) => challenge.metric === metric && !challenge.completed))
    .filter(Boolean);
  return {
    xp,
    level,
    levelStartXp,
    nextLevelXp,
    levelProgress: nextLevelXp === levelStartXp ? 0 : (xp - levelStartXp) / (nextLevelXp - levelStartXp),
    challenges,
    activeChallenges,
    completedChallenges: challenges.filter((challenge) => challenge.completed).length,
    levelTimeline,
    timelineProgress,
  };
}
