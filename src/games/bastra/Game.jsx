import { useEffect, useMemo, useRef, useState } from 'react';
import { PlayingCard } from './Card.jsx';
import { Chat } from '../../Chat.jsx';
import { isValidCapture, RANK_JACK } from './engine.js';
import { useHueFor, useTurnAnnounceKey, TurnBanner } from '../turnBanner.jsx';

export function Game({ state, myId, onAction, chatMessages, onSendChat, onLeave, error, hideChat }) {
  const [showChat, setShowChat] = useState(false);

  const me = state.players[myId];
  const isMyTurn = state.turn === myId && !state.winner;
  const opponents = state.playerOrder
    .filter((id) => id !== myId)
    .map((id) => state.players[id]);

  const hueFor = useHueFor(state);
  const turnAnnounceKey = useTurnAnnounceKey(state.turn);

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

  // Good-card celebration: the 10♦ (3 pts, "Good 10") and 2♣ (2 pts,
  // "Good 2") score on their own. When either is captured — either as
  // the played card or among the table cards it sweeps up — flash a
  // small banner. Smaller + shorter-lived than the Bastra banner since
  // the stakes are lower, but still worth a celebratory beat.
  const [goodCardEvent, setGoodCardEvent] = useState(null);
  const lastGoodVersionRef = useRef(state.version);
  useEffect(() => {
    if (state.version === lastGoodVersionRef.current) return;
    lastGoodVersionRef.current = state.version;
    const lm = state.lastMove;
    if (!lm) return;
    const captured = lm.capturedCards || [];
    const isGood = (c) => c && ((c.rank === 10 && c.suit === 'D') || (c.rank === 2 && c.suit === 'C'));
    const ptsFor = (c) => (c.rank === 10 ? 3 : 2);
    const goods = [];
    if (isGood(lm.card) && captured.length > 0) goods.push(lm.card);
    for (const c of captured) if (isGood(c)) goods.push(c);
    if (goods.length === 0) return;
    const total = goods.reduce((sum, c) => sum + ptsFor(c), 0);
    setGoodCardEvent({
      playerId: lm.playerId,
      cards: goods,
      totalPoints: total,
      key: `good-${state.version}`,
    });
    const t = setTimeout(() => setGoodCardEvent(null), 1900);
    return () => clearTimeout(t);
  }, [state.version, state.lastMove]);

  // Delay the round-end / match-end prompt so the final move animation
  // (Bastra / good-card banner, capture flight) can play out first.
  // After the delay the player sees a "Show scoring →" tap prompt —
  // clicking it opens the full round reveal. This lets the player
  // absorb the last move instead of being yanked straight into the
  // scorecard. Resets whenever a new round starts.
  const [overlayReady, setOverlayReady] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  useEffect(() => {
    const ended = state.roundEnded || !!state.winner;
    if (!ended) { setOverlayReady(false); setRevealOpen(false); return; }
    setRevealOpen(false);
    const t = setTimeout(() => setOverlayReady(true), 2800);
    return () => clearTimeout(t);
  }, [state.roundEnded, state.winner, state.round]);

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
      <TurnBanner
        announceKey={turnAnnounceKey}
        hue={hueFor(state.turn)}
        name={state.players[state.turn]?.name}
        isMe={state.turn === myId}
        hidden={!!state.winner || !!state.roundEnded}
      />
      {bastraEvent && (
        <div
          key={bastraEvent.key}
          className="bastra-celebrate"
          style={{ '--player-hue': hueFor(bastraEvent.playerId) }}
        >
          <div className="bastra-celebrate-label">BASTRA</div>
          <div className="bastra-celebrate-name">OPA!</div>
          <div className="bastra-celebrate-bonus">+{state.rules.bastraPoints ?? 10}</div>
        </div>
      )}

      {goodCardEvent && (
        <div
          key={goodCardEvent.key}
          className="good-card-celebrate"
          style={{ '--player-hue': hueFor(goodCardEvent.playerId) }}
        >
          <div className="good-card-label">
            {goodCardEvent.cards.map((c) => (
              c.rank === 10 ? 'Good 10' : 'Good 2'
            )).join(' + ')}
          </div>
          <div className="good-card-name">
            {goodCardEvent.playerId === myId ? 'Nice pickup!' : `${state.players[goodCardEvent.playerId]?.name || 'Someone'}`}
          </div>
          <div className="good-card-bonus">+{goodCardEvent.totalPoints}</div>
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
              <span className="opp-name">{op.name}</span>
              <span className="opp-hand-count">{op.hand.length}</span>
            </div>
            <CaptureStack
              count={op.captures.length}
              bastraCards={op.bastraPlayedCards || []}
            />
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
            className={`jack-sweep-overlay ${animEvent.playerId === myId ? 'own-move' : ''}`}
            style={{ '--player-hue': hueFor(animEvent.playerId) }}
          >
            <PlayingCard card={animEvent.card} className="jack-sweep-card" />
          </div>
        )}
        {/* Played-card overlay: for non-Jack captures, the capturer's
            card appears separately above or below the table (at the
            capturer's side) rather than being inserted into the grid. */}
        {animEvent
          && animEvent.capturedCards.length > 0
          && animEvent.card?.rank !== 11
          && (
            <div
              key={`${animEvent.key}-overlay`}
              className={`played-card-overlay ${animEvent.playerId === myId ? 'from-player' : 'from-opponent'}`}
            >
              <PlayingCard card={animEvent.card} className="played-card-anim" />
            </div>
          )}
        {(() => {
          // Build the display list. In the steady state it's just
          // state.table. During an opponent capture animation we
          // reconstruct the pre-move table (captured cards at their
          // original positions) and append the played card so the
          // user can watch the capture play out in place.
          // Skip reconstruction once the round has ended — the engine
          // sweeps any leftover table cards to the last capturer at
          // round end, so state.table is shorter than the pre-capture
          // shape the animation expects and we'd index past its end.
          const items = [];
          if (animEvent && animEvent.capturedCards.length > 0 && !state.roundEnded) {
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
            // Note: the played card isn't inserted into the grid — it's
            // shown separately via the played-card-overlay above/below
            // the table so you can see the capturer laying it down.
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
            // Empty table: just one dashed slot where the next card
            // would land. Four placeholders overstated the case —
            // any single play only ever fills one slot.
            return (
              <div className="bastra-table">
                <PlayingCard
                  card={null}
                  className="table-slot"
                  style={{ gridRow: 1, gridColumn: 1 }}
                />
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
          const ownMove = animEvent && animEvent.playerId === myId;
          return (
            <div className={`bastra-table ${ownMove ? 'own-move' : ''}`}>
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
        <div className="my-capture-row">
          <CaptureStack
            count={me?.captures.length ?? 0}
            bastraCards={me?.bastraPlayedCards || []}
            size="normal"
          />
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {me?.cumulativeScore > 0 ? `${me.cumulativeScore} pts` : null}
          </div>
        </div>
      </div>

      {!hideChat && showChat && (
        <Chat messages={chatMessages} onSend={onSendChat} />
      )}

      {error && <div className="error">{error}</div>}

      {(state.roundEnded || state.winner) && overlayReady && !revealOpen && (
        <div className="bastra-continue-wrap">
          <button onClick={() => setRevealOpen(true)} style={{ padding: '10px 22px', fontSize: 15 }}>
            {state.winner ? 'See final standings →' : 'Continue →'}
          </button>
        </div>
      )}

      {(state.roundEnded || state.winner) && overlayReady && revealOpen && (
        <RoundReveal
          state={state}
          myId={myId}
          hueFor={hueFor}
          onNext={() => onAction({ type: 'nextRound' })}
          onLeave={onLeave}
        />
      )}
    </div>
  );
}

// Per-round and end-of-match reveal. Dramatizes the scoring: each
// player's capture pile flips face-up into a fan, card count ticks
// up, scoring bonuses pop in as chips, round total accumulates, then
// the cumulative score updates. A Skip button jumps straight to the
// final numbers.
function RoundReveal({ state, myId, hueFor, onNext, onLeave }) {
  const [skipped, setSkipped] = useState(false);
  const isMatchEnd = !!state.winner;
  const roundScores = state.roundScores || {};
  const players = state.playerOrder.map((id) => state.players[id]).filter(Boolean);
  const me = state.players[myId];

  // Most-cards bonus goes only to a single leader (engine skips it on
  // a tie). Mirror that logic here to label the chip correctly.
  const counts = players.map((p) => p.captures.length);
  const maxCount = counts.length ? Math.max(...counts) : 0;
  const tied = counts.filter((c) => c === maxCount).length > 1;
  const mostCardsId = (!tied && maxCount > 0)
    ? players.find((p) => p.captures.length === maxCount)?.id
    : null;

  // Two-phase reveal:
  //   closeup — the human player's own captures run past one by one
  //             with a live running tally, so they see the breakdown
  //             of their own round before the group summary;
  //   summary — the per-player grid with fans and chips.
  // Skipping jumps straight to the summary at its final state.
  const [phase, setPhase] = useState(me ? 'closeup' : 'summary');

  const ROW_STAGGER = 1400;
  const summaryDuration = players.length * ROW_STAGGER + 2000;

  const [actionsVisible, setActionsVisible] = useState(false);
  useEffect(() => {
    if (phase !== 'summary') { setActionsVisible(false); return; }
    if (skipped) { setActionsVisible(true); return; }
    const t = setTimeout(() => setActionsVisible(true), summaryDuration);
    return () => clearTimeout(t);
  }, [phase, skipped, summaryDuration]);

  if (phase === 'closeup' && me) {
    return (
      <div className="winner-overlay round-reveal closeup-phase">
        <SelfCloseup
          player={me}
          rules={state.rules}
          isMostCards={mostCardsId === myId}
          hue={hueFor(myId)}
          onDone={() => setPhase('summary')}
          onSkip={() => setPhase('summary')}
        />
      </div>
    );
  }

  return (
    <div className="winner-overlay round-reveal">
      <h2 className="reveal-title">
        {isMatchEnd
          ? (state.winner === myId
              ? '🎉 You won the match!'
              : `${state.players[state.winner]?.name || 'Someone'} wins the match`)
          : `Round ${state.round} complete`}
      </h2>
      {!isMatchEnd && (
        <div className="reveal-subtitle">
          {state.rules.mode === 'rounds'
            ? `Round ${state.round} of ${state.rules.targetRounds ?? 3}`
            : `First to ${state.rules.targetScore ?? 101}`}
        </div>
      )}

      <div className="reveal-rows">
        {players.map((p, i) => (
          <RevealRow
            key={p.id}
            player={p}
            prevCumulative={p.cumulativeScore - (roundScores[p.id] ?? 0)}
            roundScore={roundScores[p.id] ?? 0}
            isMostCards={mostCardsId === p.id}
            rules={state.rules}
            hue={hueFor(p.id)}
            delay={i * ROW_STAGGER}
            skipped={skipped}
            isMe={p.id === myId}
          />
        ))}
      </div>

      <div className="reveal-actions">
        {!skipped && !actionsVisible && (
          <button className="secondary" onClick={() => setSkipped(true)}>Skip</button>
        )}
        {actionsVisible && (
          isMatchEnd
            ? <button onClick={onLeave}>Back to lobby</button>
            : <button onClick={onNext}>Next round</button>
        )}
      </div>
    </div>
  );
}

// Personal close-up: the human's captures run past one at a time with
// a live tally, so they see exactly which cards of theirs scored what
// before the group summary appears. Non-scoring cards breeze by fast;
// scoring cards pause with a callout chip.
function SelfCloseup({ player, rules, isMostCards, hue, onDone, onSkip }) {
  // Sort: scoring cards first (in a consistent order), then the rest,
  // so the interesting points arrive quickly and the long non-scoring
  // tail flies past at the end.
  const cards = useMemo(() => {
    const priority = (c) => {
      if (c.rank === 10 && c.suit === 'D') return 0;
      if (c.rank === 2 && c.suit === 'C') return 1;
      if (c.rank === 11) return 2;
      if (c.rank === 1) return 3;
      return 4;
    };
    return [...(player.captures || [])].sort((a, b) => priority(a) - priority(b));
  }, [player.captures]);

  const scoreOf = (c) => {
    if (c.rank === 10 && c.suit === 'D') return { label: 'Good 10', pts: 3, tone: 'hot' };
    if (c.rank === 2 && c.suit === 'C') return { label: 'Good 2', pts: 2, tone: 'hot' };
    if (c.rank === 11) return { label: 'Jack', pts: 1, tone: 'default' };
    if (c.rank === 1) return { label: 'Ace', pts: 1, tone: 'default' };
    return null;
  };

  const [idx, setIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [chip, setChip] = useState(null);
  const [phase, setPhase] = useState('cards'); // 'cards' | 'bonus' | 'done'

  // Advance through captures one at a time. Scoring cards pause, rest
  // fly past rapidly.
  useEffect(() => {
    if (phase !== 'cards') return;
    if (idx >= cards.length) {
      setChip(null);
      setPhase('bonus');
      return;
    }
    const card = cards[idx];
    const s = scoreOf(card);
    const wait = s ? 650 : 95;
    const t = setTimeout(() => {
      if (s) {
        setChip({ ...s, key: `c-${idx}` });
        setScore((cur) => cur + s.pts);
      } else {
        setChip(null);
      }
      setIdx((n) => n + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [idx, cards, phase]);

  // After all cards, pop in the per-round bonuses (Bastra, Most cards).
  useEffect(() => {
    if (phase !== 'bonus') return;
    const bonuses = [];
    const bastras = player.bastraCount || 0;
    if (bastras > 0) {
      bonuses.push({
        label: bastras === 1 ? 'Bastra' : `Bastras ×${bastras}`,
        pts: bastras * (rules.bastraPoints ?? 10),
        tone: 'gold',
      });
    }
    if (isMostCards) {
      bonuses.push({
        label: 'Most cards',
        pts: rules.mostCardsPoints ?? 3,
        tone: 'accent',
      });
    }
    if (bonuses.length === 0) {
      const t = setTimeout(() => setPhase('done'), 700);
      return () => clearTimeout(t);
    }
    const timers = [];
    bonuses.forEach((b, i) => {
      timers.push(setTimeout(() => {
        setChip({ ...b, key: `b-${i}` });
        setScore((cur) => cur + b.pts);
      }, 400 + i * 700));
    });
    timers.push(setTimeout(() => setPhase('done'), 400 + bonuses.length * 700 + 900));
    return () => timers.forEach(clearTimeout);
  }, [phase, player.bastraCount, isMostCards, rules]);

  // After done, hand off to the summary.
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(onDone, 300);
    return () => clearTimeout(t);
  }, [phase, onDone]);

  // Cap the cascade at a reasonable width so it wraps rather than
  // overflowing on narrow screens. Each card steps by a fraction of
  // card width — enough to see the corner of every card.
  const visible = cards.slice(0, idx);

  return (
    <div className="closeup" style={{ '--player-hue': hue }}>
      <div className="closeup-title">Your captures</div>
      <div className="closeup-cascade">
        {visible.map((c, i) => {
          const scored = scoreOf(c);
          return (
            <div
              key={i}
              className={`closeup-card ${scored ? 'scored' : ''} ${i === visible.length - 1 && phase === 'cards' ? 'latest' : ''}`}
              style={{ '--i': i }}
            >
              <PlayingCard card={c} />
            </div>
          );
        })}
      </div>
      <div className="closeup-chip-slot">
        {chip && (
          <div key={chip.key} className={`closeup-chip tone-${chip.tone}`}>
            <span>{chip.label}</span>
            <strong>+{chip.pts}</strong>
          </div>
        )}
      </div>
      <div className="closeup-total">
        <div className="closeup-total-label">Round</div>
        <div className="closeup-total-val">{score}</div>
      </div>
      <div className="closeup-skip">
        <button className="secondary" onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}

function computeScoringChips(player, rules, isMostCards) {
  const cards = player.captures || [];
  const chips = [];
  const bastraCount = player.bastraCount || 0;
  if (bastraCount > 0) {
    chips.push({
      label: bastraCount === 1 ? 'Bastra' : `Bastra ×${bastraCount}`,
      pts: bastraCount * (rules.bastraPoints ?? 10),
      tone: 'gold',
    });
  }
  if (cards.some((c) => c.rank === 10 && c.suit === 'D')) {
    chips.push({ label: 'Good 10', pts: 3, tone: 'hot' });
  }
  if (cards.some((c) => c.rank === 2 && c.suit === 'C')) {
    chips.push({ label: 'Good 2', pts: 2, tone: 'hot' });
  }
  const jacks = cards.filter((c) => c.rank === 11).length;
  if (jacks > 0) {
    chips.push({ label: jacks === 1 ? 'Jack' : `Jack ×${jacks}`, pts: jacks });
  }
  const aces = cards.filter((c) => c.rank === 1).length;
  if (aces > 0) {
    chips.push({ label: aces === 1 ? 'Ace' : `Ace ×${aces}`, pts: aces });
  }
  if (isMostCards) {
    chips.push({ label: 'Most cards', pts: rules.mostCardsPoints ?? 3, tone: 'accent' });
  }
  return chips;
}

function RevealRow({ player, prevCumulative, roundScore, isMostCards, rules, hue, delay, skipped, isMe }) {
  const chips = useMemo(
    () => computeScoringChips(player, rules, isMostCards),
    [player, rules, isMostCards],
  );

  const [visible, setVisible] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [chipIndex, setChipIndex] = useState(0);
  const [cumulativeRevealed, setCumulativeRevealed] = useState(false);
  const [countTarget, setCountTarget] = useState(0);

  useEffect(() => {
    if (skipped) {
      setVisible(true);
      setFlipped(true);
      setChipIndex(chips.length);
      setCumulativeRevealed(true);
      setCountTarget(player.captures.length);
      return;
    }
    const timers = [];
    timers.push(setTimeout(() => setVisible(true), delay));
    timers.push(setTimeout(() => setFlipped(true), delay + 250));
    timers.push(setTimeout(() => setCountTarget(player.captures.length), delay + 350));
    chips.forEach((_, i) => {
      timers.push(setTimeout(() => setChipIndex(i + 1), delay + 1050 + i * 240));
    });
    timers.push(setTimeout(
      () => setCumulativeRevealed(true),
      delay + 1050 + chips.length * 240 + 200,
    ));
    return () => timers.forEach(clearTimeout);
  }, [delay, chips.length, skipped, player.captures.length]);

  // Tick the card count from 0 to target over ~700ms once the count
  // animation is kicked off by setCountTarget.
  const [displayedCount, setDisplayedCount] = useState(0);
  useEffect(() => {
    if (countTarget === 0) { setDisplayedCount(0); return; }
    if (skipped) { setDisplayedCount(countTarget); return; }
    let raf;
    let start = null;
    const from = 0;
    const to = countTarget;
    const duration = 700;
    const step = (ts) => {
      if (!start) start = ts;
      const progress = Math.min(1, (ts - start) / duration);
      setDisplayedCount(Math.round(from + (to - from) * progress));
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [countTarget, skipped]);

  const shownRoundScore = chips.slice(0, chipIndex).reduce((s, c) => s + c.pts, 0);
  const newCumulative = prevCumulative + roundScore;

  return (
    <div
      className={`reveal-row ${visible ? 'visible' : ''} ${isMe ? 'me' : ''}`}
      style={{ '--player-hue': hue }}
    >
      <div className="reveal-row-name">
        <strong>{player.name}</strong>
        {isMe && <span className="reveal-you">you</span>}
      </div>
      <CaptureCascade
        captures={player.captures}
        bastraCards={player.bastraPlayedCards || []}
        flipped={flipped}
      />
      <div className="reveal-row-count">
        <div className="reveal-count-num">{displayedCount}</div>
        <div className="reveal-count-label">card{displayedCount === 1 ? '' : 's'}</div>
      </div>
      <div className="reveal-row-chips">
        {chips.slice(0, chipIndex).map((c, i) => (
          <span key={i} className={`reveal-chip tone-${c.tone || 'default'}`}>
            <span className="reveal-chip-label">{c.label}</span>
            <strong className="reveal-chip-pts">+{c.pts}</strong>
          </span>
        ))}
      </div>
      <div className="reveal-row-score">
        <div className="reveal-round">
          <span className="reveal-round-label">Round</span>
          <span className="reveal-round-val">{chipIndex > 0 ? `+${shownRoundScore}` : '—'}</span>
        </div>
        <div className={`reveal-total ${cumulativeRevealed ? 'bumped' : ''}`}>
          <span className="reveal-total-label">Total</span>
          <span className="reveal-total-val">
            {cumulativeRevealed ? newCumulative : prevCumulative}
          </span>
        </div>
      </div>
    </div>
  );
}

function CaptureCascade({ captures, bastraCards, flipped }) {
  // Straight horizontal cascade — cards overlap in a single line with
  // no rotation, like a hand of cards laid out. Prioritize scoring
  // cards so what's visible matches the chip breakdown.
  const MAX = 12;
  const bastraKey = new Set(bastraCards.map((c) => `${c.rank}-${c.suit}`));
  const priority = (c) => {
    if (bastraKey.has(`${c.rank}-${c.suit}`)) return 0;
    if (c.rank === 10 && c.suit === 'D') return 1;
    if (c.rank === 2 && c.suit === 'C') return 2;
    if (c.rank === 11) return 3;
    if (c.rank === 1) return 4;
    return 5;
  };
  const sorted = [...captures].sort((a, b) => priority(a) - priority(b));
  const shown = sorted.slice(0, MAX);

  if (captures.length === 0) {
    return <div className="reveal-cascade empty"><span className="reveal-cascade-empty">—</span></div>;
  }

  return (
    <div className={`reveal-cascade ${flipped ? 'flipped' : ''}`}>
      {shown.map((card, i) => (
        <div
          key={`${card.rank}-${card.suit}-${i}`}
          className="reveal-cascade-slot"
          style={{
            '--i': i,
            '--delay': `${i * 50}ms`,
            zIndex: i + 1,
          }}
        >
          <span className="reveal-cascade-face reveal-cascade-back pc face-down" />
          <div className="reveal-cascade-face reveal-cascade-front">
            <PlayingCard card={card} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Visual representation of a capture pile: a stack of face-down
// cards whose layer count grows roughly with the capture count, plus
// a perpendicular face-up card for each Bastra this round. When there
// are Bastras, the face-down layers split into a "below" set and an
// "above" set so the Bastra card(s) look sandwiched in the pile
// (flush-left with the stack, sticking out to the right) rather than
// sitting loose on top.
function CaptureStack({ count, bastraCards = [], size = 'mini' }) {
  if (!count) return (
    <div className={`capture-stack capture-stack-${size} empty`} aria-label="No captures yet">
      <div className="capture-stack-pile" />
      <span className="capture-stack-count">0</span>
    </div>
  );
  const hasBastra = bastraCards.length > 0;
  // One visible back per ~3 real cards, capped. When Bastras are
  // present we force at least 2 layers so the Bastra marker has room
  // to be sandwiched with at least one card above and one below.
  const totalLayers = Math.max(hasBastra ? 2 : 1, Math.min(8, Math.ceil(count / 3)));
  const topLayers = hasBastra ? Math.max(1, Math.floor(totalLayers / 2)) : 0;
  const bottomLayers = totalLayers - topLayers;
  return (
    <div className={`capture-stack capture-stack-${size}`} aria-label={`${count} captured${bastraCards.length ? `, ${bastraCards.length} Bastras` : ''}`}>
      <div className="capture-stack-pile">
        {Array.from({ length: bottomLayers }).map((_, i) => (
          <span
            key={`btm-${i}`}
            className="pc face-down capture-stack-layer"
            style={{ '--layer': i }}
          />
        ))}
        {bastraCards.map((card, i) => (
          <PlayingCard
            key={`b-${i}`}
            card={card}
            className="capture-stack-bastra"
            style={{ '--bastra-index': i }}
          />
        ))}
        {Array.from({ length: topLayers }).map((_, i) => (
          <span
            key={`top-${i}`}
            className="pc face-down capture-stack-layer capture-stack-layer-top"
            style={{ '--layer': bottomLayers + i }}
          />
        ))}
      </div>
      <span className="capture-stack-count">{count}</span>
    </div>
  );
}
