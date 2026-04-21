import { useState, useMemo } from 'react';
import { Card, EmptySlot } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { COLUMNS, GRID_SIZE, faceDownCount, scoreBreakdown } from './engine.js';

// Row-major index layout: 0..3 top, 4..7 bottom. Column i = [i, i+4].
const GRID_ORDER = [0, 1, 2, 3, 4, 5, 6, 7];

function PlayerGrid({ player, highlightSlots = [], onSlotClick, revealAll = false }) {
  return (
    <div className="p9-grid">
      {GRID_ORDER.map((i) => {
        const isFaceUp = revealAll || player.flipped[i];
        const onClick = onSlotClick ? () => onSlotClick(i) : undefined;
        return (
          <Card
            key={i}
            card={isFaceUp ? player.grid[i] : null}
            faceDown={!isFaceUp}
            onClick={onClick}
            selected={highlightSlots.includes(i)}
          />
        );
      })}
    </div>
  );
}

export function Game({ state, myId, onAction, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const me = state.players[myId];
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);
  const isMyTurn = state.turn === myId && !state.holeEnded && !state.winner;
  const isTeeOff = state.phase === 'teeOff';

  // "Discard-and-flip" is a two-click action in the UI: tap the
  // [Discard it] button (enters `flipping` mode), then tap a face-down
  // card. Track that local mode.
  const [flipMode, setFlipMode] = useState(false);

  // Reset flip mode when state changes such that it no longer applies
  // (not your turn, no drawn card, etc.).
  useMemo(() => {
    if (!isMyTurn || !me?.drawn) setFlipMode(false);
  }, [isMyTurn, me?.drawn]);

  const [showChat, setShowChat] = useState(false);

  const handleSlotClick = (slot) => {
    if (!isMyTurn) return;
    if (isTeeOff) {
      if (me.flipped[slot]) return;
      onAction({ type: 'teeOffFlip', slot });
      return;
    }
    // Play phase
    if (me.drawn == null) return;
    if (flipMode) {
      // Must be a face-down slot.
      if (me.flipped[slot]) return;
      onAction({ type: 'discardAndFlip', slot });
      setFlipMode(false);
      return;
    }
    onAction({ type: 'replace', slot });
  };

  const onDrawDeck = () => isMyTurn && !me.drawn && onAction({ type: 'drawDeck' });
  const onDrawDiscard = () => isMyTurn && !me.drawn && onAction({ type: 'drawDiscard' });
  const onSkip = () => isMyTurn && !me.drawn && onAction({ type: 'skip' });
  const enterFlipMode = () => me?.drawn != null && me.drawnSource === 'deck' && setFlipMode(true);
  const cancelFlipMode = () => setFlipMode(false);

  const discardTop = state.discard[state.discard.length - 1];
  const fdLeft = me ? faceDownCount(me) : 0;

  let prompt = '';
  if (state.winner) {
    prompt = state.winner === myId ? '🏆 You won the match!' : `${state.players[state.winner]?.name || 'Someone'} wins the match.`;
  } else if (state.holeEnded) {
    prompt = `Hole ${state.hole} complete.`;
  } else if (isTeeOff) {
    if (isMyTurn) {
      const done = state.teeOffFlips?.[myId] || 0;
      prompt = done >= 2 ? 'Waiting for others to tee off…' : `Tee off: flip ${2 - done} card${2 - done === 1 ? '' : 's'}.`;
    } else {
      prompt = `${state.players[state.turn]?.name || 'Someone'} is teeing off…`;
    }
  } else if (isMyTurn) {
    if (!me.drawn) {
      prompt = 'Your turn — tap the deck or the discard top.';
    } else if (flipMode) {
      prompt = 'Tap a face-down card to flip it.';
    } else if (me.drawnSource === 'discard') {
      prompt = `You picked up ${labelFor(me.drawn)}. Tap a card to swap it in.`;
    } else {
      prompt = `Drew ${labelFor(me.drawn)}. Tap a card to swap, or discard it and flip one.`;
    }
  } else {
    prompt = `${state.players[state.turn]?.name || 'Someone'}'s turn.`;
  }

  return (
    <div className="board playnine" style={{ position: 'relative' }}>
      <div className="p9-top-bar">
        <div>Room <span className="room-code">{state.roomCode || ''}</span></div>
        <div className="p9-hole">Hole {state.hole}/{state.rules?.targetHoles ?? 9}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!hideChat && (
            <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowChat((v) => !v)}>
              {showChat ? 'Hide' : 'Chat'}
            </button>
          )}
          <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div className="p9-opponents">
        {opponents.map((op) => (
          <div key={op.id} className={`p9-opponent ${op.id === state.turn ? 'active' : ''}`}>
            <div className="p9-opp-header">
              <span className="p9-opp-name">{op.name}</span>
              <span className="p9-opp-score">{op.cumulativeScore || 0}{op.puttedOut ? ' · out' : ''}</span>
            </div>
            <PlayerGrid player={op} />
          </div>
        ))}
      </div>

      <div className="p9-center">
        <div className="p9-pile">
          <div className="p9-pile-label">Deck</div>
          <Card
            card={null}
            faceDown
            onClick={isMyTurn && !isTeeOff && !me.drawn ? onDrawDeck : undefined}
          />
        </div>
        <div className="p9-drawn">
          <div className="p9-drawn-label">In hand</div>
          {me?.drawn != null
            ? <Card card={me.drawn} />
            : <EmptySlot />
          }
        </div>
        <div className="p9-pile">
          <div className="p9-pile-label">Discard</div>
          {discardTop != null
            ? <Card
                card={discardTop}
                onClick={isMyTurn && !isTeeOff && !me.drawn ? onDrawDiscard : undefined}
              />
            : <EmptySlot />
          }
        </div>
      </div>

      <div className={`p9-prompt ${isMyTurn ? 'active' : ''}`}>{prompt}</div>

      <div className="p9-actions">
        {isMyTurn && state.phase === 'play' && !me.drawn && fdLeft === 1 && !state.puttingOutBy && (
          <button className="secondary" onClick={onSkip}>Skip (line up your putt)</button>
        )}
        {isMyTurn && me?.drawn != null && me.drawnSource === 'deck' && !flipMode && (
          <button className="secondary" onClick={enterFlipMode}>Discard + flip a card</button>
        )}
        {isMyTurn && flipMode && (
          <button className="secondary" onClick={cancelFlipMode}>Cancel</button>
        )}
      </div>

      <div className={`p9-my-grid-wrap ${isMyTurn ? 'active' : ''}`}>
        <div className="p9-my-score-row">
          <span><strong>You</strong> · hole-in-progress</span>
          <span>Total: <strong>{me?.cumulativeScore || 0}</strong></span>
        </div>
        <PlayerGrid
          player={me}
          onSlotClick={isMyTurn ? handleSlotClick : undefined}
        />
        <div className="p9-my-score-row">
          <span style={{ color: 'var(--muted)' }}>{fdLeft} face-down left</span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!hideChat && showChat && (
        <Chat messages={chatMessages} onSend={onSendChat} />
      )}

      {state.holeEnded && (
        <RoundReveal state={state} myId={myId} onNext={() => onAction({ type: 'nextHole' })} onLeave={onLeave} />
      )}
    </div>
  );
}

function labelFor(v) {
  if (v === -5) return 'Hole-in-One (-5)';
  return String(v);
}

function RoundReveal({ state, myId, onNext, onLeave }) {
  const isMatchEnd = !!state.winner;
  const players = state.playerOrder.map((id) => state.players[id]);
  const breakdowns = players.map((p) => ({ p, bd: scoreBreakdown(p.grid) }));

  return (
    <div className="p9-reveal-overlay">
      <div className="p9-reveal-title">
        {isMatchEnd
          ? (state.winner === myId ? '🏆 You won the match!' : `${state.players[state.winner].name} wins the match`)
          : `Hole ${state.hole} complete`}
      </div>
      {breakdowns.map(({ p, bd }) => (
        <div key={p.id} className="p9-reveal-row">
          <div className="p9-reveal-row-header">
            <span className="p9-reveal-row-name">{p.name}{p.id === myId ? ' (you)' : ''}</span>
            <span className="p9-reveal-row-score">
              +{bd.total}
              <span className="p9-reveal-row-total">total {p.cumulativeScore}</span>
            </span>
          </div>
          <div className="p9-grid" style={{ justifyContent: 'flex-start' }}>
            {GRID_ORDER.map((i) => (
              <Card
                key={i}
                card={bd.cards[i].value}
                matched={bd.cards[i].matched}
                cancelled={bd.cards[i].cancelled}
              />
            ))}
          </div>
          {bd.bonuses.length > 0 && (
            <div className="p9-reveal-bonuses">
              {bd.bonuses.map((b, i) => (
                <span key={i} className="p9-reveal-chip">{b.label} {b.pts}</span>
              ))}
            </div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 10 }}>
        {isMatchEnd
          ? <button onClick={onLeave}>Back to lobby</button>
          : <button onClick={onNext}>Next hole</button>
        }
      </div>
    </div>
  );
}
