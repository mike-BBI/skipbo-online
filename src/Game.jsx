import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, EmptySlot, Stockpile, DiscardPile, Deck } from './Card.jsx';
import { Chat } from './Chat.jsx';
import { canPlayToBuild, SKIPBO } from './engine.js';

// Build pile top: a wild card's "value" equals its position in the
// pile (pile length), so when a wild is on top we overlay a small
// badge with that number. Works correctly no matter how many wilds
// are stacked — the top-most wild always shows its effective value.
function BuildPileTop({ bp, onClick, className }) {
  const top = bp[bp.length - 1];
  if (top !== SKIPBO) {
    return <Card key={`bp-${bp.length}`} card={top} onClick={onClick} className={className} />;
  }
  return (
    <div className="wild-value-wrap" onClick={onClick}>
      <Card key={`bp-${bp.length}`} card={top} className={className} />
      <span className="wild-value-badge">{bp.length}</span>
    </div>
  );
}

// Curated, visually-distinct hue palette. The order is re-shuffled
// once per game (using state.seed) so opponents get fresh colors each
// time, but every client derives the same mapping from the same seed.
// Entries are spaced 45° apart around the color wheel so no two hues
// can read as "the same color" — important because the palette size
// equals MAX_PLAYERS, so every seat always gets a distinct hue.
const PLAYER_HUES = [20, 65, 110, 155, 200, 245, 290, 335];

// Mulberry32 PRNG — fast, deterministic, and good enough for a quick
// Fisher-Yates shuffle. Same seed → same sequence on every client.
function seededShuffle(seed, arr) {
  let s = (seed | 0) || 1;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// selection: { from: 'hand'|'stock'|'discard', index?: number }
export function Game({ state, myId, onAction, onRequestUndo, onVoteUndo, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const [selection, setSelection] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [expandedDiscard, setExpandedDiscard] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while a vote is active so the countdown updates.
  useEffect(() => {
    if (!state.undoVote) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.undoVote]);

  const me = state.players[myId];
  const isMyTurn = state.turn === myId && !state.winner;
  // Opponents stay in fixed turn order — scroll-into-view snaps to the
  // active player so you can track whose turn it is without reordering
  // the pane (which was visually disorienting mid-game).
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);

  // Pulse the deck briefly whenever the deck count decreases (a card was drawn).
  const [drawPulse, setDrawPulse] = useState(false);
  const prevDeckRef = useRef(state.deck.length);
  useEffect(() => {
    if (state.deck.length < prevDeckRef.current) {
      setDrawPulse(true);
      const t = setTimeout(() => setDrawPulse(false), 360);
      prevDeckRef.current = state.deck.length;
      return () => clearTimeout(t);
    }
    prevDeckRef.current = state.deck.length;
  }, [state.deck.length]);

  // Flash a banner each time the turn changes so the next player is
  // obviously signaled. Keyed so it remounts and re-animates on every
  // hand-off.
  const [turnAnnounceKey, setTurnAnnounceKey] = useState(0);
  const lastTurnRef = useRef(state.turn);
  useEffect(() => {
    if (lastTurnRef.current !== state.turn) {
      lastTurnRef.current = state.turn;
      setTurnAnnounceKey((k) => k + 1);
    }
  }, [state.turn]);

  // Completed-pile animation: when a build pile transitions from
  // non-empty to empty, briefly render the top card (retrieved from
  // completedPiles) with a celebratory scale+glow+fly-off, so the
  // completion is visible instead of vanishing instantly.
  const [completingPiles, setCompletingPiles] = useState([]);
  const prevBuildPilesRef = useRef(state.buildPiles);
  useEffect(() => {
    const prev = prevBuildPilesRef.current;
    const toAnimate = [];
    for (let i = 0; i < state.buildPiles.length; i++) {
      if ((prev[i]?.length || 0) > 0 && state.buildPiles[i].length === 0) {
        const topCard = state.completedPiles[state.completedPiles.length - 1];
        toAnimate.push({ pileIdx: i, card: topCard, key: `${Date.now()}-${i}` });
      }
    }
    if (toAnimate.length) {
      setCompletingPiles((prev) => [...prev, ...toAnimate]);
      const timers = toAnimate.map((a) =>
        setTimeout(() => {
          setCompletingPiles((cur) => cur.filter((x) => x.key !== a.key));
        }, 1300)
      );
      prevBuildPilesRef.current = state.buildPiles;
      return () => timers.forEach(clearTimeout);
    }
    prevBuildPilesRef.current = state.buildPiles;
  }, [state.buildPiles, state.completedPiles]);

  // Bump a key each time the hand grows so the cards remount and the
  // staggered deal animation plays one card at a time.
  const [dealKey, setDealKey] = useState(0);
  const prevHandLenRef = useRef(me?.hand.length ?? 0);
  useEffect(() => {
    const len = me?.hand.length ?? 0;
    if (len > prevHandLenRef.current) setDealKey((k) => k + 1);
    prevHandLenRef.current = len;
  }, [me?.hand.length]);

  const clearSel = () => setSelection(null);

  const cardAt = (sel) => {
    if (!sel || !me) return null;
    if (sel.from === 'hand') return me.hand[sel.index];
    if (sel.from === 'stock') return me.stock[me.stock.length - 1];
    if (sel.from === 'discard') {
      const d = me.discards[sel.index];
      return d[d.length - 1];
    }
    return null;
  };

  // Drag-and-drop: pointer-based so it works on mouse + touch. Tap-to-
  // select still works — a short press with no movement falls through
  // to the click behavior.
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  dragRef.current = drag;
  const draggedCard = drag ? cardAt(drag.source) : null;
  const effectiveSelectedCard = draggedCard ?? cardAt(selection);

  const selectIfMine = (sel) => {
    if (!isMyTurn) return;
    setSelection((prev) =>
      prev && prev.from === sel.from && prev.index === sel.index ? null : sel
    );
  };

  function startDrag(source, e) {
    if (!isMyTurn || state.winner) return;
    const card = e.currentTarget;
    try { card.setPointerCapture(e.pointerId); } catch {}
    setDrag({
      source,
      pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      x: e.clientX, y: e.clientY,
      active: false,
      overTarget: null,
    });

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      const active = d.active || Math.hypot(dx, dy) > 8;
      let overTarget = null;
      if (active) {
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
        overTarget = el?.dataset.drop || null;
      }
      setDrag({ ...d, x: ev.clientX, y: ev.clientY, active, overTarget });
    };
    const onUp = (ev) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.pointerId) return;
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);
      setDrag(null);
      if (d.active && d.overTarget) {
        commitDrop(d.source, d.overTarget);
      } else if (!d.active) {
        // Treat as a tap.
        if (d.source.from === 'discard') {
          // If a hand card is selected, drop it. If this pile is already
          // the current selection, toggle it off. Otherwise make this
          // pile the selection (so the next tap on a build pile plays
          // its top card) and expand it so the player can see what's
          // underneath.
          if (selection?.from === 'hand') {
            onAction({ type: 'discard', handIndex: selection.index, discardPile: d.source.index });
            clearSel();
            setExpandedDiscard(null);
          } else if (selection?.from === 'discard' && selection.index === d.source.index) {
            clearSel();
            setExpandedDiscard(null);
          } else if (isMyTurn) {
            setSelection({ from: 'discard', index: d.source.index });
            setExpandedDiscard(d.source.index);
          } else {
            setExpandedDiscard((cur) => (cur === d.source.index ? null : d.source.index));
          }
        } else {
          selectIfMine(d.source);
        }
      }
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
  }

  function commitDrop(source, target) {
    const [kind, idxStr] = target.split(':');
    const idx = Number(idxStr);
    if (kind === 'build') {
      onAction({ type: 'play', from: source.from, index: source.index, buildPile: idx });
    } else if (kind === 'discard' && source.from === 'hand') {
      onAction({ type: 'discard', handIndex: source.index, discardPile: idx });
    }
    clearSel();
  }

  const onBuildPile = (bpIdx) => {
    if (!isMyTurn || !selection) return;
    onAction({ type: 'play', from: selection.from, index: selection.index, buildPile: bpIdx });
    clearSel();
  };

  const undoVote = state.undoVote;
  const isUndoVoter = undoVote && undoVote.voters.includes(myId) && myId !== undoVote.requester;
  const myVote = isUndoVoter ? undoVote.votes[myId] : undefined;
  const secondsLeft = undoVote ? Math.max(0, Math.ceil((undoVote.deadlineAt - now) / 1000)) : 0;
  const requesterName = undoVote ? state.players[undoVote.requester]?.name || 'Someone' : '';
  const yesCount = undoVote ? Object.values(undoVote.votes).filter((v) => v === true).length : 0;
  const noCount = undoVote ? Object.values(undoVote.votes).filter((v) => v === false).length : 0;

  const shuffledPalette = useMemo(() => seededShuffle(state.seed || 0, PLAYER_HUES), [state.seed]);
  const hueFor = (id) => {
    const idx = state.playerOrder.indexOf(id);
    if (idx < 0) return 153;
    return shuffledPalette[idx % shuffledPalette.length];
  };
  const activeHue = hueFor(state.turn);
  const activePlayerName = state.turn === myId ? 'Your' : `${state.players[state.turn]?.name || 'Player'}'s`;

  return (
    <div className="board">
      {!state.winner && turnAnnounceKey > 0 && (
        <div
          key={turnAnnounceKey}
          className="turn-announcement"
          style={{ '--player-hue': activeHue }}
        >
          {activePlayerName} turn
        </div>
      )}
      {undoVote && (
        <div className="undo-banner">
          <div className="undo-banner-row">
            <strong>{requesterName}</strong> wants to undo their last move.
            <span className="undo-banner-meta">
              {yesCount}/{undoVote.required} yes · {noCount} no · {secondsLeft}s
            </span>
          </div>
          {isUndoVoter && typeof myVote !== 'boolean' && onVoteUndo && (
            <div className="undo-banner-actions">
              <button onClick={() => onVoteUndo(true)}>Allow</button>
              <button className="secondary" onClick={() => onVoteUndo(false)}>Deny</button>
            </div>
          )}
          {isUndoVoter && typeof myVote === 'boolean' && (
            <div className="undo-banner-meta">You voted {myVote ? 'allow' : 'deny'}.</div>
          )}
          {myId === undoVote.requester && (
            <div className="undo-banner-meta">Waiting for the others…</div>
          )}
        </div>
      )}
      <div className="top-bar">
        <div>
          Room <span className="room-code">{state.roomCode || ''}</span>
        </div>
        <div>Set aside: {state.completedPiles.length}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {state.undoAvailable && state.lastActor === myId && !state.undoVote && !state.winner && onRequestUndo && (
            <button
              className="secondary"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={onRequestUndo}
              title="Ask other players to let you take back your last action."
            >
              Undo
            </button>
          )}
          {!hideChat && (
            <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowChat((v) => !v)}>
              {showChat ? 'Hide chat' : 'Chat'}
            </button>
          )}
          <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div className="opponents">
        {opponents.map((op) => {
          const hue = hueFor(op.id);
          return (
          <div
            key={op.id}
            className={`opponent ${op.id === state.turn ? 'active' : ''}`}
            style={{ '--player-hue': hue }}
            ref={op.id === state.turn ? (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }) : null}
          >
            <div className="opp-header">
              <span className="opp-name">{op.name}{op.id === state.turn ? ' ▶' : ''}</span>
              <MiniHand count={op.hand.length} />
            </div>
            <div className="opp-body">
              <Stockpile
                topCard={op.stock[op.stock.length - 1]}
                count={op.stock.length}
              />
              <div className="discard-row opp-discards">
                {op.discards.map((d, i) => (
                  <DiscardPile key={i} cards={d} compact />
                ))}
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {!state.winner && (
        isMyTurn
          ? <div className="turn-banner">Your turn</div>
          : <div className="turn-banner waiting">{state.players[state.turn]?.name || 'Someone'}'s turn</div>
      )}

      <div className="build-area">
        <div className="build-label">Build piles</div>
        <div className="build-piles">
          <Deck count={state.deck.length} drawPulse={drawPulse} />
          {state.buildPiles.map((bp, i) => {
            const next = bp.length + 1;
            const playable = effectiveSelectedCard != null && canPlayToBuild(effectiveSelectedCard, bp);
            const dragOver = drag?.active && drag.overTarget === `build:${i}`;
            const completing = completingPiles.find((c) => c.pileIdx === i);
            return (
              <div key={i} className="build-pile" data-drop={`build:${i}`}>
                {completing ? (
                  <Card key={completing.key} card={completing.card} className="pile-complete" />
                ) : bp.length > 0
                  ? <BuildPileTop
                      bp={bp}
                      onClick={() => onBuildPile(i)}
                      className={`fly-in ${playable ? 'target' : ''} ${dragOver ? 'drop-hover' : ''}`}
                    />
                  : <EmptySlot onClick={() => onBuildPile(i)} className={`${playable ? 'target' : ''} ${dragOver ? 'drop-hover' : ''}`} label={(selection || drag?.active) ? 'Play 1' : ''} />
                }
              </div>
            );
          })}
        </div>
      </div>

      <div className="my-area">
        <div className="my-stock-wrap">
          <div className="my-section-label">Your stock</div>
          <div onPointerDown={(e) => me.stock.length > 0 && startDrag({ from: 'stock' }, e)} style={{ touchAction: 'none' }}>
            <Stockpile
              topCard={me.stock[me.stock.length - 1]}
              count={me.stock.length}
              selected={selection?.from === 'stock'}
              label=""
            />
          </div>
        </div>

        <div className="my-discards-wrap">
          <div className="my-section-label">Your discard piles</div>
          <div className="discard-row">
            {me.discards.map((d, i) => {
              const isSelected = selection?.from === 'discard' && selection.index === i;
              const targetable = selection?.from === 'hand' || (drag?.active && drag.source.from === 'hand');
              const dragOver = drag?.active && drag.overTarget === `discard:${i}`;
              const isExpanded = expandedDiscard === i;
              // For empty piles (no cards to drag), use onClick so tap
              // still triggers the discard-drop action.
              const onEmptyClick = () => {
                if (selection?.from === 'hand') {
                  onAction({ type: 'discard', handIndex: selection.index, discardPile: i });
                  clearSel();
                }
              };
              return (
                <div
                  key={i}
                  data-drop={`discard:${i}`}
                  onPointerDown={(e) => d.length > 0 && startDrag({ from: 'discard', index: i }, e)}
                  onClick={d.length === 0 ? onEmptyClick : undefined}
                  style={{ touchAction: 'none' }}
                  className={dragOver ? 'drop-hover-wrap' : ''}
                >
                  <DiscardPile
                    cards={d}
                    selected={isSelected}
                    targetable={targetable}
                    expanded={isExpanded}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="hand-wrap">
        <div className="my-section-label">Your hand ({me.hand.length})</div>
        <div className="hand" key={dealKey}>
          {me.hand.length === 0 && <span style={{ color: 'var(--muted)' }}>Empty</span>}
          {me.hand.map((c, i) => {
            const isDragging = drag?.active && drag.source.from === 'hand' && drag.source.index === i;
            return (
              <div
                key={i}
                onPointerDown={(e) => startDrag({ from: 'hand', index: i }, e)}
                style={{ touchAction: 'none' }}
              >
                <Card
                  card={c}
                  selected={selection?.from === 'hand' && selection.index === i}
                  className={`dealing ${isDragging ? 'card-dragging' : ''}`}
                  style={{ animationDelay: `${i * 90}ms` }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {selection && (
        <div className="actions">
          <button className="secondary" onClick={clearSel}>Deselect</button>
        </div>
      )}

      {showChat && !hideChat && <Chat messages={chatMessages} onSend={onSendChat} compact />}

      <div className="log">
        {state.log.slice(-8).map((line, i) => <div key={i}>{line}</div>)}
      </div>

      {state.winner && (
        <div className="winner-overlay">
          <h2>{state.winner === myId ? '🎉 You won!' : `${state.players[state.winner].name} wins`}</h2>
          <button onClick={onLeave}>Back to lobby</button>
        </div>
      )}

      {drag?.active && draggedCard !== undefined && (
        <div
          className="drag-ghost"
          style={{ left: drag.x, top: drag.y }}
        >
          <Card card={draggedCard} />
        </div>
      )}
    </div>
  );
}

function MiniHand({ count }) {
  const MAX_VISIBLE = 6;
  const visible = Math.min(count, MAX_VISIBLE);
  const offset = 7;
  const cardWidth = 18;
  const fanWidth = visible > 0 ? cardWidth + (visible - 1) * offset : cardWidth;
  return (
    <div className="mini-hand">
      <div className="mini-hand-fan" style={{ width: fanWidth }}>
        {count === 0 ? (
          <div className="mini-hand-empty" />
        ) : (
          Array.from({ length: visible }).map((_, i) => (
            <div key={i} className="mini-hand-card" style={{ left: i * offset, zIndex: i }} />
          ))
        )}
      </div>
      <span className="mini-hand-count">{count}</span>
    </div>
  );
}
