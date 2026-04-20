import { cardLabel } from './engine.js';

// Card art uses the English-pattern SVG sprite from Wikimedia Commons,
// bundled as /public/cards.svg. The sprite is a 13x4 grid (52 cards),
// scaled down to the current --card-w / --card-h via CSS. Actual suit
// row / rank column ordering is calibrated in CARD_GRID below.

// Column index by rank. The sprite runs A, 2..10, J, Q, K left-to-right.
const RANK_COL = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, 11: 10, 12: 11, 13: 12 };
// Row index by suit. Calibrated against the Wikimedia SVG layout:
// top-to-bottom the rows are clubs, diamonds, hearts, spades.
const SUIT_ROW = { C: 0, D: 1, H: 2, S: 3 };

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
  const col = RANK_COL[card.rank];
  const row = SUIT_ROW[card.suit];
  const bg = {
    '--card-col': col,
    '--card-row': row,
  };
  return (
    <div
      className={`pc pc-svg ${selected ? 'selected' : ''} ${className}`}
      onClick={onClick}
      style={{ ...bg, ...style }}
      aria-label={cardLabel(card)}
    />
  );
}
