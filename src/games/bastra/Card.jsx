import { cardLabel } from './engine.js';

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);
const RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
function rankText(rank) { return RANK_LABELS[rank] || String(rank); }

// Traditional two-column pip layouts (percent of card body).
// Columns at 32/68 keep a clean gutter; top and bottom rows sit
// just above/below the corner indices; middle rows stagger for 7-10
// the way a real card does. Bottom-half pips are rotated 180° in CSS
// so orientation matches a physical deck.
const PIP_LAYOUTS = {
  2: [[50, 26], [50, 74]],
  3: [[50, 26], [50, 50], [50, 74]],
  4: [[32, 26], [68, 26], [32, 74], [68, 74]],
  5: [[32, 26], [68, 26], [50, 50], [32, 74], [68, 74]],
  6: [[32, 26], [68, 26], [32, 50], [68, 50], [32, 74], [68, 74]],
  7: [[32, 26], [68, 26], [50, 38], [32, 50], [68, 50], [32, 74], [68, 74]],
  8: [[32, 26], [68, 26], [50, 38], [32, 50], [68, 50], [50, 62], [32, 74], [68, 74]],
  9: [[32, 26], [68, 26], [32, 42], [68, 42], [50, 50], [32, 58], [68, 58], [32, 74], [68, 74]],
  // 10 uses the classic 2-1-2 / 2-1-2 arrangement so it doesn't look
  // cramped like a compressed 8.
  10: [[32, 22], [68, 22], [50, 33], [32, 44], [68, 44], [32, 56], [68, 56], [50, 67], [32, 78], [68, 78]],
};

// Unicode provides full-card glyphs for every standard deck card
// (U+1F0A1..1F0DE). They render as complete face cards with the
// traditional courtly illustrations on most modern systems — the
// fastest route to a recognizable J/Q/K without custom SVG artwork.
// Knight (U+xxAC) is skipped so Queen/King land on the right points.
const SUIT_GLYPH_BASE = { S: 0x1F0A0, H: 0x1F0B0, D: 0x1F0C0, C: 0x1F0D0 };
function faceGlyph(card) {
  const base = SUIT_GLYPH_BASE[card.suit];
  if (!base) return '';
  let offset = card.rank;
  if (card.rank >= 12) offset += 1; // skip Knight slot
  return String.fromCodePoint(base + offset);
}

function Pips({ rank, suit, card }) {
  const sym = SUIT_SYMBOLS[suit];
  if (rank === 1) {
    return <span className="pc-center-pip">{sym}</span>;
  }
  if (rank === 11 || rank === 12 || rank === 13) {
    return <span className="pc-face-glyph">{faceGlyph(card)}</span>;
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
        <Pips rank={card.rank} suit={card.suit} card={card} />
      </span>
      <span className="pc-corner pc-br">
        <span className="pc-corner-rank">{rank}</span>
        <span className="pc-corner-suit">{sym}</span>
      </span>
    </div>
  );
}
