import { HOLE_IN_ONE } from './engine.js';

// A single Play Nine card face. Values -5 (Hole-in-One) through 12.
// Color-coded by value band so the grid reads at a glance:
//   -5 (H1O):   gold   (rare, -5 face value)
//   0:          white  (neutral, best non-H1O regular)
//   1–4:        green  (good — keep)
//   5–8:        blue   (okay)
//   9–12:       red    (bad — get rid of)
//
// When `faceDown` is true we render a plain card back instead of the
// face. When `onClick` is set the card is clickable. `selected`,
// `matched`, and `className` extras are for the in-game / reveal UI.

function tone(value) {
  if (value === HOLE_IN_ONE) return 'h1o';
  if (value === 0) return 'zero';
  if (value <= 4) return 'low';
  if (value <= 8) return 'mid';
  return 'high';
}

export function Card({
  card,
  faceDown,
  onClick,
  selected,
  matched,
  cancelled,
  animationClass,
  className = '',
  style,
}) {
  const classes = ['p9-card'];
  if (faceDown || card == null) classes.push('face-down');
  else classes.push(`tone-${tone(card)}`);
  if (selected) classes.push('selected');
  if (matched) classes.push('matched');
  if (cancelled) classes.push('cancelled');
  if (onClick) classes.push('clickable');
  if (animationClass) classes.push(animationClass);
  if (className) classes.push(className);

  const label = card == null ? '' : String(card);

  return (
    <div
      className={classes.join(' ')}
      onClick={onClick}
      style={style}
      aria-label={faceDown ? 'face-down card' : `card ${label}`}
    >
      {!faceDown && card != null && (
        <span className="p9-card-center">{label}</span>
      )}
    </div>
  );
}

// Render an empty slot (e.g., when the deck has run out).
export function EmptySlot({ label = '', className = '' }) {
  return <div className={`p9-card empty ${className}`}>{label}</div>;
}
