import { useEffect, useMemo, useRef, useState } from 'react';
import { PlayingCard } from './Card.jsx';
import { Chat } from '../../Chat.jsx';

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
  const [turnAnnounceKey, setTurnAnnounceKey] = useState(0);
  const lastTurnRef = useRef(state.turn);
  useEffect(() => {
    if (lastTurnRef.current !== state.turn) {
      lastTurnRef.current = state.turn;
      setTurnAnnounceKey((k) => k + 1);
    }
  }, [state.turn]);

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
  const activeHue = hueFor(state.turn);
  const activeName = state.turn === myId ? 'Your' : `${state.players[state.turn]?.name || 'Player'}'s`;

  const playCard = (i) => {
    if (!isMyTurn || state.winner) return;
    onAction({ type: 'play', handIndex: i });
  };

  return (
    <div className="board bastra">
      {!state.winner && turnAnnounceKey > 0 && (
        <div key={turnAnnounceKey} className="turn-announcement" style={{ '--player-hue': activeHue }}>
          {activeName} turn
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
        <div className="bastra-table">
          {state.table.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontStyle: 'italic', padding: 12 }}>Empty — capture next!</div>
          ) : (
            state.table.map((c, i) => <PlayingCard key={`t-${i}`} card={c} />)
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
              onClick={() => playCard(i)}
              className={isMyTurn ? 'playable' : 'disabled'}
            />
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          Captured: {me?.captures.length ?? 0}{me?.bastraCount > 0 ? ` · ${me.bastraCount} Bastra${me.bastraCount > 1 ? 's' : ''}` : ''}
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
