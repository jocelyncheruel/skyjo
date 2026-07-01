import React, { useEffect, useMemo, useRef, useState } from 'react';

const CARD_W = 88;
const CARD_H = 122;
const CARD_RADIUS = 11;
const CARD_FRAME_INSET = 1.2;
const CARD_PILE_FRAME_INSET = 1.2;
const CORNER_VALUE_INSET = 7;
const CORNER_VALUE_BOTTOM_OFFSET = 3;
const CORNER_VALUE_SIZE = 13;

function cardRect(inset = 0) {
  const radius = Math.max(0, CARD_RADIUS - inset);

  return {
    x: inset,
    y: inset,
    width: CARD_W - inset * 2,
    height: CARD_H - inset * 2,
    rx: radius,
    ry: radius,
  };
}

function paletteFor(value) {
  if (value <= -1) return { base: '#2446b8', light: '#7f9bff', dark: '#172459', ink: '#ffffff' };
  if (value === 0) return { base: '#27a8ce', light: '#93e5f4', dark: '#116f85', ink: '#053543' };
  if (value <= 4) return { base: '#38a660', light: '#9fe6a2', dark: '#1b6336', ink: '#08351b' };
  if (value <= 8) return { base: '#e4c84a', light: '#fff0a4', dark: '#94771a', ink: '#4b3900' };
  return { base: '#d84b42', light: '#ffaaa0', dark: '#8f1d25', ink: '#4d080d' };
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildFacets(seed) {
  const rand = mulberry32((seed ?? -99) * 97 + 13);
  const cols = 5;
  const rows = 7;
  const pts = [];

  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const jitterX = (rand() - 0.5) * (CARD_W / cols) * 0.55;
      const jitterY = (rand() - 0.5) * (CARD_H / rows) * 0.55;
      pts.push({ x: (c / cols) * CARD_W + jitterX, y: (r / rows) * CARD_H + jitterY });
    }
  }

  const idx = (r, c) => r * (cols + 1) + c;
  const tris = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = pts[idx(r, c)];
      const b = pts[idx(r, c + 1)];
      const cc = pts[idx(r + 1, c)];
      const d = pts[idx(r + 1, c + 1)];
      if (rand() > 0.5) {
        tris.push([a, b, cc]);
        tris.push([b, d, cc]);
      } else {
        tris.push([a, b, d]);
        tris.push([a, d, cc]);
      }
    }
  }

  return tris.map((triangle) => ({
    points: triangle.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '),
    shade: rand(),
  }));
}

function FacetedBackground({ value, rid, inset }) {
  const palette = paletteFor(value);
  const facets = useMemo(() => buildFacets(value), [value]);
  const gradId = `sj-card-grad-${rid}`;
  const clipId = `sj-card-clip-${rid}`;
  const surface = cardRect(inset);

  return (
    <g>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={palette.light} />
          <stop offset="52%" stopColor={palette.base} />
          <stop offset="100%" stopColor={palette.dark} />
        </linearGradient>
        <clipPath id={clipId}>
          <rect {...surface} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect {...surface} fill={`url(#${gradId})`} />
        {facets.map((facet, index) => (
          <polygon key={index} points={facet.points} fill="#ffffff" opacity={(facet.shade * 0.14).toFixed(3)} />
        ))}
        {facets.map((facet, index) => (
          <polygon key={`d-${index}`} points={facet.points} fill="#000000" opacity={(0.1 - facet.shade * 0.08).toFixed(3)} />
        ))}
      </g>
    </g>
  );
}

function CardBack({ rid, inset }) {
  const surface = cardRect(inset);

  return (
    <g>
      <defs>
        <linearGradient id={`sj-card-back-${rid}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#266f7a" />
          <stop offset="100%" stopColor="#123445" />
        </linearGradient>
        <pattern id={`sj-card-back-pattern-${rid}`} width="14" height="14" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="14" height="14" fill="transparent" />
          <line x1="0" y1="0" x2="0" y2="14" stroke="#ffffff" strokeOpacity="0.11" strokeWidth="5" />
        </pattern>
      </defs>
      <rect {...surface} fill={`url(#sj-card-back-${rid})`} />
      <rect {...surface} fill={`url(#sj-card-back-pattern-${rid})`} />
    </g>
  );
}

function CardFrame({ className = '', inset = CARD_FRAME_INSET }) {
  return (
    <rect
      {...cardRect(inset)}
      className={`sj-card-frame ${className}`.trim()}
    />
  );
}

let uidCounter = 0;

export default function Card({
  value,
  kind = 'number',
  faceUp,
  removed,
  onClick,
  highlighted,
  selected,
  size = 'pile',
  pulse,
  dim,
  tone,
  animateFlip,
  suppressRevealAnimation = false,
}) {
  const uid = useMemo(() => `${++uidCounter}`, []);
  const wasFaceUp = useRef(faceUp);
  const [justFlipped, setJustFlipped] = useState(false);

  useEffect(() => {
    if (!suppressRevealAnimation && !wasFaceUp.current && faceUp) {
      setJustFlipped(true);
      const timeout = setTimeout(() => setJustFlipped(false), 360);
      wasFaceUp.current = faceUp;
      return () => clearTimeout(timeout);
    }
    wasFaceUp.current = faceUp;
  }, [faceUp, suppressRevealAnimation]);

  const classes = ['sj-card', `sj-card-size-${size}`];
  if (!faceUp) classes.push('sj-card-back');
  if (highlighted) classes.push('sj-card-highlighted');
  if (selected) classes.push('sj-card-selected');
  if (pulse) classes.push('sj-card-pulse');
  if (animateFlip) classes.push('sj-card-flip');
  if (justFlipped) classes.push('sj-card-reveal');
  if (dim) classes.push('sj-card-dim');
  if (tone) classes.push(`sj-card-${tone}`);
  const frameInset = size === 'pile' ? CARD_PILE_FRAME_INSET : CARD_FRAME_INSET;
  const surface = cardRect(frameInset);

  function handleKeyDown(event) {
    if (!onClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick(event);
    }
  }

  function handlePointerUp(event) {
    if (event.pointerType !== 'keyboard') {
      event.currentTarget.blur();
    }
  }

  if (removed) {
    return (
      <svg
        className={`${classes.join(' ')} sj-card-removed`}
        viewBox={`0 0 ${CARD_W} ${CARD_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Colonne retirée"
      >
        <rect {...surface} className="sj-card-removed-fill" />
        <CardFrame className="sj-card-frame-removed" inset={frameInset} />
      </svg>
    );
  }

  if (!faceUp) {
    return (
      <svg
        className={classes.join(' ')}
        viewBox={`0 0 ${CARD_W} ${CARD_H}`}
        preserveAspectRatio="none"
        onClick={onClick}
        onKeyDown={handleKeyDown}
        onPointerUp={onClick ? handlePointerUp : undefined}
        role={onClick ? 'button' : 'img'}
        aria-label="Carte cachée"
      >
        <CardBack rid={uid} inset={frameInset} />
        <CardFrame inset={frameInset} />
      </svg>
    );
  }

  const palette = paletteFor(value);
  const centerSize = String(value).length > 1 ? 42 : 50;

  return (
    <svg
      className={classes.join(' ')}
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      preserveAspectRatio="none"
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onPointerUp={onClick ? handlePointerUp : undefined}
      role={onClick ? 'button' : 'img'}
      aria-label={kind === 'star' ? 'Carte Étoile' : `Carte ${value}`}
    >
      {kind === 'star' ? (
        <>
          <defs>
            <linearGradient id={`sj-star-grad-${uid}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#63d8e5" />
              <stop offset="48%" stopColor="#f5d94c" />
              <stop offset="100%" stopColor="#ef5f67" />
            </linearGradient>
          </defs>
          <rect {...surface} fill={`url(#sj-star-grad-${uid})`} />
        </>
      ) : (
        <FacetedBackground value={value} rid={uid} inset={frameInset} />
      )}
      {kind !== 'star' && <text
        x={CORNER_VALUE_INSET}
        y={CORNER_VALUE_INSET}
        textAnchor="start"
        dominantBaseline="hanging"
        fontFamily="Arial, sans-serif"
        fontWeight="900"
        fontSize={CORNER_VALUE_SIZE}
        fill={palette.ink}
      >
        {value}
      </text>}
      {kind === 'star' ? (
        <text x={CARD_W / 2} y={CARD_H / 2 + 2} textAnchor="middle" dominantBaseline="central" fontFamily="Arial, sans-serif" fontWeight="900" fontSize="58" fill="#ffffff">★</text>
      ) : (
        <text x={CARD_W / 2} y={CARD_H / 2 + 1} textAnchor="middle" dominantBaseline="central" fontFamily="Arial, sans-serif" fontWeight="900" fontSize={centerSize} fill={palette.ink}>{value}</text>
      )}
      {kind !== 'star' && <text
        x={CARD_W - CORNER_VALUE_INSET}
        y={CARD_H - CORNER_VALUE_INSET + CORNER_VALUE_BOTTOM_OFFSET}
        textAnchor="end"
        dominantBaseline="text-after-edge"
        fontFamily="Arial, sans-serif"
        fontWeight="900"
        fontSize={CORNER_VALUE_SIZE}
        fill={palette.ink}
      >
        {value}
      </text>}
      <CardFrame inset={frameInset} />
    </svg>
  );
}

export { paletteFor as cardPalette };
