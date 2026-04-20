import { useState } from 'react';
import { getProfile, setProfile, getHistory, computeStats, formatDuration, clearHistory } from './stats.js';

export function Stats({ onBack }) {
  const [profile, setProfileState] = useState(getProfile());
  const [history, setHistory] = useState(getHistory());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  const stats = computeStats(history);

  const saveProfile = () => {
    const cleanName = String(draft.name || '').slice(0, 20).trim();
    const next = setProfile({ name: cleanName || 'Player', color: draft.color });
    setProfileState(next);
    setEditing(false);
  };

  const onClearHistory = () => {
    if (!confirm('Clear all local game history? This cannot be undone.')) return;
    clearHistory();
    setHistory([]);
  };

  const recent = [...history].reverse().slice(0, 20);

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 620, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 24 }}>Stats</h2>
        <button className="secondary" onClick={onBack}>Back</button>
      </div>

      {/* Profile */}
      <div className="card-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 48, height: 48, borderRadius: '50%',
            background: profile.color, color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 22,
          }}>
            {(profile.name || '?').slice(0, 1).toUpperCase()}
          </div>
          <div style={{ flex: 1 }}>
            {editing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={20}
                  placeholder="Your name"
                />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {['#38bdf8', '#22c55e', '#ec4899', '#f59e0b', '#a855f7', '#14b8a6', '#f43f5e', '#eab308'].map((c) => (
                    <div key={c}
                      onClick={() => setDraft({ ...draft, color: c })}
                      style={{
                        width: 24, height: 24, borderRadius: '50%',
                        background: c, cursor: 'pointer',
                        border: draft.color === c ? '2px solid white' : '2px solid transparent',
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontWeight: 600, fontSize: 18 }}>{profile.name || 'Unnamed'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Since {new Date(profile.createdAt).toLocaleDateString()}
                </div>
              </>
            )}
          </div>
          {editing ? (
            <>
              <button onClick={saveProfile}>Save</button>
              <button className="secondary" onClick={() => { setDraft(profile); setEditing(false); }}>Cancel</button>
            </>
          ) : (
            <button className="secondary" onClick={() => { setDraft(profile); setEditing(true); }}>Edit</button>
          )}
        </div>
      </div>

      {/* Lifetime stats */}
      <div className="card-panel">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Lifetime</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <Stat label="Games" value={stats.total} />
          <Stat label="Wins" value={stats.wins} />
          <Stat label="Win %" value={`${stats.winPct}%`} />
          <Stat label="Avg turns" value={stats.avgTurnsPerGame || '—'} />
          <Stat label="Avg length" value={formatDuration(stats.avgDurationMs)} />
          <Stat label="Losses" value={stats.losses} />
        </div>
      </div>

      {/* History */}
      <div className="card-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>Recent games</div>
          {history.length > 0 && (
            <button className="secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={onClearHistory}>
              Clear
            </button>
          )}
        </div>
        {recent.length === 0 ? (
          <div style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 13 }}>
            No games played yet. Finish a game and it'll show up here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {recent.map((r) => (
              <GameRow key={r.id} record={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
    </div>
  );
}

function GameRow({ record }) {
  const date = new Date(record.endedAt);
  const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const playerList = record.players.map((p) => p.name).join(', ');
  return (
    <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <span style={{ color: record.didIWin ? 'var(--accent-2)' : 'var(--muted)', fontWeight: 700 }}>
            {record.didIWin ? '🏆 Win' : 'Loss'}
          </span>
          <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
            · {record.winnerName || '?'} won in {record.turnCount ?? '?'} turns
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{dateStr}</div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {playerList} · {formatDuration(record.durationMs)} · {record.deckCount > 1 ? `${record.deckCount} decks · ` : ''}stock {record.rules.stockSize}
      </div>
    </div>
  );
}
