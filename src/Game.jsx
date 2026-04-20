import { useEffect, useRef, useState } from 'react';
import { Card, EmptySlot, Stockpile, DiscardPile, Deck } from './Card.jsx';
import { Chat } from './Chat.jsx';
import { canPlayToBuild } from './engine.js';

// selection: { from: 'hand'|'stock'|'discard', index?: number }
export function Game({ state, myId, onAction, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const [selection, setSelection] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [expandedDiscard, setExpandedDiscard] = useState(null);

  const me = state.players[myId];
  const isMyTurn = state.turn === myId && !state.winner;
  const opponents = (() => {
    const others = state.playerOrder.filter((id) => id !== myId);
    if (others.length === 0) return [];
    // Anchor the left-most slot on whoever is "up". If it's my turn,
    // the anchor is the opponent immediately after me in turn order.
    let anchor;
    if (state.turn === myId) {
      const myPos = state.playerOrder.indexOf(myId);
      anchor = state.playerOrder[(myPos + 1) % state.playerOrder.length];
    } else {
      anchor = state.turn;
    }
    const ai = others.indexOf(anchor);
    const rotated = ai >= 0 ? [...others.slice(ai), ...others.slice(0, ai)] : others;
    return rotated.map((id) => state.players[id]);
  })();

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
          // If a hand card is selected, drop it. Otherwise toggle expand.
          if (selection?.from === 'hand') {
            onAction({ type: 'discard', handIndex: selection.index, discardPile: d.source.index });
            clearSel();
            setExpandedDiscard(null);
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

  return (
    <div className="board">
      <div className="top-bar">
        <div>
          Room <span className="room-code">{state.roomCode || ''}</span>
        </div>
        <div>Set aside: {state.completedPiles.length}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!hideChat && (
            <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowChat((v) => !v)}>
              {showChat ? 'Hide chat' : 'Chat'}
            </button>
          )}
          <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div className="opponents">
        {opponents.map((op) => (
          <div
            key={op.id}
            className={`opponent ${op.id === state.turn ? 'active' : ''}`}
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
        ))}
      </div>

      {!state.winner && isMyTurn && (
        <div className="turn-banner">Your turn</div>
      )}

      <div className="build-area">
        <div className="build-label">Build piles (1 → 12)</div>
        <div className="build-piles">
          <Deck count={state.deck.length} drawPulse={drawPulse} />
          {state.buildPiles.map((bp, i) => {
            const next = bp.length + 1;
            const playable = effectiveSelectedCard != null && canPlayToBuild(effectiveSelectedCard, bp);
            const dragOver = drag?.active && drag.overTarget === `build:${i}`;
            return (
              <div key={i} className="build-pile" data-drop={`build:${i}`}>
                {bp.length > 0
                  ? <Card
                      key={`bp${i}-${bp.length}`}
                      card={bp[bp.length - 1]}
                      onClick={() => onBuildPile(i)}
                      className={`fly-in ${playable ? 'target' : ''} ${dragOver ? 'drop-hover' : ''}`}
                    />
                  : <EmptySlot onClick={() => onBuildPile(i)} className={`${playable ? 'target' : ''} ${dragOver ? 'drop-hover' : ''}`} label={(selection || drag?.active) ? 'Play 1' : ''} />
                }
                <div className="next">{next <= 12 ? `Next: ${next}` : 'Done'}</div>
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
