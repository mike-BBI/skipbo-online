import { useEffect, useRef } from 'react';
import { cardLabel } from './engine.js';

// Card art is rendered by the cardmeister custom element. React's
// reconciliation + the custom element's attribute handling has been
// unreliable across our usage (we saw stale SVGs lingering after the
// data changed). To sidestep that, we create the <playing-card>
// element imperatively every time the card changes — guaranteed
// fresh element, guaranteed fresh SVG.

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
  const hostRef = useRef(null);
  const cid = !faceDown && card ? cidFor(card) : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!cid) return;
    const pc = document.createElement('playing-card');
    pc.setAttribute('cid', cid);
    host.appendChild(pc);
  }, [cid]);

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
      ref={hostRef}
      className={`pc pc-svg ${selected ? 'selected' : ''} ${className}`}
      onClick={onClick}
      style={style}
      aria-label={cardLabel(card)}
      data-cid={cid}
    />
  );
}
