import { useLayoutEffect, useRef, useState } from 'react';
import {
  calculateAdaptiveBoardLayout,
  compensateViewportMeasurement,
  layoutClassNames,
} from './responsiveLayout.js';

function readPx(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function contentBoxWidth(element, fallback = 0) {
  if (!element) return fallback;
  const rect = element.getBoundingClientRect();
  const styles = getComputedStyle(element);
  return Math.max(0, rect.width - readPx(styles.paddingLeft) - readPx(styles.paddingRight));
}

export function useAdaptiveBoardSizing(playerCount, layoutKey, actionMode = false) {
  const shellRef = useRef(null);
  const boardAreaRef = useRef(null);
  const opponentsRef = useRef(null);
  const playColumnRef = useRef(null);
  const meWrapRef = useRef(null);
  const centerRef = useRef(null);
  const actionPanelRef = useRef(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const [layoutClassName, setLayoutClassName] = useState('');
  const layoutReadyRef = useRef(false);
  const measuredViewportRef = useRef({ width: 0, height: 0 });
  const baselineDevicePixelRatioRef = useRef(null);
  const appliedClassNameRef = useRef('');

  useLayoutEffect(() => {
    let frame = 0;
    let disposed = false;

    const measure = ({ reveal = true, force = false } = {}) => {
      const shell = shellRef.current;
      const boardArea = boardAreaRef.current;
      const playColumn = playColumnRef.current;
      if (!shell || !boardArea || !playColumn) return;

      const shellRect = shell.getBoundingClientRect();
      const visualWidth = window.visualViewport?.width;
      const visualHeight = window.visualViewport?.height;
      const currentDevicePixelRatio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
      if (!baselineDevicePixelRatioRef.current) {
        baselineDevicePixelRatioRef.current = currentDevicePixelRatio;
      }
      const compensatedViewport = compensateViewportMeasurement({
        visualWidth: Number.isFinite(visualWidth) && visualWidth > 0
          ? visualWidth
          : shellRect.width || window.innerWidth,
        visualHeight: Number.isFinite(visualHeight) && visualHeight > 0
          ? visualHeight
          : window.innerHeight || shellRect.height,
        visualScale: window.visualViewport?.scale,
        currentDevicePixelRatio,
        baselineDevicePixelRatio: baselineDevicePixelRatioRef.current,
      });
      const { width: viewportWidth, height: viewportHeight, layoutScale } = compensatedViewport;
      const lastViewport = measuredViewportRef.current;
      const mobileLayout = viewportWidth < 900;
      const widthChanged = Math.abs(viewportWidth - lastViewport.width) > (mobileLayout ? 8 : 2);
      const heightChanged = Math.abs(viewportHeight - lastViewport.height) > (mobileLayout ? 8 : 2);

      if (!force && layoutReadyRef.current && !widthChanged && !heightChanged) return;

      measuredViewportRef.current = { width: viewportWidth, height: viewportHeight };
      const boardAreaRect = boardArea.getBoundingClientRect();
      const playRect = playColumn.getBoundingClientRect();
      const opponentsRect = opponentsRef.current?.getBoundingClientRect();
      const chatRect = shell.querySelector('.sj-chat-button')?.getBoundingClientRect();
      const exitRect = shell.querySelector('.sj-exit-button')?.getBoundingClientRect();
      const boardAreaStyles = getComputedStyle(boardArea);
      const layout = calculateAdaptiveBoardLayout({
        viewportWidth,
        viewportHeight,
        playerCount,
        boardAreaWidth: boardAreaRect.width * layoutScale,
        boardAreaHeight: boardAreaRect.height * layoutScale,
        opponentsWidth: contentBoxWidth(opponentsRef.current, opponentsRect?.width || boardAreaRect.width) * layoutScale,
        playColumnHeight: playRect.height * layoutScale,
        meWrapWidth: contentBoxWidth(meWrapRef.current, boardAreaRect.width) * layoutScale,
        meWrapHeight: (meWrapRef.current?.getBoundingClientRect().height || 0) * layoutScale,
        centerHeight: centerRef.current?.getBoundingClientRect().height || 0,
        actionPanelWidth: actionPanelRef.current?.getBoundingClientRect().width || 0,
        playGap: readPx(boardAreaStyles.rowGap || boardAreaStyles.gap),
        chatEdgeClearance: chatRect
          ? Math.max(0, chatRect.right - boardAreaRect.left + 2)
          : undefined,
        opponentsRightLimit: exitRect && opponentsRect
          ? Math.max(0, exitRect.left - opponentsRect.left - 8)
          : undefined,
        actionMode,
      });
      const nextClassName = layoutClassNames(layout).join(' ');
      if (nextClassName !== appliedClassNameRef.current) {
        appliedClassNameRef.current = nextClassName;
        setLayoutClassName(nextClassName);
      }

      if (reveal && !disposed && !layoutReadyRef.current) {
        layoutReadyRef.current = true;
        setLayoutReady(true);
      }
    };

    const update = ({ reveal = true, force = false } = {}) => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure({ reveal, force });
      });
    };

    measure({ reveal: layoutReadyRef.current, force: true });
    update({ reveal: true, force: true });

    const handleResize = () => update({ reveal: true });
    const handleLayoutResize = () => update({ reveal: true, force: true });
    const handleOrientationChange = () => update({ reveal: true, force: true });
    const observedElements = [boardAreaRef.current, playColumnRef.current, opponentsRef.current, meWrapRef.current, centerRef.current, actionPanelRef.current]
      .filter(Boolean);
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(handleLayoutResize);

    observedElements.forEach((element) => resizeObserver?.observe(element));
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientationChange);
    window.visualViewport?.addEventListener('resize', handleResize);
    window.visualViewport?.addEventListener('scroll', handleResize);

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientationChange);
      window.visualViewport?.removeEventListener('resize', handleResize);
      window.visualViewport?.removeEventListener('scroll', handleResize);
    };
  }, [actionMode, playerCount, layoutKey]);

  return {
    shellRef,
    boardAreaRef,
    opponentsRef,
    playColumnRef,
    meWrapRef,
    centerRef,
    actionPanelRef,
    layoutReady,
    layoutClassName,
  };
}
