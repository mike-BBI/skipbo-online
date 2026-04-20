import { cardLabel } from './engine.js';

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);

const RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
function rankText(rank) { return RANK_LABELS[rank] || String(rank); }

// Minimal playing-card face: rank in the corners, suit in the center.
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
  return (
    <div
      className={`pc ${red ? 'red' : 'black'} ${selected ? 'selected' : ''} ${className}`}
      onClick={onClick}
      style={style}
      aria-label={cardLabel(card)}
    >
      <span className="pc-corner pc-tl">{rank}{sym}</span>
      <span className="pc-suit">{sym}</span>
      <span className="pc-corner pc-br">{rank}{sym}</span>
    </div>
  );
}
