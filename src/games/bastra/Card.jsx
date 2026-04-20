import { cardLabel } from './engine.js';

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);
const RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
function rankText(rank) { return RANK_LABELS[rank] || String(rank); }

// Approximate traditional playing-card pip layouts. Positions are
// percentages relative to the card body; pips in the bottom half are
// rotated 180° to match the visual grammar of real cards.
const PIP_LAYOUTS = {
  2: [[50, 22], [50, 78]],
  3: [[50, 22], [50, 50], [50, 78]],
  4: [[28, 22], [72, 22], [28, 78], [72, 78]],
  5: [[28, 22], [72, 22], [50, 50], [28, 78], [72, 78]],
  6: [[28, 22], [72, 22], [28, 50], [72, 50], [28, 78], [72, 78]],
  7: [[28, 22], [72, 22], [50, 36], [28, 50], [72, 50], [28, 78], [72, 78]],
  8: [[28, 22], [72, 22], [50, 36], [28, 50], [72, 50], [50, 64], [28, 78], [72, 78]],
  9: [[28, 22], [72, 22], [28, 40], [72, 40], [50, 50], [28, 60], [72, 60], [28, 78], [72, 78]],
  10: [[28, 22], [72, 22], [50, 30], [28, 44], [72, 44], [28, 56], [72, 56], [50, 70], [28, 78], [72, 78]],
};

function Pips({ rank, suit }) {
  const sym = SUIT_SYMBOLS[suit];
  if (rank === 1) {
    return <span className="pc-center-pip">{sym}</span>;
  }
  if (rank === 11 || rank === 12 || rank === 13) {
    return (
      <span className="pc-face">
        <span className="pc-face-letter">{RANK_LABELS[rank]}</span>
        <span className="pc-face-suit">{sym}</span>
      </span>
    );
  }
  const layout = PIP_LAYOUTS[rank];
  if (!layout) return <span className="pc-center-pip">{sym}</span>;
  return (
    <>
      {layout.map(([x, y], i) => (
        <span
          key={i}
          className="pc-pip"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            transform: `translate(-50%, -50%)${y > 55 ? ' rotate(180deg)' : ''}`,
          }}
        >
          {sym}
        </span>
      ))}
    </>
  );
}

// Playing card with real-card-style pip layout for number cards,
// stacked rank+suit in the corners, and a distinct face-card look.
export function PlayingCard({ card, faceDown, onClick, className = '', selected, style }) {
  if (faceDown || !card) {
    return (
      <div
        className={`pc ${faceDown ? 'face-down' : 'empty'} ${className}`}
        onClick={onClick}
        style={style}
      />
    );
  }
  const red = RED_SUITS.has(card.suit);
  const sym = SUIT_SYMBOLS[card.suit] || card.suit;
  const rank = rankText(card.rank);
  const isFace = card.rank === 11 || card.rank === 12 || card.rank === 13;
  return (
    <div
      className={`pc ${red ? 'red' : 'black'} ${selected ? 'selected' : ''} ${isFace ? 'is-face' : ''} ${className}`}
      onClick={onClick}
      style={style}
      aria-label={cardLabel(card)}
    >
      <span className="pc-corner pc-tl">
        <span className="pc-corner-rank">{rank}</span>
        <span className="pc-corner-suit">{sym}</span>
      </span>
      <span className="pc-body">
        <Pips rank={card.rank} suit={card.suit} />
      </span>
      <span className="pc-corner pc-br">
        <span className="pc-corner-rank">{rank}</span>
        <span className="pc-corner-suit">{sym}</span>
      </span>
    </div>
  );
}
