import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, EmptySlot } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { COLUMNS, GRID_SIZE, faceDownCount, scoreBreakdown } from './engine.js';

// After the last play of a hole, we want to (a) flip every player's
// face-down cards on the board so all scoring is visible on the table,
// and (b) hold that state for a beat so the player can read each hand
// before the detailed scorecard opens. BOARD_REVEAL_HOLD_MS controls
// how long before the Continue button appears.
const BOARD_REVEAL_HOLD_MS = 2400;

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

function PlayerGrid({ player, highlightSlots = [], onSlotClick, revealAll = false, placedSlot = null, placedKey = 0, isSelf = false }) {
  const flipping = useFlipTracker(player);
  return (
    <div className="p9-grid">
      {GRID_ORDER.map((i) => {
        const isFaceUp = revealAll || player.flipped[i];
        const onClick = onSlotClick ? () => onSlotClick(i) : undefined;
        // Two different animation paths for the target slot:
        // - "placed": a replace action just put a new card here — slide
        //   the new card in from the hand direction (above the grid for
        //   self, below for opponents) while flipping face-up. Keyed on
        //   placedKey so it replays every time a new card is placed.
        // - "flipping-in": normal face-down → face-up (teeOffFlip or
        //   discardAndFlip), a simple reveal without a slide-in.
        const justPlaced = i === placedSlot;
        const animClass = justPlaced
          ? `p9-placed ${isSelf ? 'from-above' : 'from-below'}`
          : (flipping.has(i) ? 'flipping-in' : '');
        const key = justPlaced ? `${i}-placed-${placedKey}` : i;
        return (
          <Card
            key={key}
            card={isFaceUp ? player.grid[i] : null}
            faceDown={!isFaceUp}
            onClick={onClick}
            selected={highlightSlots.includes(i)}
            animationClass={animClass}
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

  // Derive per-player "just placed" slot from lastAction so each grid
  // can replay the placed-from-hand animation without needing refs or
  // imperative positioning. Keyed by lastAction.stamp so a repeated
  // slot still retriggers the animation.
  const lastAction = state.lastAction;
  const placedStamp = lastAction?.stamp || 0;
  const placedSlotFor = (playerId) => (
    lastAction && lastAction.playerId === playerId && lastAction.type === 'replace'
      ? lastAction.slot
      : null
  );

  // Two-step reveal: wait for the final move animation to land, then
  // show a tap-prompt. The scorecard overlay only opens once the user
  // acknowledges the prompt.
  const [revealOpen, setRevealOpen] = useState(false);
  const [promptReady, setPromptReady] = useState(false);
  useEffect(() => {
    if (!state.holeEnded) {
      setRevealOpen(false);
      setPromptReady(false);
      return;
    }
    setRevealOpen(false);
    setPromptReady(false);
    const t = setTimeout(() => setPromptReady(true), BOARD_REVEAL_HOLD_MS);
    return () => clearTimeout(t);
  }, [state.holeEnded, state.hole, state.winner]);

  const showTableReveal = !!state.holeEnded;

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
      prompt = `Drew ${labelFor(me.drawn)}. Tap a card to swap, or tap the discard to toss it.`;
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
            <PlayerGrid
              player={op}
              revealAll={showTableReveal}
              placedSlot={placedSlotFor(op.id)}
              placedKey={placedStamp}
              isSelf={false}
            />
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
            ? <Card
                key={`hand-${placedStamp}-${me.drawnSource}`}
                card={me.drawn}
                animationClass={me.drawnSource === 'deck' ? 'p9-drawn-from-deck' : 'p9-drawn-from-discard'}
              />
            : <EmptySlot />
          }
        </div>
        <div className="p9-pile">
          <div className="p9-pile-label">Discard</div>
          {discardTop != null
            ? <Card
                card={discardTop}
                onClick={
                  isMyTurn && !isTeeOff && !me.drawn
                    ? onDrawDiscard
                    : (isMyTurn && me?.drawn != null && me.drawnSource === 'deck' && !flipMode
                        ? () => setFlipMode(true)
                        : undefined)
                }
                animationClass={discardPop ? 'discard-pop' : ''}
              />
            : (isMyTurn && me?.drawn != null && me.drawnSource === 'deck' && !flipMode
                ? <EmptySlot onClick={() => setFlipMode(true)} />
                : <EmptySlot />)
          }
        </div>
      </div>

      <div className={`p9-prompt ${isMyTurn ? 'active' : ''}`}>{prompt}</div>

      <div className="p9-actions">
        {state.holeEnded && promptReady && !revealOpen && (
          <button onClick={() => setRevealOpen(true)} style={{ padding: '10px 22px', fontSize: 15 }}>
            {state.winner ? 'See final scorecard →' : 'Continue →'}
          </button>
        )}
        {!state.holeEnded && isMyTurn && state.phase === 'play' && !me.drawn && fdLeft === 1 && !state.puttingOutBy && (
          <button className="secondary" onClick={onSkip}>Skip (line up your putt)</button>
        )}
        {!state.holeEnded && isMyTurn && flipMode && (
          <button className="secondary" onClick={cancelFlipMode}>Cancel discard</button>
        )}
        {!state.holeEnded && state.undoSnapshot?.actor === myId && (
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
          revealAll={showTableReveal}
          placedSlot={placedSlotFor(myId)}
          placedKey={placedStamp}
          isSelf={true}
        />
        <div className="p9-my-score-row">
          <span style={{ color: 'var(--muted)' }}>{fdLeft} face-down left</span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!hideChat && showChat && (
        <Chat messages={chatMessages} onSend={onSendChat} />
      )}

      {state.holeEnded && revealOpen && (
        <RoundReveal state={state} myId={myId} onNext={() => onAction({ type: 'nextHole' })} onLeave={onLeave} />
      )}
    </div>
  );
}

function labelFor(v) {
  if (v === -5) return 'Hole-in-One (-5)';
  return String(v);
}


// End-of-hole reveal modeled on the physical Play Nine scorecard:
// one row per hole, one column per player, running total at the
// bottom. The just-finished hole is highlighted; each player's
// score for that hole fills in with a staggered "cell-flash" so the
// eye can follow who scored what. Per-player bonus chips for the
// current hole appear below the scorecard so you can see WHY the
// numbers came out that way.
function RoundReveal({ state, myId, onNext, onLeave }) {
  const isMatchEnd = !!state.winner;
  const players = state.playerOrder.map((id) => state.players[id]);
  const target = state.rules?.targetHoles ?? 9;
  const currentHole = state.hole;

  const breakdowns = useMemo(
    () => players.map((p) => ({ p, bd: scoreBreakdown(p.grid) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.version],
  );

  const [cellsFilled, setCellsFilled] = useState(0);
  const [chipsFilled, setChipsFilled] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [actionsReady, setActionsReady] = useState(false);

  useEffect(() => {
    if (skipped) {
      setCellsFilled(players.length);
      setChipsFilled(players.length);
      setActionsReady(true);
      return;
    }
    const timers = [];
    players.forEach((_, i) => {
      timers.push(setTimeout(() => setCellsFilled(i + 1), 350 + i * 320));
    });
    const cellsEndAt = 350 + players.length * 320;
    players.forEach((_, i) => {
      timers.push(setTimeout(() => setChipsFilled(i + 1), cellsEndAt + 150 + i * 220));
    });
    const chipsEndAt = cellsEndAt + 150 + players.length * 220;
    timers.push(setTimeout(() => setActionsReady(true), chipsEndAt + 300));
    return () => timers.forEach(clearTimeout);
  }, [skipped, players.length]);

  return (
    <div className="p9-reveal-overlay">
      <div className="p9-reveal-title">
        {isMatchEnd
          ? (state.winner === myId ? '🏆 You won the match!' : `${state.players[state.winner].name} wins the match`)
          : `Hole ${state.hole} complete`}
      </div>

      <Scorecard
        state={state}
        myId={myId}
        currentHole={currentHole}
        target={target}
        players={players}
        cellsFilled={cellsFilled}
      />

      <div className="p9-reveal-bonus-rows">
        {breakdowns.slice(0, chipsFilled).map(({ p, bd }) => (
          <div key={p.id} className="p9-reveal-bonus-row">
            <span className="p9-reveal-bonus-row-name">
              {p.name}{p.id === myId ? ' (you)' : ''}
            </span>
            {bd.bonuses.length === 0 ? (
              <span className="p9-reveal-chip no-bonus">no bonuses this hole</span>
            ) : (
              bd.bonuses.map((b, i) => (
                <span key={i} className="p9-reveal-chip">{b.label} {b.pts >= 0 ? '+' : ''}{b.pts}</span>
              ))
            )}
          </div>
        ))}
      </div>

      <div className="p9-reveal-actions">
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

function Scorecard({ state, myId, currentHole, target, players, cellsFilled }) {
  // Leader = lowest cumulative score. Flag in the total row so you
  // can see the standings at a glance. Match-end: leader = winner.
  let leader = players[0];
  for (const p of players) {
    if (p.cumulativeScore < leader.cumulativeScore) leader = p;
  }

  return (
    <div className="p9-scorecard" style={{ '--players': players.length }}>
      <div className="p9-scorecard-row header">
        <div className="p9-scorecard-cell hole-cell">Hole</div>
        {players.map((p) => (
          <div key={p.id} className={`p9-scorecard-cell ${p.id === myId ? 'is-me' : ''}`}>
            {p.name}
          </div>
        ))}
      </div>
      {Array.from({ length: target }, (_, i) => {
        const hole = i + 1;
        const isCurrent = hole === currentHole;
        return (
          <div key={hole} className={`p9-scorecard-row ${isCurrent ? 'current' : ''}`}>
            <div className="p9-scorecard-cell hole-cell">
              <span className="p9-flag" aria-hidden="true">⛳</span>
              <span>{hole}</span>
            </div>
            {players.map((p, pIdx) => {
              const sc = p.roundScores[i];
              const visible = sc != null && (!isCurrent || pIdx < cellsFilled);
              const justFilled = isCurrent && pIdx < cellsFilled;
              return (
                <div
                  key={p.id}
                  className={`p9-scorecard-cell score-cell ${justFilled ? 'just-filled' : ''}`}
                >
                  {visible ? formatScore(sc) : ''}
                </div>
              );
            })}
          </div>
        );
      })}
      <div className="p9-scorecard-row total">
        <div className="p9-scorecard-cell hole-cell">Total</div>
        {players.map((p) => (
          <div
            key={p.id}
            className={`p9-scorecard-cell total-cell ${p.id === leader.id ? 'leader' : ''}`}
          >
            {p.cumulativeScore}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatScore(s) {
  if (s == null) return '';
  if (s > 0) return '+' + s;
  return String(s);
}
