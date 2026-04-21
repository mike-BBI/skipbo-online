import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, EmptySlot } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { COLUMNS, GRID_SIZE, faceDownCount, scoreBreakdown } from './engine.js';

// Row-major index layout: 0..3 top, 4..7 bottom. Column i = [i, i+4].
const GRID_ORDER = [0, 1, 2, 3, 4, 5, 6, 7];
const FLIP_ANIM_MS = 460;

// Track which slots in a player's grid just transitioned from
// face-down to face-up so we can stamp the flip animation class for
// exactly one render cycle (~FLIP_ANIM_MS).
function useFlipTracker(player) {
  const prevRef = useRef(null);
  const [pulsing, setPulsing] = useState(() => new Set());
  useEffect(() => {
    if (!player) { prevRef.current = null; return; }
    const prev = prevRef.current;
    prevRef.current = player.flipped.slice();
    if (!prev) return; // first render — no "transition" to detect
    const newlyFlipped = [];
    for (let i = 0; i < GRID_SIZE; i += 1) {
      if (!prev[i] && player.flipped[i]) newlyFlipped.push(i);
    }
    if (newlyFlipped.length === 0) return;
    setPulsing((cur) => {
      const next = new Set(cur);
      for (const i of newlyFlipped) next.add(i);
      return next;
    });
    const timer = setTimeout(() => {
      setPulsing((cur) => {
        const next = new Set(cur);
        for (const i of newlyFlipped) next.delete(i);
        return next;
      });
    }, FLIP_ANIM_MS);
    return () => clearTimeout(timer);
  }, [player, player?.flipped?.join(',')]);
  return pulsing;
}

function PlayerGrid({ player, highlightSlots = [], onSlotClick, revealAll = false }) {
  const flipping = useFlipTracker(player);
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
            animationClass={flipping.has(i) ? 'flipping-in' : ''}
          />
        );
      })}
    </div>
  );
}

// Brief animation on the deck when a card has just been drawn off it.
function useDrawPulse(deckLen) {
  const prev = useRef(deckLen);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (deckLen != null && prev.current != null && deckLen < prev.current) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 420);
      prev.current = deckLen;
      return () => clearTimeout(t);
    }
    prev.current = deckLen;
  }, [deckLen]);
  return pulse;
}

// Brief animation on the discard when its top changes (new card landed).
function useDiscardPop(top) {
  const prev = useRef(top);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    if (top !== undefined && prev.current !== top) {
      setPop(true);
      const t = setTimeout(() => setPop(false), 360);
      prev.current = top;
      return () => clearTimeout(t);
    }
    prev.current = top;
  }, [top]);
  return pop;
}

export function Game({ state, myId, onAction, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const me = state.players[myId];
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);
  const isMyTurn = state.turn === myId && !state.holeEnded && !state.winner;
  const isTeeOff = state.phase === 'teeOff';

  const [flipMode, setFlipMode] = useState(false);
  useMemo(() => {
    if (!isMyTurn || !me?.drawn) setFlipMode(false);
  }, [isMyTurn, me?.drawn]);

  const [showChat, setShowChat] = useState(false);
  const drawPulse = useDrawPulse(state.deck?.length);
  const discardTop = state.discard[state.discard.length - 1];
  const discardPop = useDiscardPop(discardTop);

  const handleSlotClick = (slot) => {
    if (!isMyTurn) return;
    if (isTeeOff) {
      if (me.flipped[slot]) return;
      onAction({ type: 'teeOffFlip', slot });
      return;
    }
    if (me.drawn == null) return;
    if (flipMode) {
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
            animationClass={drawPulse ? 'draw-pulse' : ''}
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
                animationClass={discardPop ? 'discard-pop' : ''}
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
        {state.undoSnapshot?.actor === myId && !state.holeEnded && (
          <button className="secondary" onClick={() => onAction({ type: 'undo' })}>Undo</button>
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

// Staggered end-of-hole reveal. Each player's row sequences:
//   1) cards flip face-up with ~80ms stagger
//   2) cancelled cards get their strike-through
//   3) bonus chips pop in with their pts, running total bumps
// After the final row finishes, action buttons appear.
function RoundReveal({ state, myId, onNext, onLeave }) {
  const isMatchEnd = !!state.winner;
  const players = state.playerOrder.map((id) => state.players[id]);
  const breakdowns = players.map((p) => ({ p, bd: scoreBreakdown(p.grid) }));

  // Gate action buttons until the cascade finishes.
  const [actionsReady, setActionsReady] = useState(false);
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    if (skipped) { setActionsReady(true); return; }
    const perRow = GRID_SIZE * 80 + 1000; // 8 cards × 80ms + bonus time
    const total = breakdowns.length * perRow + 500;
    const t = setTimeout(() => setActionsReady(true), total);
    return () => clearTimeout(t);
  }, [skipped, breakdowns.length]);

  return (
    <div className="p9-reveal-overlay">
      <div className="p9-reveal-title">
        {isMatchEnd
          ? (state.winner === myId ? '🏆 You won the match!' : `${state.players[state.winner].name} wins the match`)
          : `Hole ${state.hole} complete`}
      </div>
      {breakdowns.map(({ p, bd }, rowIdx) => (
        <RevealRow
          key={p.id}
          player={p}
          bd={bd}
          isMe={p.id === myId}
          rowIdx={rowIdx}
          skipped={skipped}
        />
      ))}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 10 }}>
        {!skipped && !actionsReady && (
          <button className="secondary" onClick={() => setSkipped(true)}>Skip</button>
        )}
        {actionsReady && (isMatchEnd
          ? <button onClick={onLeave}>Back to lobby</button>
          : <button onClick={onNext}>Next hole</button>
        )}
      </div>
    </div>
  );
}

function RevealRow({ player, bd, isMe, rowIdx, skipped }) {
  // Phase 0: cards revealing. Phase 1: chips popping. Phase 2: done.
  const startDelay = skipped ? 0 : rowIdx * (GRID_SIZE * 80 + 1000);
  const [chipIndex, setChipIndex] = useState(skipped ? bd.bonuses.length : 0);
  const [runningScore, setRunningScore] = useState(() => {
    if (skipped) return bd.total;
    let sum = 0;
    for (let i = 0; i < GRID_SIZE; i += 1) if (!bd.cards[i].matched) sum += bd.cards[i].value;
    // H1O-matched cards still contribute face value even without bonus.
    for (let i = 0; i < GRID_SIZE; i += 1) if (bd.cards[i].matched && !bd.cards[i].cancelled) sum += bd.cards[i].value;
    return sum;
  });
  const [bumpKey, setBumpKey] = useState(0);

  useEffect(() => {
    if (skipped) { setChipIndex(bd.bonuses.length); setRunningScore(bd.total); return; }
    const timers = [];
    // Start chips after all cards have flipped.
    const cardsDoneAt = startDelay + GRID_SIZE * 80 + 250;
    bd.bonuses.forEach((b, i) => {
      timers.push(setTimeout(() => {
        setChipIndex(i + 1);
        setRunningScore((s) => s + b.pts);
        setBumpKey((k) => k + 1);
      }, cardsDoneAt + i * 360));
    });
    return () => timers.forEach(clearTimeout);
  }, [skipped, startDelay, bd.bonuses.length, bd.total]);

  return (
    <div className="p9-reveal-row">
      <div className="p9-reveal-row-header">
        <span className="p9-reveal-row-name">{player.name}{isMe ? ' (you)' : ''}</span>
        <span className="p9-reveal-row-score">
          <span key={bumpKey} className={`p9-reveal-total-val ${bumpKey > 0 ? 'bump' : ''}`}>
            {runningScore >= 0 ? '+' : ''}{runningScore}
          </span>
          <span className="p9-reveal-row-total">total {player.cumulativeScore}</span>
        </span>
      </div>
      <div className="p9-grid" style={{ justifyContent: 'flex-start' }}>
        {GRID_ORDER.map((i) => {
          const c = bd.cards[i];
          return (
            <Card
              key={i}
              card={c.value}
              matched={c.matched}
              cancelled={c.cancelled}
              animationClass={skipped ? '' : 'reveal-cascade'}
              style={skipped ? undefined : { '--cascade-delay': `${startDelay + i * 80}ms` }}
            />
          );
        })}
      </div>
      {bd.bonuses.length > 0 && chipIndex > 0 && (
        <div className="p9-reveal-bonuses">
          {bd.bonuses.slice(0, chipIndex).map((b, i) => (
            <span key={i} className="p9-reveal-chip">{b.label} {b.pts >= 0 ? '+' : ''}{b.pts}</span>
          ))}
        </div>
      )}
    </div>
  );
}
