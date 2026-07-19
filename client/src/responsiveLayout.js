export const CARD_HEIGHT_RATIO = 122 / 88;
export const OPPONENT_BOARD_GAP = 8;
export const DESKTOP_MIN_WIDTH = 900;
export const DESKTOP_MIN_HEIGHT = 620;
export const SHORT_LANDSCAPE_MAX_HEIGHT = 560;
export const MIN_USABLE_CARD_WIDTH = 28;
export const MIN_COMFORTABLE_OPPONENT_CARD_WIDTH = 36;
export const PREFERRED_OPPONENT_CARD_WIDTH = 46;
export const CHAT_EDGE_CLEARANCE = 44;
export const MIN_CHAT_BOARD_GAP = 16;

export function compensateViewportMeasurement({
  visualWidth,
  visualHeight,
  visualScale = 1,
  currentDevicePixelRatio = 1,
  baselineDevicePixelRatio = 1,
}) {
  const safeVisualScale = Number.isFinite(visualScale) && visualScale > 0 ? visualScale : 1;
  const safeCurrentDpr = Number.isFinite(currentDevicePixelRatio) && currentDevicePixelRatio > 0
    ? currentDevicePixelRatio
    : 1;
  const safeBaselineDpr = Number.isFinite(baselineDevicePixelRatio) && baselineDevicePixelRatio > 0
    ? baselineDevicePixelRatio
    : safeCurrentDpr;
  const layoutScale = safeCurrentDpr / safeBaselineDpr;

  return {
    width: Math.round(visualWidth * safeVisualScale * layoutScale),
    height: Math.round(visualHeight * safeVisualScale * layoutScale),
    layoutScale,
  };
}
export const CHAT_BOTTOM_RESERVE = 50;

export function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Mirrors the CSS custom-property formulas used by .sj-board. Keeping this
 * function and the CSS formulas in sync makes the fit calculation conservative
 * without relying on style attributes (forbidden by the production CSP).
 */
export function boardMetrics(cardWidth) {
  const cardWidthPx = Number(cardWidth);
  const cardHeight = cardWidthPx * CARD_HEIGHT_RATIO;
  const gridGap = clampNumber(cardWidthPx * 0.085, 2, 8);
  const pad = clampNumber(cardWidthPx * 0.16, 5, 16);
  const blockGap = clampNumber(cardWidthPx * 0.1, 4, 8);
  const header = clampNumber(cardWidthPx * 0.4, 26, 34);
  const border = 2;

  return {
    cardWidth: cardWidthPx,
    cardHeight,
    gridGap,
    pad,
    blockGap,
    header,
    width: cardWidthPx * 4 + gridGap * 3 + pad * 2 + border,
    height: cardHeight * 3 + gridGap * 2 + header + blockGap + pad * 2 + border,
  };
}

export function fitBoardCardWidth(widthBudget, heightBudget, min, max, options) {
  let low = min;
  let high = max;

  for (let index = 0; index < 16; index += 1) {
    const middle = (low + high) / 2;
    const metrics = boardMetrics(middle, options);
    if (metrics.width <= widthBudget && metrics.height <= heightBudget) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return low;
}

export function quantizeLayoutSize(value, min, max, step = 2) {
  const bounded = clampNumber(value, min, max);
  return Math.max(min, Math.min(max, min + Math.floor((bounded - min) / step) * step));
}

function optimizeStackedMultiPlayerLayout({
  measuredBoardWidth,
  measuredBoardHeight,
  meWidthBudget,
  opponentCount,
  playGap,
  minimumPileCardWidth,
  preferredPileCardWidth,
  pileHeightFor,
  meMin,
  meMax,
  rail,
}) {
  const opponentWidthBudget = rail
    ? Math.floor(Math.min(measuredBoardWidth * 0.72, 280))
    : Math.floor(
      (measuredBoardWidth - Math.max(0, opponentCount - 1) * OPPONENT_BOARD_GAP)
      / Math.max(1, opponentCount),
    );
  const verticalBudget = Math.max(0, measuredBoardHeight - playGap * 2);
  const meHeightShare = 0.5;
  const maxMeCardWidth = quantizeLayoutSize(
    fitBoardCardWidth(meWidthBudget, verticalBudget * meHeightShare, meMin, meMax),
    meMin,
    meMax,
  );
  const opponentMax = rail ? 64 : 58;
  const maxOpponentCardWidth = quantizeLayoutSize(
    fitBoardCardWidth(
      opponentWidthBudget,
      Number.MAX_SAFE_INTEGER,
      MIN_USABLE_CARD_WIDTH,
      opponentMax,
      { compactOpponent: true },
    ),
    MIN_USABLE_CARD_WIDTH,
    opponentMax,
  );
  const findBest = ({ minimumMeCardWidth, minimumOpponentCardWidth, minimumPileWidth }) => {
    let best = null;
    for (let me = minimumMeCardWidth; me <= maxMeCardWidth; me += 2) {
      const meHeight = boardMetrics(me).height;
      for (let opponent = minimumOpponentCardWidth; opponent <= maxOpponentCardWidth; opponent += 2) {
        const opponentHeight = boardMetrics(opponent, { compactOpponent: true }).height;
        for (let pile = minimumPileWidth; pile <= preferredPileCardWidth; pile += 2) {
          const usedHeight = meHeight + opponentHeight + pileHeightFor(pile);
          if (usedHeight > verticalBudget + 0.75) continue;
          const fill = usedHeight / Math.max(1, verticalBudget);
          const normalizedSizes = [
            me / Math.max(1, maxMeCardWidth),
            opponent / Math.max(1, maxOpponentCardWidth),
            pile / Math.max(1, preferredPileCardWidth),
          ];
          const balance = Math.min(...normalizedSizes) * 6
            + normalizedSizes.reduce((sum, value) => sum + value, 0);
          const slack = verticalBudget - usedHeight;
          const score = slack <= 10
            ? 100000 + balance * 100 - slack
            : fill * 10000 + balance;
          if (!best || score > best.score) {
            best = { meCardWidth: me, opponentCardWidth: opponent, pileCardWidth: pile, usedHeight, score };
          }
        }
      }
    }
    return best;
  };

  const preferredFloors = {
    minimumMeCardWidth: quantizeLayoutSize(
      maxMeCardWidth - 2,
      meMin,
      maxMeCardWidth,
    ),
    minimumOpponentCardWidth: quantizeLayoutSize(
      MIN_COMFORTABLE_OPPONENT_CARD_WIDTH,
      MIN_USABLE_CARD_WIDTH,
      maxOpponentCardWidth,
    ),
    minimumPileWidth: minimumPileCardWidth,
  };
  for (let minimumMeCardWidth = preferredFloors.minimumMeCardWidth;
    minimumMeCardWidth >= meMin;
    minimumMeCardWidth -= 2) {
    const best = findBest({ ...preferredFloors, minimumMeCardWidth });
    if (best) return best;
  }
  return findBest({
    minimumMeCardWidth: meMin,
    minimumOpponentCardWidth: MIN_USABLE_CARD_WIDTH,
    minimumPileWidth: minimumPileCardWidth,
  });
}

function balanceDesktopMultiPlayerLayout({
  measuredBoardHeight,
  meWidthBudget,
  opponentWidthBudget,
  opponentCount,
  playGap,
  meMin,
  meMax,
  opponentMin,
  opponentMax,
  largeScreen,
}) {
  const emphasizeCurrentPlayer = largeScreen && opponentCount <= 3;
  const baseRatioFloor = emphasizeCurrentPlayer ? 1.4 : 1.2;
  const baseRatioLimit = emphasizeCurrentPlayer ? 1.52 : 1.32;
  const ratioFloor = clampNumber(baseRatioFloor + Math.max(0, opponentCount - 3) * 0.08, baseRatioFloor, 1.55);
  const ratioLimit = clampNumber(baseRatioLimit + Math.max(0, opponentCount - 3) * 0.12, baseRatioLimit, 1.8);
  const availableHeight = Math.max(0, measuredBoardHeight - playGap);
  let best = null;

  for (let me = meMin; me <= meMax; me += 2) {
    const meMetrics = boardMetrics(me);
    if (meMetrics.width > meWidthBudget) continue;

    for (let opponent = opponentMin; opponent <= opponentMax; opponent += 2) {
      const opponentMetrics = boardMetrics(opponent, { opponent: true });
      if (opponentMetrics.width > opponentWidthBudget) continue;
      const sizeRatio = me / opponent;
      if (sizeRatio < ratioFloor - 0.001 || sizeRatio > ratioLimit + 0.001) continue;

      const usedHeight = meMetrics.height + opponentMetrics.height;
      if (usedHeight > availableHeight + 0.75) continue;

      const fill = usedHeight / Math.max(1, availableHeight);
      const ratioTarget = (ratioFloor + ratioLimit) / 2;
      const ratioAccuracy = 1 - Math.abs(sizeRatio - ratioTarget);
      const score = fill * 10000 + ratioAccuracy * 750 + opponent * 2 + me;
      if (!best || score > best.score) {
        best = { meCardWidth: me, opponentCardWidth: opponent, score };
      }
    }
  }

  return best;
}

export function responsiveLayoutMode(viewportWidth, viewportHeight) {
  const desktop = viewportWidth >= DESKTOP_MIN_WIDTH && viewportHeight >= DESKTOP_MIN_HEIGHT;
  const shortLandscape = !desktop
    && viewportHeight <= SHORT_LANDSCAPE_MAX_HEIGHT
    && viewportWidth >= viewportHeight * 1.2;

  return {
    desktop,
    stacked: !desktop,
    shortLandscape,
  };
}

export function calculateAdaptiveBoardLayout({
  viewportWidth,
  viewportHeight,
  playerCount,
  boardAreaWidth,
  boardAreaHeight,
  opponentsWidth = boardAreaWidth,
  playColumnHeight,
  meWrapWidth = boardAreaWidth,
  meWrapHeight = 0,
  centerHeight = 0,
  actionPanelWidth = 0,
  playGap = 0,
  chatEdgeClearance = CHAT_EDGE_CLEARANCE,
  opponentsRightLimit = Number.POSITIVE_INFINITY,
  actionMode = false,
}) {
  const mode = responsiveLayoutMode(viewportWidth, viewportHeight);
  const opponentCount = Math.max(0, playerCount - 1);
  const sharedTwoPlayer = opponentCount === 1;
  const compactOpponents = mode.stacked && !sharedTwoPlayer;
  const tinyPortrait = !mode.shortLandscape && viewportWidth <= 360 && viewportHeight <= 520;
  const minimumPileCardWidth = mode.desktop
    ? 76
    : mode.shortLandscape
      ? 44
      : tinyPortrait
        ? 48
        : quantizeLayoutSize(viewportWidth * 0.125, 44, 60);
  const preferredPileCardWidth = Math.max(minimumPileCardWidth, mode.desktop
    ? clampNumber(Math.min(viewportWidth * 0.105, viewportHeight * 0.18), 80, 140)
    : mode.shortLandscape
      ? clampNumber(Math.min(viewportHeight * 0.165, viewportWidth * 0.085), 42, 68)
      : tinyPortrait
        ? clampNumber(Math.min((viewportWidth - 44) / 2.6, viewportHeight * 0.125), 48, 60)
        : clampNumber(Math.min((viewportWidth - 44) / 2.6, viewportHeight * 0.14), 44, 112));
  const pileEffectSpace = mode.shortLandscape ? 6 : tinyPortrait ? 7 : 10;
  const pileHeightFor = (cardWidth) => cardWidth * CARD_HEIGHT_RATIO + pileEffectSpace * 2;
  const pileGap = mode.shortLandscape ? 4 : clampNumber(preferredPileCardWidth * 0.1, 4, 10);
  const pileGroupWidth = (preferredPileCardWidth + pileEffectSpace * 2) * 2 + pileGap;
  const estimatedPileHeight = pileHeightFor(preferredPileCardWidth);
  const measuredBoardWidth = boardAreaWidth || viewportWidth;
  const measuredBoardHeight = boardAreaHeight || viewportHeight;
  const minimumOpponentBoardWidth = boardMetrics(MIN_USABLE_CARD_WIDTH, {
    compactOpponent: true,
  }).width;
  const shortLandscapeSideWidth = Math.max(
    132,
    (measuredBoardWidth - pileGroupWidth - playGap * 2) / 2,
  );
  const comfortableOpponentBoardWidth = boardMetrics(PREFERRED_OPPONENT_CARD_WIDTH, {
    compactOpponent: true,
  }).width;
  const opponentRowWidth = opponentCount * minimumOpponentBoardWidth
    + Math.max(0, opponentCount - 1) * OPPONENT_BOARD_GAP;
  const comfortableOpponentRowWidth = opponentCount * comfortableOpponentBoardWidth
    + Math.max(0, opponentCount - 1) * OPPONENT_BOARD_GAP;
  const opponentRowBudget = mode.shortLandscape
    ? shortLandscapeSideWidth
    : measuredBoardWidth;
  let opponentsRail = mode.stacked
    && opponentCount > 1
    && (opponentRowWidth > opponentRowBudget
      || comfortableOpponentRowWidth > opponentRowBudget);
  let opponentsRow = opponentCount > 1 && !opponentsRail;

  let meWidthBudget;
  let meHeightBudget;
  let opponentWidthBudget;
  let opponentHeightBudget;
  let chatClearance = false;
  let pileCardWidth = preferredPileCardWidth;

  if (mode.shortLandscape) {
    const sideWidth = shortLandscapeSideWidth;
    const actionDockReserve = actionMode ? 60 : 0;
    meWidthBudget = Math.max(132, sideWidth - actionDockReserve);
    meHeightBudget = Math.max(168, measuredBoardHeight - 2);
    opponentWidthBudget = sideWidth;
    opponentHeightBudget = Math.max(168, meHeightBudget - CHAT_BOTTOM_RESERVE);
    chatClearance = true;
  } else {
    const centerFlowHeight = mode.desktop
      ? 0
      : Math.max(centerHeight, estimatedPileHeight);
    const pilesFlowHeight = mode.desktop ? 0 : centerFlowHeight + playGap;
    const availableMeHeight = mode.desktop
      ? (meWrapHeight || playColumnHeight || measuredBoardHeight)
      : Math.max(meWrapHeight, (playColumnHeight || measuredBoardHeight) - pilesFlowHeight);
    const sideReserve = mode.desktop
      ? (actionPanelWidth || 120) + clampNumber(viewportWidth * 0.05, 44, 96)
      : 0;
    meWidthBudget = mode.desktop
      ? viewportWidth - sideReserve
      : Math.min(meWrapWidth || measuredBoardWidth, measuredBoardWidth);
    meHeightBudget = Math.max(96, availableMeHeight - (mode.desktop ? 2 : 0));

    const opponentsHeightShare = mode.desktop ? 0.4 : 0.36;
    const proportionalOpponentHeight = Math.floor(Math.min(
      measuredBoardHeight * opponentsHeightShare,
      viewportHeight * (mode.desktop ? 0.31 : 0.34),
    ));
    const comfortableOpponentHeight = boardMetrics(MIN_COMFORTABLE_OPPONENT_CARD_WIDTH, {
      compactOpponent: compactOpponents,
      opponent: !compactOpponents,
    }).height;
    const minimumMeBoardHeight = boardMetrics(MIN_USABLE_CARD_WIDTH, {
      shared: sharedTwoPlayer,
    }).height;
    const stackedOpponentCapacity = measuredBoardHeight
      - estimatedPileHeight
      - minimumMeBoardHeight
      - playGap * 2;
    opponentHeightBudget = mode.stacked
      ? Math.floor(Math.max(
        proportionalOpponentHeight,
        Math.min(comfortableOpponentHeight, stackedOpponentCapacity),
      ))
      : proportionalOpponentHeight;
    opponentWidthBudget = opponentsRail
      ? Math.floor(Math.min(
        measuredBoardWidth * 0.72,
        viewportWidth * 0.72,
        280,
      ))
      : Math.floor((measuredBoardWidth - Math.max(0, opponentCount - 1) * OPPONENT_BOARD_GAP) / Math.max(1, opponentCount));

    if (mode.desktop && opponentCount > 1) {
      const pileEdgeOffset = clampNumber(viewportWidth * 0.03, 12, 36);
      const centeredRowWidth = Math.max(
        minimumOpponentBoardWidth,
        measuredBoardWidth - 2 * ((actionPanelWidth || 120) + pileEdgeOffset + 8),
      );
      opponentWidthBudget = Math.floor(
        (centeredRowWidth - Math.max(0, opponentCount - 1) * OPPONENT_BOARD_GAP)
        / opponentCount,
      );
    }
  }

  const meMin = mode.stacked ? MIN_USABLE_CARD_WIDTH : viewportHeight < 700 ? 38 : 44;
  const meMax = mode.shortLandscape
    ? 72
    : mode.desktop || viewportWidth >= 600
      ? 120
      : 88;
  let meCardWidth = fitBoardCardWidth(meWidthBudget, meHeightBudget, meMin, meMax, {
    shared: sharedTwoPlayer,
  });

  if (mode.stacked && !mode.shortLandscape && !sharedTwoPlayer) {
    let best = null;
    const edgeWidthBudget = Math.max(132, Math.min(
      meWidthBudget,
      measuredBoardWidth - chatEdgeClearance * 2,
    ));

    for (let candidatePile = minimumPileCardWidth; candidatePile <= preferredPileCardWidth; candidatePile += 2) {
      const availableHeight = Math.max(
        96,
        (playColumnHeight || measuredBoardHeight) + centerHeight - pileHeightFor(candidatePile),
      );
      const edgeCardWidth = fitBoardCardWidth(
        edgeWidthBudget,
        availableHeight,
        meMin,
        meMax,
      );
      const liftedCardWidth = fitBoardCardWidth(
        meWidthBudget,
        Math.max(96, availableHeight - CHAT_BOTTOM_RESERVE),
        meMin,
        meMax,
      );
      const lifted = liftedCardWidth > edgeCardWidth;
      const candidate = {
        cardWidth: quantizeLayoutSize(
          lifted ? liftedCardWidth : edgeCardWidth,
          meMin,
          meMax,
        ),
        chatClearance: lifted,
        pileCardWidth: candidatePile,
      };

      if (!best
        || candidate.cardWidth > best.cardWidth + 0.25
        || (Math.abs(candidate.cardWidth - best.cardWidth) <= 0.25
          && candidate.pileCardWidth > best.pileCardWidth)) {
        best = candidate;
      }
    }

    if (best) {
      meCardWidth = best.cardWidth;
      pileCardWidth = best.pileCardWidth;
      chatClearance = best.chatClearance;
    }
  }

  const opponentMin = mode.stacked ? MIN_USABLE_CARD_WIDTH : 12;
  if (mode.desktop) {
    const desktopOpponentCapacity = measuredBoardHeight
      - boardMetrics(meCardWidth).height
      - playGap;
    opponentHeightBudget = Math.floor(Math.max(96, Math.min(
      measuredBoardHeight * 0.44,
      viewportHeight * 0.4,
      desktopOpponentCapacity,
    )));
  }
  const opponentMax = sharedTwoPlayer
    ? meMax
    : mode.shortLandscape
      ? 64
      : mode.desktop
        ? 96
        : 46;
  let opponentCardWidth = opponentCount > 0
    ? fitBoardCardWidth(
      opponentWidthBudget,
      opponentHeightBudget,
      opponentMin,
      opponentMax,
      { opponent: !compactOpponents, compactOpponent: compactOpponents },
    )
    : opponentMin;

  if (sharedTwoPlayer) {
    if (mode.shortLandscape) {
      const sharedCardWidth = Math.min(meCardWidth, fitBoardCardWidth(
        opponentWidthBudget,
        opponentHeightBudget,
        meMin,
        meMax,
        { shared: true },
      ));
      meCardWidth = sharedCardWidth;
      opponentCardWidth = sharedCardWidth;
    } else {
      const sharedWidthBudget = mode.desktop
        ? meWidthBudget
        : Math.min(measuredBoardWidth, meWrapWidth || measuredBoardWidth);

      if (mode.desktop) {
        const sharedHeightBudget = Math.max(96, (measuredBoardHeight - playGap) / 2);
        const sharedCardWidth = fitBoardCardWidth(
          sharedWidthBudget,
          sharedHeightBudget,
          meMin,
          meMax,
          { shared: true },
        );
        meCardWidth = sharedCardWidth;
        opponentCardWidth = sharedCardWidth;
      } else {
        const edgeWidthBudget = Math.max(132, Math.min(
          sharedWidthBudget,
          measuredBoardWidth - chatEdgeClearance * 2,
        ));
        let best = null;

        for (let candidatePile = minimumPileCardWidth; candidatePile <= preferredPileCardWidth; candidatePile += 2) {
          const flowHeight = pileHeightFor(candidatePile);
          const regularHeightBudget = Math.max(
            96,
            (measuredBoardHeight - flowHeight - playGap * 2) / 2,
          );
          const fullCardWidth = fitBoardCardWidth(
            sharedWidthBudget,
            regularHeightBudget,
            meMin,
            meMax,
            { shared: true },
          );
          const edgeCardWidth = fitBoardCardWidth(
            edgeWidthBudget,
            regularHeightBudget,
            meMin,
            meMax,
            { shared: true },
          );
          const quantizedFullCardWidth = quantizeLayoutSize(
            fullCardWidth,
            meMin,
            meMax,
          );
          const quantizedEdgeCardWidth = quantizeLayoutSize(
            edgeCardWidth,
            meMin,
            meMax,
          );
          const candidate = {
            cardWidth: quantizedFullCardWidth,
            chatClearance: quantizedFullCardWidth > quantizedEdgeCardWidth,
            pileCardWidth: candidatePile,
          };

          if (!best
            || candidate.cardWidth > best.cardWidth + 0.25
            || (Math.abs(candidate.cardWidth - best.cardWidth) <= 0.25
              && candidate.pileCardWidth > best.pileCardWidth)) {
            best = candidate;
          }
        }

        if (best) {
          meCardWidth = best.cardWidth;
          opponentCardWidth = best.cardWidth;
          pileCardWidth = best.pileCardWidth;
          chatClearance = best.chatClearance;
        }
      }
    }
  }

  if (mode.desktop && !sharedTwoPlayer && opponentCount > 0) {
    const balancedDesktopLayout = balanceDesktopMultiPlayerLayout({
      measuredBoardHeight,
      meWidthBudget,
      opponentWidthBudget,
      opponentCount,
      playGap,
      meMin,
      meMax,
      opponentMin,
      opponentMax,
      largeScreen: viewportWidth >= 1280 && viewportHeight >= 700,
    });

    if (balancedDesktopLayout) {
      meCardWidth = balancedDesktopLayout.meCardWidth;
      opponentCardWidth = balancedDesktopLayout.opponentCardWidth;
    }
  }

  if (mode.stacked && !mode.shortLandscape && !sharedTwoPlayer) {
    const commonOptimizerInput = {
      measuredBoardWidth,
      measuredBoardHeight,
      meWidthBudget,
      opponentCount,
      playGap,
      minimumPileCardWidth,
      preferredPileCardWidth,
      pileHeightFor,
      meMin,
      meMax,
    };
    const rowLayout = opponentsRail
      ? null
      : optimizeStackedMultiPlayerLayout({ ...commonOptimizerInput, rail: false });
    const railLayout = optimizeStackedMultiPlayerLayout({ ...commonOptimizerInput, rail: true });
    const useRail = opponentsRail;
    const optimizedLayout = useRail ? railLayout : rowLayout;

    if (optimizedLayout) {
      opponentsRail = useRail;
      opponentsRow = opponentCount > 1 && !useRail;
      meCardWidth = optimizedLayout.meCardWidth;
      opponentCardWidth = optimizedLayout.opponentCardWidth;
      pileCardWidth = optimizedLayout.pileCardWidth;
    }
  }

  const renderedOpponentBoardWidth = opponentCount > 0
    ? boardMetrics(opponentCardWidth, {
      opponent: !compactOpponents,
      compactOpponent: compactOpponents,
    }).width
    : 0;
  const renderedOpponentRowWidth = renderedOpponentBoardWidth * opponentCount
    + Math.max(0, opponentCount - 1) * OPPONENT_BOARD_GAP;
  const centeredOpponentRight = (opponentsWidth || measuredBoardWidth) / 2
    + renderedOpponentRowWidth / 2;
  const opponentsExitCollision = mode.stacked
    && !mode.shortLandscape
    && opponentCount > 1
    && (opponentsRail || centeredOpponentRight > opponentsRightLimit);
  const finalMeCardWidth = quantizeLayoutSize(meCardWidth, MIN_USABLE_CARD_WIDTH, 120);

  if (mode.stacked && !mode.shortLandscape && !sharedTwoPlayer && !chatClearance) {
    const renderedMeBoardWidth = boardMetrics(finalMeCardWidth).width;
    const centeredMeLeft = Math.max(0, ((meWrapWidth || measuredBoardWidth) - renderedMeBoardWidth) / 2);
    chatClearance = centeredMeLeft - chatEdgeClearance < MIN_CHAT_BOARD_GAP;
  }

  return {
    desktop: mode.desktop,
    stacked: mode.stacked,
    shortLandscape: mode.shortLandscape,
    opponentsRail,
    opponentsRow,
    opponentsExitCollision,
    sharedTwoPlayer,
    compactTwoPlayer: sharedTwoPlayer,
    chatClearance,
    meCardWidth: finalMeCardWidth,
    opponentCardWidth: quantizeLayoutSize(opponentCardWidth, mode.stacked ? MIN_USABLE_CARD_WIDTH : 12, 120),
    pileCardWidth: quantizeLayoutSize(pileCardWidth, 42, 140),
  };
}

export function layoutClassNames(layout) {
  return [
    layout.desktop ? 'sj-layout-desktop' : 'sj-layout-stacked',
    layout.shortLandscape ? 'sj-layout-short-landscape' : '',
    layout.opponentsRail ? 'sj-layout-opponents-rail' : '',
    layout.opponentsRow ? 'sj-layout-opponents-row' : '',
    layout.opponentsExitCollision ? 'sj-layout-opponents-exit-below' : '',
    layout.sharedTwoPlayer ? 'sj-layout-shared-two' : '',
    layout.chatClearance ? 'sj-layout-chat-clearance' : '',
    `sj-me-card-${layout.meCardWidth}`,
    `sj-opp-card-${layout.opponentCardWidth}`,
    `sj-pile-card-${layout.pileCardWidth}`,
  ].filter(Boolean);
}
