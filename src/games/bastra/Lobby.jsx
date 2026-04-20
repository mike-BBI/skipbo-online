import { useState } from 'react';
import { Chat } from '../../Chat.jsx';
import { MAX_PLAYERS, MIN_PLAYERS } from './engine.js';

// Bastra lobby is intentionally minimal — the MVP has no tunable
// rules, so this is just a shared waiting room until the host hits
// Start.
export function Lobby({ lobby, isHost, myId, onStart, onRename, chatMessages, onSendChat, onLeave, error, peerStatus }) {
  const [editingName, setEditingName] = useState(false);
  const me = lobby.players.find((p) => p.id === myId);
  const [nameDraft, setNameDraft] = useState(me?.name || '');
  const startDisabled = lobby.players.length < MIN_PLAYERS;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 600, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Room code</div>
          <div className="room-code" style={{ fontSize: 28 }}>{lobby.roomCode}</div>
          {peerStatus && <StatusIndicator status={peerStatus} />}
        </div>
        <button className="secondary" onClick={onLeave}>Leave</button>
      </div>

      <div style={{ background: 'var(--panel)', borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Players ({lobby.players.length}/{MAX_PLAYERS})
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {lobby.players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                {p.name}
                {p.id === lobby.hostId && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>(host)</span>}
                {p.id === myId && <span style={{ color: 'var(--muted)', marginLeft: 6 }}>(you)</span>}
              </span>
              {p.id === myId && !editingName && (
                <button className="secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setNameDraft(p.name); setEditingName(true); }}>
                  Rename
                </button>
              )}
            </div>
          ))}
        </div>
        {editingName && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={20} />
            <button onClick={() => { onRename(nameDraft); setEditingName(false); }}>Save</button>
            <button className="secondary" onClick={() => setEditingName(false)}>Cancel</button>
          </div>
        )}
      </div>

      <div style={{ background: 'var(--panel)', borderRadius: 10, padding: 12, fontSize: 13, color: 'var(--muted)' }}>
        First to capture the table after an opponent's card gets a Bastra (+10 pts). Jacks capture everything. Highest score at the end of the deck wins.
      </div>

      {isHost ? (
        <button disabled={startDisabled} onClick={onStart}>
          {startDisabled ? `Need at least ${MIN_PLAYERS} players` : 'Start game'}
        </button>
      ) : (
        <div style={{ textAlign: 'center', color: 'var(--muted)' }}>Waiting for host to start…</div>
      )}

      {error && <div className="error">{error}</div>}

      <Chat messages={chatMessages} onSend={onSendChat} />
    </div>
  );
}

function StatusIndicator({ status }) {
  let color = 'var(--muted)';
  let text = 'idle';
  if (!status) { /* idle */ }
  else if (status.kind === 'open') { color = 'var(--accent-2)'; text = 'connected'; }
  else if (status.kind === 'connecting') { color = 'var(--gold)'; text = 'connecting…'; }
  else if (status.kind === 'disconnected') { color = 'var(--gold)'; text = 'reconnecting…'; }
  else if (status.kind === 'error') { color = '#ef4444'; text = 'error'; }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      {text}
    </span>
  );
}
