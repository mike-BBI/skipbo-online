import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Card, EmptySlot } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { COLUMNS, GRID_SIZE, faceDownCount, scoreBreakdown } from './engine.js';
import { FlightLayer, FLIGHT_MS } from './Flight.jsx';
import { useHueFor, useTurnAnnounceKey, TurnBanner } from '../turnBanner.jsx';

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

function PlayerGrid({ player, highlightSlots = [], onSlotClick, revealAll = false, hiddenSlots = null }) {
  const flipping = useFlipTracker(player);
  return (
    <div className="p9-grid">
      {GRID_ORDER.map((i) => {
        const isFaceUp = revealAll || player.flipped[i];
        const onClick = onSlotClick ? () => onSlotClick(i) : undefined;
        // Active flight targeting this slot — hide its content so the
        // ghost card appears to "deliver" the new card.
        const hidden = hiddenSlots && hiddenSlots.has(i);
        const animClass = hidden
          ? 'p9-hidden'
          : (flipping.has(i) ? 'flipping-in' : '');
        return (
          <Card
            key={i}
            card={isFaceUp ? player.grid[i] : null}
            faceDown={!isFaceUp}
            onClick={onClick}
            selected={highlightSlots.includes(i)}
            animationClass={animClass}
            dataAttrs={{ 'data-p9-slot': `${player.id}-${i}` }}
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

// Given a new `lastAction`, returns the list of flights that should
// fire to illustrate it. Each flight has source/destination selectors
// and whatever card value the ghost should show while in flight. For
// opponent draws from the deck, the ghost is face-down so we don't
// leak information the real player wouldn't see.
function planFlights(action, state, myId) {
  if (!action) return [];
  const pid = action.playerId;
  const isSelf = pid === myId;
  const handSel = `[data-p9-hand="${pid}"]`;
  const deckSel = '[data-p9-pile="deck"]';
  const discardSel = '[data-p9-pile="discard"]';
  const slotSel = action.slot != null ? `[data-p9-slot="${pid}-${action.slot}"]` : null;

  switch (action.type) {
    case 'drawDeck': {
      const drawnVal = state.players[pid]?.drawn;
      return [{
        id: `fl-${action.stamp}-a`,
        fromSelector: deckSel,
        toSelector: handSel,
        card: isSelf ? drawnVal : null,
        faceDown: !isSelf,
        destKey: `hand-${pid}`,
        sourceKey: null,
      }];
    }
    case 'drawDiscard': {
      const drawnVal = state.players[pid]?.drawn;
      return [{
        id: `fl-${action.stamp}-a`,
        fromSelector: discardSel,
        toSelector: handSel,
        card: drawnVal,
        faceDown: false,
        destKey: `hand-${pid}`,
        sourceKey: null,
      }];
    }
    case 'replace': {
      // Two parallel flights:
      //   hand → slot (the placed card)
      //   slot → discard (the card that was in that slot)
      const placed = action.card;
      const replaced = action.replacedCard;
      return [
        {
          id: `fl-${action.stamp}-a`,
          fromSelector: handSel,
          toSelector: slotSel,
          card: placed,
          faceDown: false,
          destKey: `slot-${pid}-${action.slot}`,
          sourceKey: `hand-${pid}`,
        },
        {
          id: `fl-${action.stamp}-b`,
          fromSelector: slotSel,
          toSelector: discardSel,
          card: replaced,
          faceDown: false,
          destKey: `discard-${action.stamp}`,
          sourceKey: null,
        },
      ];
    }
    case 'discardAndFlip': {
      const discarded = state.discard[state.discard.length - 1];
      return [{
        id: `fl-${action.stamp}-a`,
        fromSelector: handSel,
        toSelector: discardSel,
        card: discarded,
        faceDown: false,
        destKey: `discard-${action.stamp}`,
        sourceKey: `hand-${pid}`,
      }];
    }
    case 'skip': {
      // Conceptually: draw from deck, then drop straight onto discard.
      // Fly deck → discard so the user sees the move happen.
      const discarded = state.discard[state.discard.length - 1];
      return [{
        id: `fl-${action.stamp}-a`,
        fromSelector: deckSel,
        toSelector: discardSel,
        card: discarded,
        faceDown: false,
        destKey: `discard-${action.stamp}`,
        sourceKey: null,
      }];
    }
    default:
      return [];
  }
}

export function Game({ state, myId, onAction, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const me = state.players[myId];
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);
  const isMyTurn = state.turn === myId && !state.holeEnded && !state.winner;
  const isTeeOff = state.phase === 'teeOff';

  const hueFor = useHueFor(state);

  const [flipMode, setFlipMode] = useState(false);
  useMemo(() => {
    if (!isMyTurn || !me?.drawn) setFlipMode(false);
  }, [isMyTurn, me?.drawn]);

  const [showChat, setShowChat] = useState(false);

  // Flight state. `flights` is the active ghost cards. `pending` is a
  // set of destination keys whose real DOM element should render blank
  // while the ghost is still on its way.
  const [flights, setFlights] = useState([]);
  const [pending, setPending] = useState(() => new Set());
  const [sourceHidden, setSourceHidden] = useState(() => new Set());
  const [previewLanded, setPreviewLanded] = useState(false);
  const turnAnnounceKey = useTurnAnnounceKey(state.turn, flights.length);
  const lastStampRef = useRef(state.lastAction?.stamp || 0);
  const flipModeRef = useRef(false);
  // When the player taps the discard pile (entering flip mode) with a
  // deck-drawn card, we fire a preview flight from hand → discard so
  // the "toss" is visible immediately rather than waiting for the
  // face-down pick. That means when the discardAndFlip action fires
  // on the subsequent slot click, we must suppress the normal
  // hand→discard flight so the motion doesn't play twice.
  const discardFlightSuppressedRef = useRef(false);

  // Use useLayoutEffect so `pending` is set before the browser paints
  // the post-action DOM — otherwise there'd be a one-frame flash of
  // the destination card in its final slot before the flight starts.
  useLayoutEffect(() => {
    const action = state.lastAction;
    if (!action) return;
    const stamp = action.stamp || 0;
    if (stamp <= lastStampRef.current) return;
    lastStampRef.current = stamp;

    let planned = planFlights(action, state, myId);
    if (action.type === 'discardAndFlip'
        && action.playerId === myId
        && discardFlightSuppressedRef.current) {
      planned = [];
      discardFlightSuppressedRef.current = false;
    }
    if (planned.length === 0) return;

    setFlights((fs) => [...fs, ...planned]);
    setPending((s) => {
      const next = new Set(s);
      for (const f of planned) if (f.destKey) next.add(f.destKey);
      return next;
    });
    setSourceHidden((s) => {
      const next = new Set(s);
      for (const f of planned) if (f.sourceKey) next.add(f.sourceKey);
      return next;
    });
  }, [state.lastAction?.stamp]);

  // Preview flight: fires when flipMode enters (tap discard) and
  // cleans up when it exits (either via discardAndFlip action or
  // Cancel). Defined AFTER the action scheduler so that on a slot
  // click the action scheduler runs with `discardFlightSuppressedRef`
  // still true, then this effect resets the flag.
  useLayoutEffect(() => {
    if (flipMode && !flipModeRef.current) {
      flipModeRef.current = true;
      discardFlightSuppressedRef.current = true;
      if (me?.drawn == null) return;
      const flight = {
        id: `preview-discard-${Date.now()}`,
        fromSelector: `[data-p9-hand="${myId}"]`,
        toSelector: '[data-p9-pile="discard"]',
        card: me.drawn,
        faceDown: false,
        destKey: 'preview-discard',
        sourceKey: `hand-${myId}`,
      };
      setFlights((fs) => [...fs, flight]);
      setPending((s) => new Set([...s, 'preview-discard']));
      setSourceHidden((s) => new Set([...s, `hand-${myId}`]));
    } else if (!flipMode && flipModeRef.current) {
      flipModeRef.current = false;
      discardFlightSuppressedRef.current = false;
      setPreviewLanded(false);
      setFlights((fs) => fs.filter((f) => !f.id.startsWith('preview-discard')));
      setPending((s) => { const n = new Set(s); n.delete('preview-discard'); return n; });
      setSourceHidden((s) => { const n = new Set(s); n.delete(`hand-${myId}`); return n; });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipMode]);

  const removeFlight = (id, destKey, sourceKey) => {
    setFlights((fs) => fs.filter((f) => f.id !== id));
    if (destKey) {
      setPending((s) => {
        const next = new Set(s);
        next.delete(destKey);
        return next;
      });
      if (destKey === 'preview-discard') setPreviewLanded(true);
    }
    if (sourceKey) {
      setSourceHidden((s) => {
        const next = new Set(s);
        next.delete(sourceKey);
        return next;
      });
    }
  };

  const drawPulse = useDrawPulse(state.deck?.length);

  // If flights are on their way to the discard pile, peel that many
  // cards off the visible top so the ghost card appears to land
  // rather than arriving at an already-updated pile. Also peel the
  // preview-discard flight while it's in the air.
  const pendingDiscardCount = Array.from(pending)
    .filter((k) => k.startsWith('discard-') || k === 'preview-discard').length;
  const discardLen = state.discard?.length ?? 0;
  // Once the preview has landed, the discard pile should *visually*
  // show `me.drawn` on top, even though the real state hasn't
  // committed it yet (the action fires on the next slot tap).
  const discardTop = (flipMode && previewLanded && me?.drawn != null)
    ? me.drawn
    : (discardLen > 0 ? state.discard[Math.max(0, discardLen - 1 - pendingDiscardCount)] : undefined);

  const hiddenSlotsFor = (playerId) => {
    const set = new Set();
    for (let i = 0; i < GRID_SIZE; i += 1) {
      if (pending.has(`slot-${playerId}-${i}`)) set.add(i);
    }
    return set.size ? set : null;
  };

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

  const hideSelfHand = pending.has(`hand-${myId}`) || sourceHidden.has(`hand-${myId}`) || flipMode;

  return (
    <div className="board playnine" style={{ position: 'relative' }}>
      <TurnBanner
        announceKey={turnAnnounceKey}
        hue={hueFor(state.turn)}
        name={state.players[state.turn]?.name}
        isMe={state.turn === myId}
        hidden={!!state.winner || !!state.holeEnded}
      />
      <div className="p9-top-bar">
        <div>Room <span className="room-code">{state.roomCode || ''}</span></div>
        <div className="p9-hole">Hole {state.hole}/{state.rules?.targetHoles ?? 9}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!state.holeEnded && state.undoSnapshot?.actor === myId && (
            <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onAction({ type: 'undo' })}>Undo</button>
          )}
          {!hideChat && (
            <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowChat((v) => !v)}>
              {showChat ? 'Hide' : 'Chat'}
            </button>
          )}
          <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div className="p9-opponents">
        {opponents.map((op) => {
          const opHandBusy = pending.has(`hand-${op.id}`) || sourceHidden.has(`hand-${op.id}`);
          const showOpHandCard = op.drawn != null && !opHandBusy;
          return (
            <div
              key={op.id}
              className={`p9-opponent ${op.id === state.turn ? 'active' : ''}`}
              ref={op.id === state.turn ? (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }) : null}
            >
              <div className="p9-opp-header">
                <span className="p9-opp-name">{op.name}</span>
                <span className="p9-opp-score">{op.cumulativeScore || 0}{op.puttedOut ? ' · out' : ''}</span>
              </div>
              {showOpHandCard ? (
                <div className="p9-opp-hand">
                  <Card
                    card={op.drawnSource === 'discard' ? op.drawn : null}
                    faceDown={op.drawnSource !== 'discard'}
                    dataAttrs={{ 'data-p9-hand': op.id }}
                  />
                </div>
              ) : (
                <div
                  className="p9-opp-hand empty"
                  data-p9-hand={op.id}
                  aria-hidden="true"
                />
              )}
              <PlayerGrid
                player={op}
                revealAll={showTableReveal}
                hiddenSlots={hiddenSlotsFor(op.id)}
              />
            </div>
          );
        })}
      </div>

      <div className="p9-center">
        <div className="p9-pile">
          <div className="p9-pile-label">Deck</div>
          <Card
            card={null}
            faceDown
            onClick={isMyTurn && !isTeeOff && !me.drawn ? onDrawDeck : undefined}
            animationClass={drawPulse ? 'draw-pulse' : ''}
            dataAttrs={{ 'data-p9-pile': 'deck' }}
          />
        </div>
        <div className="p9-drawn">
          <div className="p9-drawn-label">In hand</div>
          {me?.drawn != null && !hideSelfHand
            ? <Card
                key={`hand-${lastStampRef.current}-${me.drawnSource}`}
                card={me.drawn}
                animationClass=""
                dataAttrs={{ 'data-p9-hand': myId }}
              />
            : <EmptySlot dataAttrs={{ 'data-p9-hand': myId }} />
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
                dataAttrs={{ 'data-p9-pile': 'discard' }}
              />
            : (isMyTurn && me?.drawn != null && me.drawnSource === 'deck' && !flipMode
                ? <EmptySlot onClick={() => setFlipMode(true)} dataAttrs={{ 'data-p9-pile': 'discard' }} />
                : <EmptySlot dataAttrs={{ 'data-p9-pile': 'discard' }} />)
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
          hiddenSlots={hiddenSlotsFor(myId)}
        />
        <div className="p9-my-score-row">
          <span style={{ color: 'var(--muted)' }}>{fdLeft} face-down left</span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {!hideChat && showChat && (
        <Chat messages={chatMessages} onSend={onSendChat} />
      )}

      <FlightLayer flights={flights} onComplete={removeFlight} />

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
