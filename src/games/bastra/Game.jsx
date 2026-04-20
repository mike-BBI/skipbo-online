import { useEffect, useMemo, useRef, useState } from 'react';
import { PlayingCard } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { isValidCapture, RANK_JACK } from './engine.js';

// Curated hue palette (same spacing idea as Skip-Bo).
const PLAYER_HUES = [20, 65, 110, 155, 200, 245, 290, 335];
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

export function Game({ state, myId, onAction, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const [showChat, setShowChat] = useState(false);

  const me = state.players[myId];
  const isMyTurn = state.turn === myId && !state.winner;
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);

  const shuffledPalette = useMemo(() => seededShuffle(state.seed || 0, PLAYER_HUES), [state.seed]);
  const hueFor = (id) => {
    const idx = state.playerOrder.indexOf(id);
    if (idx < 0) return 153;
    return shuffledPalette[idx % shuffledPalette.length];
  };

  // Interactive capture: click a hand card to select it, then click
  // table cards to build a capture set. Confirm commits; the engine
  // validates that the set is partitionable into sum/rank groups.
  const [selectedHandIdx, setSelectedHandIdx] = useState(null);
  const [selectedTable, setSelectedTable] = useState([]); // array of indices

  // If the state changes (opponent moved, new deal), drop any stale
  // selection — the table indices may no longer mean what they did.
  useEffect(() => {
    setSelectedHandIdx(null);
    setSelectedTable([]);
  }, [state.turn, state.round]);

  // Celebratory overlay when any seat scores a Bastra. Watch for
  // increments to bastraCount, fire an announcement, let it sit for
  // ~2 seconds, then fade.
  const [bastraEvent, setBastraEvent] = useState(null); // { playerId, key }
  const lastBastraCountsRef = useRef(null);
  useEffect(() => {
    const prev = lastBastraCountsRef.current;
    const current = {};
    for (const id of state.playerOrder) current[id] = state.players[id]?.bastraCount || 0;
    lastBastraCountsRef.current = current;
    if (!prev) return;
    for (const id of state.playerOrder) {
      if ((current[id] || 0) > (prev[id] || 0)) {
        setBastraEvent({ playerId: id, key: Date.now() + ':' + id });
        const t = setTimeout(() => setBastraEvent(null), 2200);
        return () => clearTimeout(t);
      }
    }
  }, [state.players, state.playerOrder]);

  // Move animation: play every completed move out directly on the
  // table — the played card flies into place, captures highlight and
  // sweep off, Jacks blanket the whole board before carrying the
  // cards away. Applies to both the human's own moves and opponents'
  // so the feedback is symmetrical.
  const [animEvent, setAnimEvent] = useState(null);
  const lastMoveVersionRef = useRef(state.version);
  useEffect(() => {
    if (state.version === lastMoveVersionRef.current) return;
    lastMoveVersionRef.current = state.version;
    const lm = state.lastMove;
    if (!lm) { setAnimEvent(null); return; }
    setAnimEvent({ ...lm, key: `anim-${state.version}` });
    const t = setTimeout(() => setAnimEvent(null), 1700);
    return () => clearTimeout(t);
  }, [state.version, state.lastMove]);

  const selectedCard = selectedHandIdx != null ? me?.hand[selectedHandIdx] : null;
  const selectedRanks = selectedTable.map((i) => state.table[i]?.rank).filter((r) => r != null);
  const captureIsValid = selectedCard ? isValidCapture(selectedCard.rank, selectedRanks) : false;
  const isJackSelected = selectedCard?.rank === RANK_JACK;

  // Either-order selection: the player can click a card on the table
  // first to start building a capture set, then tap the hand card
  // that completes it — or vice versa. The selection state in each
  // area is independent; clicking a different hand card just swaps
  // which one is selected without dropping the table selection.
  const toggleHandSelect = (i) => {
    if (!isMyTurn || state.winner) return;
    setSelectedHandIdx((cur) => (cur === i ? null : i));
  };

  const toggleTableSelect = (i) => {
    if (!isMyTurn || state.winner) return;
    if (isJackSelected) return; // Jack auto-sweeps; no manual selection
    setSelectedTable((cur) =>
      cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]
    );
  };

  const confirmPlay = () => {
    if (!isMyTurn || state.winner) return;
    if (selectedHandIdx == null) return;
    // Jack sweeps the whole table regardless of what's selected.
    const indices = isJackSelected ? state.table.map((_, i) => i) : selectedTable;
    onAction({ type: 'play', handIndex: selectedHandIdx, tableIndices: indices });
    setSelectedHandIdx(null);
    setSelectedTable([]);
  };

  const cancelSelection = () => {
    setSelectedHandIdx(null);
    setSelectedTable([]);
  };

  return (
    <div className="board bastra">
      {bastraEvent && (
        <div
          key={bastraEvent.key}
          className="bastra-celebrate"
          style={{ '--player-hue': hueFor(bastraEvent.playerId) }}
        >
          <div className="bastra-celebrate-label">BASTRA</div>
          <div className="bastra-celebrate-name">
            {bastraEvent.playerId === myId ? 'You swept the table!' : `${state.players[bastraEvent.playerId]?.name || 'Someone'} swept the table!`}
          </div>
          <div className="bastra-celebrate-bonus">+{state.rules.bastraPoints ?? 10}</div>
        </div>
      )}



      <div className="top-bar">
        <div>Room <span className="room-code">{state.roomCode || ''}</span></div>
        <div>Deck: {state.deck.length}</div>
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
            style={{ '--player-hue': hueFor(op.id) }}
            ref={op.id === state.turn ? (el) => el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }) : null}
          >
            <div className="opp-header">
              <span className="opp-name">{op.name}{op.id === state.turn ? ' ▶' : ''}</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{op.hand.length} card{op.hand.length === 1 ? '' : 's'}</span>
            </div>
            <div className="opp-body" style={{ display: 'flex', gap: 4 }}>
              {op.hand.map((_, i) => (
                <PlayingCard key={i} faceDown className="mini" />
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Captured: {op.captures.length}{op.bastraCount > 0 ? ` · ${op.bastraCount} Bastra${op.bastraCount > 1 ? 's' : ''}` : ''}
            </div>
          </div>
        ))}
      </div>

      {!state.winner && (
        isMyTurn
          ? <div className="turn-banner">Your turn</div>
          : <div className="turn-banner waiting">{state.players[state.turn]?.name || 'Someone'}'s turn</div>
      )}

      <div className="build-area">
        <div className="build-label">Table</div>
        {/* Jack sweep overlay — when a J is played on a non-empty
            table the giant J floats in over the whole area, the
            cards slide under it, then everything sweeps off together. */}
        {animEvent && animEvent.card?.rank === 11 && animEvent.capturedCards.length > 0 && (
          <div
            key={animEvent.key}
            className="jack-sweep-overlay"
            style={{ '--player-hue': hueFor(animEvent.playerId) }}
          >
            <PlayingCard card={animEvent.card} className="jack-sweep-card" />
          </div>
        )}
        {(() => {
          // Build the display list. In the steady state it's just
          // state.table. During an opponent capture animation we
          // reconstruct the pre-move table (captured cards at their
          // original positions) and append the played card so the
          // user can watch the capture play out in place.
          const items = [];
          if (animEvent && animEvent.capturedCards.length > 0) {
            const positions = new Set(animEvent.capturedPositions);
            const capByPos = new Map();
            animEvent.capturedPositions.forEach((pos, k) => capByPos.set(pos, animEvent.capturedCards[k]));
            const total = state.table.length + animEvent.capturedCards.length;
            let stateIdx = 0;
            for (let i = 0; i < total; i++) {
              if (positions.has(i)) {
                const c = capByPos.get(i);
                items.push({ key: `cap-${c.rank}-${c.suit}`, card: c, capturing: true });
              } else {
                const c = state.table[stateIdx++];
                items.push({ key: `t-${c.rank}-${c.suit}`, card: c, idx: stateIdx - 1 });
              }
            }
            items.push({
              key: `played-${animEvent.card.rank}-${animEvent.card.suit}`,
              card: animEvent.card,
              capturing: true,
              played: true,
            });
          } else if (animEvent && animEvent.placed) {
            // Place-only animation: state.table already has the played
            // card. Flag it so CSS can fly it in.
            state.table.forEach((c, i) => {
              items.push({
                key: `t-${c.rank}-${c.suit}`,
                card: c,
                idx: i,
                justPlaced: i === (animEvent.placedIndex ?? state.table.length - 1),
              });
            });
          } else {
            state.table.forEach((c, i) => {
              items.push({ key: `t-${c.rank}-${c.suit}`, card: c, idx: i });
            });
          }

          if (items.length === 0) {
            // Empty table: show four dashed placeholder slots in a
            // 2x2 grid so the area reads as "these spots are empty"
            // rather than printing text that disappears once cards
            // land. Matches the Skip-Bo empty-pile treatment.
            const slotCount = state.rules.tableInitSize || 4;
            return (
              <div className="bastra-table">
                {Array.from({ length: slotCount }).map((_, i) => (
                  <PlayingCard key={`slot-${i}`} card={null} className="table-slot" />
                ))}
              </div>
            );
          }

          // Explicit grid positions so the table fills the same way
          // every time, regardless of insertion order:
          //   1      → top-left
          //   2      → top-right
          //   3      → bottom-left (upside-down L)
          //   4      → bottom-right (full 2x2)
          //   5, 6   → add column 3: top, then bottom
          //   7, 8   → add column 4: top, then bottom
          //   ...    → each new pair fills a fresh column.
          const gridPos = (i) => {
            if (i < 4) return { row: Math.floor(i / 2) + 1, col: (i % 2) + 1 };
            const beyond = i - 4;
            return { row: (beyond % 2) + 1, col: Math.floor(beyond / 2) + 3 };
          };
          return (
            <div className="bastra-table">
              {items.map((item, gridIdx) => {
                const sel = item.idx !== undefined && selectedTable.includes(item.idx);
                const classes = [
                  item.capturing ? 'capturing' : '',
                  item.played ? 'played-incoming' : '',
                  item.justPlaced ? 'just-placed' : '',
                  !animEvent && isMyTurn && !isJackSelected ? 'playable' : '',
                ].filter(Boolean).join(' ');
                const onClick = !animEvent && item.idx !== undefined
                  ? () => toggleTableSelect(item.idx)
                  : undefined;
                const { row, col } = gridPos(gridIdx);
                return (
                  <PlayingCard
                    key={item.key}
                    card={item.card}
                    onClick={onClick}
                    selected={sel}
                    className={classes}
                    style={{ gridRow: row, gridColumn: col }}
                  />
                );
              })}
            </div>
          );
        })()}
        {/* Controls slot reserves a fixed height even when empty so
            the Table container doesn't shift between selection and
            idle states. Inner controls appear/disappear inside. */}
        <div className="capture-controls-slot">
          {(selectedHandIdx != null || selectedTable.length > 0) && !state.winner && !state.roundEnded && (
            (() => {
              let message = '';
              let messageTone = 'muted';
              let primaryLabel = null;
              let primaryAction = null;

              if (selectedHandIdx == null) {
                message = `${selectedTable.length} table card${selectedTable.length === 1 ? '' : 's'} selected — tap a hand card`;
              } else if (isJackSelected) {
                message = state.table.length > 0
                  ? `Jack captures all ${state.table.length} table cards`
                  : 'Jack goes straight to your pile';
                primaryLabel = 'Play Jack';
                primaryAction = confirmPlay;
              } else if (selectedTable.length === 0) {
                message = '';
                primaryLabel = 'Play to table';
                primaryAction = confirmPlay;
              } else if (captureIsValid) {
                message = `Capture ${selectedTable.length} card${selectedTable.length === 1 ? '' : 's'}${selectedTable.length === state.table.length ? ' — Bastra!' : ''}`;
                messageTone = 'ok';
                primaryLabel = 'Capture';
                primaryAction = confirmPlay;
              } else {
                message = "Selection doesn't add up";
                messageTone = 'error';
                primaryLabel = 'Clear';
                primaryAction = () => setSelectedTable([]);
              }
              return (
                <div className="capture-controls">
                  <div className={`capture-message tone-${messageTone}`}>{message || '\u00A0'}</div>
                  <div className="capture-buttons">
                    <button className="secondary" onClick={cancelSelection}>Cancel</button>
                    <button
                      onClick={primaryAction || (() => {})}
                      disabled={!primaryAction}
                      className={primaryAction ? '' : 'secondary'}
                      style={primaryAction ? {} : { visibility: 'hidden' }}
                    >
                      {primaryLabel || ' '}
                    </button>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      </div>

      <div className="hand-wrap">
        <div className="my-section-label">Your hand ({me?.hand.length ?? 0})</div>
        <div className="hand">
          {(me?.hand || []).length === 0 && (
            <span style={{ color: 'var(--muted)' }}>Empty — waiting for the next deal</span>
          )}
          {(me?.hand || []).map((c, i) => (
            <PlayingCard
              key={i}
              card={c}
              onClick={() => toggleHandSelect(i)}
              selected={selectedHandIdx === i}
              className={isMyTurn ? 'playable' : 'disabled'}
            />
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Captured: {me?.captures.length ?? 0}
          {me?.bastraCount > 0 ? ` · ${me.bastraCount} Bastra${me.bastraCount > 1 ? 's' : ''}` : ''}
          {me?.cumulativeScore > 0 ? ` · ${me.cumulativeScore} pts` : ''}
        </div>
      </div>

      {!hideChat && showChat && (
        <Chat messages={chatMessages} onSend={onSendChat} />
      )}

      {error && <div className="error">{error}</div>}

      {state.roundEnded && !state.winner && (
        <div className="winner-overlay">
          <h2>Round {state.round} complete</h2>
          <div style={{ fontSize: 14, color: 'var(--muted)' }}>
            First to {state.rules.targetScore ?? 101} wins
          </div>
          <table style={{ borderCollapse: 'collapse', fontSize: 14, marginTop: 4 }}>
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th style={{ textAlign: 'left', padding: '4px 10px' }}>Player</th>
                <th style={{ textAlign: 'right', padding: '4px 10px' }}>This round</th>
                <th style={{ textAlign: 'right', padding: '4px 10px' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {state.playerOrder.map((id) => {
                const p = state.players[id];
                const rs = state.roundScores?.[id] ?? 0;
                return (
                  <tr key={id}>
                    <td style={{ padding: '4px 10px', fontWeight: 600 }}>{p.name}</td>
                    <td style={{ padding: '4px 10px', textAlign: 'right' }}>{rs}</td>
                    <td style={{ padding: '4px 10px', textAlign: 'right', fontWeight: 600 }}>
                      {p.cumulativeScore}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button onClick={() => onAction({ type: 'nextRound' })}>Next round</button>
        </div>
      )}

      {state.winner && (
        <div className="winner-overlay">
          <h2>{state.winner === myId ? '🎉 You won the match!' : `${state.players[state.winner].name} wins the match`}</h2>
          <div style={{ fontSize: 16 }}>Final scores after {state.round} round{state.round === 1 ? '' : 's'}:</div>
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
            {state.playerOrder
              .slice()
              .sort((a, b) => state.players[b].cumulativeScore - state.players[a].cumulativeScore)
              .map((id) => {
                const p = state.players[id];
                return (
                  <li key={id}>
                    <strong>{p.name}</strong>: {p.cumulativeScore} pts
                  </li>
                );
              })}
          </ul>
          <button onClick={onLeave}>Back to lobby</button>
        </div>
      )}
    </div>
  );
}
