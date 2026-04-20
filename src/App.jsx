import { useEffect, useRef, useState } from 'react';
import { createHost, createClient, generateRoomCode } from './net.js';
import { Stats } from './Stats.jsx';
import { skipboGame } from './games/skipbo/index.js';

// Currently only Skip-Bo. When more games are added this will switch
// on a URL param or picker state.
const currentGame = skipboGame;
const { Game, Lobby, createGame, applyAction, cpuPlan, requiredDecks, maxPlayers: MAX_PLAYERS } = currentGame;
import { getProfile, recordGame, setProfile, selectProfile, clearProfile } from './stats.js';
import {
  supabaseEnabled,
  createRoom,
  updateRoom,
  deleteRoom,
  subscribeOpenRooms,
  HEARTBEAT_MS,
} from './rooms.js';
import { listProfiles, createProfile, touchProfile } from './profiles.js';

const NAME_KEY = 'skipbo.name';
const HUMAN_ID = 'human';
const DEFAULT_PRACTICE_RULES = { stockSize: 30, handSize: 5, maxDiscardDepth: null };

export default function App() {
  const [phase, setPhase] = useState('home'); // home | connecting | lobby | game
  const [mode, setMode] = useState(null); // 'host' | 'client' | 'practice'
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) || '');
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState(null);
  const [cpuCount, setCpuCount] = useState(2);
  const [practiceRules, setPracticeRules] = useState(DEFAULT_PRACTICE_RULES);

  const [net, setNet] = useState(null); // host or client handle
  const [lobbyState, setLobbyState] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [myId, setMyId] = useState(null);
  const [peerStatus, setPeerStatus] = useState(null);
  const [openRooms, setOpenRooms] = useState([]);
  const [profileList, setProfileList] = useState([]);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [currentProfile, setCurrentProfile] = useState(() => {
    try { return JSON.parse(localStorage.getItem('skipbo.profile')) || null; } catch { return null; }
  });
  const [newProfileName, setNewProfileName] = useState('');
  const practiceStateRef = useRef(null);
  const cpuTimerRef = useRef(null);
  const recordedGameRef = useRef(false);

  // Fetch the profile directory so the home screen can show the
  // "who are you?" picker. Listed by most-recently-seen first.
  useEffect(() => {
    if (!supabaseEnabled) { setProfileLoaded(true); return; }
    let cancelled = false;
    listProfiles().then((list) => {
      if (cancelled) return;
      setProfileList(list);
      setProfileLoaded(true);
      // If the cached profile id no longer exists in the directory
      // (e.g., deleted elsewhere, or a legacy local-only id), drop it
      // so the picker re-appears.
      if (currentProfile && !list.some((p) => p.id === currentProfile.id)) {
        setCurrentProfile(null);
        clearProfile();
      }
    });
    return () => { cancelled = true; };
  }, []);

  const pickProfile = (profile) => {
    const saved = selectProfile(profile);
    setCurrentProfile(saved);
    setName(saved.name);
    touchProfile(saved.id);
  };

  const addProfile = async () => {
    const clean = newProfileName.trim().slice(0, 20);
    if (!clean) { setError('Please enter a name.'); return; }
    setError(null);
    const res = await createProfile(clean);
    if (!res.ok) { setError(res.error); return; }
    setProfileList((list) => [res.profile, ...list.filter((p) => p.id !== res.profile.id)]);
    pickProfile(res.profile);
    setNewProfileName('');
  };

  const switchProfile = () => {
    clearProfile();
    setCurrentProfile(null);
    setName('');
  };

  useEffect(() => {
    return () => { net?.destroy(); };
  }, [net]);

  // Public room list: subscribe while idle on the home screen so players
  // can click a live room instead of typing a code.
  useEffect(() => {
    if (phase !== 'home' || !supabaseEnabled) return;
    const unsubscribe = subscribeOpenRooms(setOpenRooms, currentGame.id);
    return () => { unsubscribe(); setOpenRooms([]); };
  }, [phase]);

  // Host-side room advertisement: keep player_count/started fresh on
  // every lobby change, and heartbeat so stale rooms drop off the list
  // if the host closes the tab without cleanup.
  useEffect(() => {
    if (mode !== 'host' || !net || !lobbyState) return;
    updateRoom(net.roomCode, {
      player_count: lobbyState.players.length,
      started: lobbyState.started,
    });
  }, [mode, net, lobbyState]);

  useEffect(() => {
    if (mode !== 'host' || !net) return;
    const timer = setInterval(() => { updateRoom(net.roomCode, {}); }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [mode, net]);

  useEffect(() => {
    if (name) {
      localStorage.setItem(NAME_KEY, name);
      setProfile({ name });
    }
  }, [name]);

  // Record the game outcome exactly once when the game ends.
  useEffect(() => {
    if (!gameState?.winner || recordedGameRef.current || !myId) return;
    recordedGameRef.current = true;
    try {
      const profile = getProfile();
      recordGame(gameState, profile.id, myId, currentGame.id);
    } catch (err) {
      console.error('failed to record game', err);
    }
  }, [gameState?.winner, myId]);

  const goHome = () => {
    if (mode === 'host' && net?.roomCode) deleteRoom(net.roomCode);
    net?.destroy();
    if (cpuTimerRef.current) { clearTimeout(cpuTimerRef.current); cpuTimerRef.current = null; }
    practiceStateRef.current = null;
    recordedGameRef.current = false;
    setNet(null);
    setLobbyState(null);
    setGameState(null);
    setChatMessages([]);
    setMyId(null);
    setPeerStatus(null);
    setMode(null);
    setError(null);
    setPhase('home');
  };

  const onLobby = (lobby) => {
    setLobbyState(lobby);
    if (lobby.started) setPhase('game');
    else setPhase('lobby');
  };
  const onState = (s) => { setGameState(s); setPhase('game'); };
  const onChat = (msg) => setChatMessages((prev) => [...prev, msg]);
  const onErr = (msg) => setError(typeof msg === 'string' ? msg : (msg?.message || String(msg)));

  async function host() {
    setError(null);
    if (!name.trim()) { setError('Enter a name first.'); return; }
    setPhase('connecting');
    const code = generateRoomCode();
    try {
      const h = await createHost({
        game: currentGame,
        roomCode: code,
        hostName: name.trim(),
        hostProfileId: getProfile().id,
        onLobby, onState, onChat, onError: onErr,
        onStatus: setPeerStatus,
      });
      setNet(h);
      setMode('host');
      setMyId(h.hostId);
      setLobbyState(h.getLobby());
      setPhase('lobby');
      createRoom({ code, hostName: name.trim(), maxPlayers: MAX_PLAYERS, gameType: currentGame.id });
    } catch (err) {
      setError(err.message || String(err));
      setPhase('home');
    }
  }

  async function join(codeArg) {
    setError(null);
    const code = (codeArg || joinCode).toUpperCase();
    if (!name.trim()) { setError('Enter a name first.'); return; }
    if (!/^[A-Z0-9]{4}$/.test(code)) { setError('Enter a 4-character room code.'); return; }
    setPhase('connecting');
    try {
      const c = await createClient({
        roomCode: code,
        name: name.trim(),
        profileId: getProfile().id,
        onLobby, onState, onChat,
        onError: onErr,
        onStatus: setPeerStatus,
        onWelcome: (id) => setMyId(id),
      });
      setNet(c);
      setMode('client');
    } catch (err) {
      setError(err.message || String(err));
      setPhase('home');
    }
  }

  function openPracticeSetup() {
    setError(null);
    setPhase('practice-setup');
  }

  function startPractice() {
    setError(null);
    const humanName = name.trim() || 'You';
    const ids = [HUMAN_ID];
    const names = { [HUMAN_ID]: humanName };
    for (let i = 0; i < cpuCount; i++) {
      const id = `cpu${i + 1}`;
      ids.push(id);
      names[id] = `CPU ${i + 1}`;
    }
    try {
      const g = createGame(ids, names, practiceRules);
      // Link the human seat to the current profile so recorded games
      // know which profile to credit. CPUs stay null.
      if (g.players[HUMAN_ID]) g.players[HUMAN_ID].profileId = getProfile().id;
      practiceStateRef.current = g;
      setGameState(g);
      setMyId(HUMAN_ID);
      setMode('practice');
      setPhase('game');
      scheduleCpuTurn(g);
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  function scheduleCpuTurn(state) {
    if (cpuTimerRef.current) { clearTimeout(cpuTimerRef.current); cpuTimerRef.current = null; }
    if (!state || state.winner) return;
    if (state.turn === HUMAN_ID) return;
    const plan = cpuPlan(state, state.turn);
    playCpuActions(state, plan, 0);
  }

  function playCpuActions(state, actions, i) {
    if (i >= actions.length) {
      // Pause between CPU turns so the final move reads clearly.
      cpuTimerRef.current = setTimeout(() => scheduleCpuTurn(state), 900);
      return;
    }
    const act = actions[i];
    // Discards (turn-ender) get an extra beat to register visually.
    const delay = act.type === 'discard' ? 1800 : 1500;
    cpuTimerRef.current = setTimeout(() => {
      const res = applyAction(state, state.turn, act);
      if (!res.ok) {
        setError(`CPU error: ${res.error}`);
        scheduleCpuTurn(state);
        return;
      }
      practiceStateRef.current = res.state;
      setGameState(res.state);
      playCpuActions(res.state, actions, i + 1);
    }, delay);
  }

  const onStart = () => {
    const res = net?.startGame?.();
    if (res && !res.ok) setError(res.error);
  };
  const onUpdateRules = (rules) => net?.updateRules?.(rules);
  const onRename = (newName) => {
    setName(newName);
    if (mode === 'host') net?.setName?.(newName);
    else net?.sendRename?.(newName);
  };
  const onSendChat = (text) => net?.sendChat?.(text);
  const onAction = (action) => {
    if (mode === 'practice') {
      const s = practiceStateRef.current;
      if (!s) return;
      const res = applyAction(s, HUMAN_ID, action);
      if (!res.ok) { setError(res.error); return; }
      setError(null);
      practiceStateRef.current = res.state;
      setGameState(res.state);
      if (res.state.turn !== HUMAN_ID && !res.state.winner) scheduleCpuTurn(res.state);
      return;
    }
    if (mode === 'host') {
      const res = net.submitAction(action);
      if (!res.ok) setError(res.error);
    } else {
      net.sendAction(action);
    }
  };

  if (phase === 'stats') {
    return (
      <div className="app">
        <Stats onBack={() => setPhase('home')} gameType={currentGame.id} gameName={currentGame.name} />
      </div>
    );
  }

  if (phase === 'home' || phase === 'connecting') {
    const needsProfile = supabaseEnabled && profileLoaded && !currentProfile;
    return (
      <div className="app">
        <div className="lobby">
          <h1>Mav Family Skip-Bo</h1>

          {needsProfile ? (
            <>
              <div className="card-panel">
                <div style={{ fontSize: 16, fontWeight: 600, alignSelf: 'flex-start' }}>Who are you?</div>
                {profileList.length > 0 ? (
                  <>
                    <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Tap your name:</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {profileList.map((p) => (
                        <button key={p.id} className="secondary" onClick={() => pickProfile(p)}>
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>No profiles yet — be the first.</div>
                )}
              </div>
              <div className="card-panel">
                <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Someone new?</div>
                <input
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  maxLength={20}
                  placeholder="Enter your name"
                  onKeyDown={(e) => { if (e.key === 'Enter') addProfile(); }}
                />
                <button onClick={addProfile}>Create profile</button>
              </div>
              {error && <div className="error">{error}</div>}
            </>
          ) : (
            <div className="card-panel" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Playing as</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{currentProfile?.name || name || 'Guest'}</div>
              </div>
              {currentProfile && (
                <button className="secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={switchProfile}>
                  Switch
                </button>
              )}
              {!supabaseEnabled && (
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={20}
                  placeholder="Enter a name"
                  style={{ maxWidth: 180 }}
                />
              )}
            </div>
          )}

          {!needsProfile && (<>

          {supabaseEnabled && openRooms.length > 0 && (
            <div className="card-panel">
              <div style={{ fontSize: 13, color: 'var(--muted)', alignSelf: 'flex-start' }}>Open rooms</div>
              {openRooms.map((r) => {
                const full = r.player_count >= r.max_players;
                return (
                  <button
                    key={r.code}
                    className="secondary"
                    onClick={() => join(r.code)}
                    disabled={phase === 'connecting' || full}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <strong>{r.host_name}</strong> · {r.code}
                    </span>
                    <span style={{ color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>
                      {full ? 'full' : `${r.player_count}/${r.max_players}`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="card-panel">
            <button onClick={host} disabled={phase === 'connecting'}>
              {phase === 'connecting' && mode === null ? 'Creating room…' : 'Create a room'}
            </button>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>or join an existing one:</div>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
              placeholder="ROOM"
              maxLength={4}
              style={{ textAlign: 'center', letterSpacing: 6, fontSize: 22, fontFamily: 'ui-monospace, monospace' }}
            />
            <button className="secondary" onClick={() => join()} disabled={phase === 'connecting'}>
              {phase === 'connecting' ? 'Joining…' : 'Join room'}
            </button>
          </div>

          <div className="card-panel">
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>No friends around? Play offline:</div>
            <button className="secondary" onClick={openPracticeSetup} disabled={phase === 'connecting'}>
              Play vs CPU
            </button>
          </div>
          </>)}

          {error && <div className="error">{error}</div>}
          {peerStatus && <PeerStatusLine status={peerStatus} />}

          <button className="secondary" style={{ fontSize: 13 }} onClick={() => setPhase('stats')}>
            View stats
          </button>

          <div style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 360 }}>
            Peer-to-peer via WebRTC. Host stays in this tab; if they close it the game ends.
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'practice-setup') {
    const playerCount = 1 + cpuCount;
    const effStock = practiceRules.stockSize;
    const decks = requiredDecks(playerCount, effStock, practiceRules.handSize);
    const humanName = (name.trim() || 'You');
    return (
      <div className="app">
        <div className="lobby">
          <h1 style={{ fontSize: 32 }}>Practice vs CPU</h1>

          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Players</div>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>
              {humanName} + {cpuCount} CPU{cpuCount === 1 ? '' : 's'} ({playerCount} total)
            </div>
            <PracticeRuleRow
              label="CPU opponents"
              value={cpuCount}
              options={[1, 2, 3, 4, 5, 6, 7].map((n) => [n, n])}
              onChange={(v) => setCpuCount(v)}
            />
          </div>

          <div className="card-panel">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Rules</div>
            <PracticeRuleRow
              label="Stockpile size"
              value={practiceRules.stockSize}
              options={[[5, 5], [10, 10], [15, 15], [20, 20], [25, 25], [30, 30], [35, 35], [40, 40], [45, 45], [50, 50]]}
              onChange={(v) => setPracticeRules((r) => ({ ...r, stockSize: v }))}
            />
            <PracticeRuleRow
              label="Hand size"
              value={practiceRules.handSize}
              options={[[5, 5], [10, 10]]}
              onChange={(v) => setPracticeRules((r) => ({ ...r, handSize: v }))}
            />
            <PracticeRuleRow
              label="Max discard depth"
              value={practiceRules.maxDiscardDepth ?? 'unlimited'}
              options={[[4, 4], [6, 6], [8, 8], ['unlimited', null]]}
              onChange={(v) => setPracticeRules((r) => ({ ...r, maxDiscardDepth: v }))}
            />
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
              {decks === 1 ? '1 deck' : `${decks} decks`}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 400 }}>
            <button className="secondary" onClick={goHome} style={{ flex: 1 }}>Back</button>
            <button onClick={startPractice} style={{ flex: 2 }}>Start game</button>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  if (phase === 'lobby' && lobbyState) {
    return (
      <div className="app">
        <Lobby
          lobby={lobbyState}
          isHost={mode === 'host'}
          myId={myId}
          onStart={onStart}
          onUpdateRules={onUpdateRules}
          onRename={onRename}
          chatMessages={chatMessages}
          onSendChat={onSendChat}
          onLeave={goHome}
          error={error}
          peerStatus={peerStatus}
        />
      </div>
    );
  }

  if (phase === 'game' && gameState) {
    const displayState = { ...gameState, roomCode: lobbyState?.roomCode || (mode === 'practice' ? 'SOLO' : '') };
    return (
      <div className="app">
        <Game
          state={displayState}
          myId={myId}
          onAction={onAction}
          onRequestUndo={mode === 'practice' ? null : () => net?.requestUndo?.()}
          onVoteUndo={mode === 'practice' ? null : (yes) => net?.castUndoVote?.(yes)}
          chatMessages={chatMessages}
          onSendChat={onSendChat}
          onLeave={goHome}
          error={error}
          hideChat={mode === 'practice'}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="lobby"><div>Loading…</div></div>
    </div>
  );
}

export function PeerStatusLine({ status, compact }) {
  if (!status) return null;
  let color = 'var(--muted)';
  let text = '';
  if (status.kind === 'connecting') {
    color = 'var(--gold)';
    text = status.phase === 'host' ? 'Reaching host…' : 'Connecting to signaling…';
  } else if (status.kind === 'open') {
    color = 'var(--accent-2)';
    text = compact ? 'Connected' : `Connected (peer ${status.peerId?.slice(-6) || ''})`;
  } else if (status.kind === 'disconnected') {
    color = 'var(--gold)';
    text = 'Disconnected from signaling server';
  } else if (status.kind === 'closed') {
    color = 'var(--muted)';
    text = 'Closed';
  } else if (status.kind === 'error') {
    color = 'var(--danger)';
    text = status.message || `Error: ${status.type}`;
  }
  return (
    <div style={{
      fontSize: 11,
      color,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      maxWidth: 400,
      textAlign: 'center',
    }}>
      <span style={{
        display: 'inline-block',
        width: 8, height: 8, borderRadius: '50%',
        background: color,
        boxShadow: `0 0 6px ${color}`,
      }} />
      <span>{text}</span>
    </div>
  );
}

function PracticeRuleRow({ label, value, detail, options, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #2a5a48' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14 }}>{label}</div>
        {detail && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{detail}</div>}
      </div>
      <select
        value={String(value)}
        onChange={(e) => {
          const opt = options.find(([lbl]) => String(lbl) === e.target.value);
          if (opt) onChange(opt[1]);
        }}
        style={{
          background: 'var(--panel-2)',
          color: 'var(--text)',
          border: '1px solid #2a5a48',
          borderRadius: 6,
          padding: '6px 8px',
          font: 'inherit',
        }}
      >
        {options.map(([lbl]) => (
          <option key={String(lbl)} value={String(lbl)}>{lbl}</option>
        ))}
      </select>
    </div>
  );
}
