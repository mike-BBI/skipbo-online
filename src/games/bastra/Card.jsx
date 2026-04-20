import { cardLabel } from './engine.js';

// Card art is rendered by the cardmeister custom element
// (<playing-card cid="...">) — a single script registered in
// index.html that draws each card as clean inline SVG. One element
// per card, no sprite alignment headaches.

const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANK_NAME = {
  1: 'Ace', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
  8: '8', 9: '9', 10: '10', 11: 'Jack', 12: 'Queen', 13: 'King',
};

function cidFor(card) {
  const rank = RANK_NAME[card.rank];
  const suit = SUIT_NAME[card.suit];
  if (!rank || !suit) return '';
  return `${rank}-of-${suit}`;
}

export function PlayingCard({ card, faceDown, onClick, className = '', selected, style }) {
  if (faceDown) {
    return (
      <div className={`pc face-down ${className}`} onClick={onClick} style={style} />
    );
  }
  if (!card) {
    return <div className={`pc empty ${className}`} onClick={onClick} style={style} />;
  }
  return (
    <div
      className={`pc pc-svg ${selected ? 'selected' : ''} ${className}`}
      onClick={onClick}
      style={style}
      aria-label={cardLabel(card)}
    >
      <playing-card cid={cidFor(card)} />
    </div>
  );
}
