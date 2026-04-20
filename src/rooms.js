// Supabase-backed public room list. Purely for discovery — the P2P
// game itself still runs host-authoritative through PeerJS.
//
// Graceful fallback: if env vars aren't set, every export is a no-op
// and `supabaseEnabled` is false, so the home screen just hides the
// rooms list and the app keeps working with the code-entry flow.

import { supabase, supabaseEnabled } from './supabase.js';

export { supabaseEnabled };

const client = supabase;

// Rooms older than this are considered stale and filtered from the UI.
// Host pings every HEARTBEAT_MS to stay fresh.
export const STALE_MS = 120_000;
export const HEARTBEAT_MS = 30_000;

export async function createRoom({ code, hostName, maxPlayers }) {
  if (!client) return;
  const { error } = await client.from('rooms').upsert({
    code,
    host_name: hostName,
    player_count: 1,
    max_players: maxPlayers,
    started: false,
    updated_at: new Date().toISOString(),
  });
  if (error) console.warn('createRoom failed', error);
}

export async function updateRoom(code, patch) {
  if (!client) return;
  const { error } = await client
    .from('rooms')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('code', code);
  if (error) console.warn('updateRoom failed', error);
}

export async function deleteRoom(code) {
  if (!client) return;
  const { error } = await client.from('rooms').delete().eq('code', code);
  if (error) console.warn('deleteRoom failed', error);
}

// Live list of open, non-stale rooms. Calls `onRooms` with an array
// each time the filtered view changes. Returns a cleanup function.
export function subscribeOpenRooms(onRooms) {
  if (!client) {
    onRooms([]);
    return () => {};
  }

  let rooms = new Map();
  const emit = () => {
    const cutoff = Date.now() - STALE_MS;
    const list = [...rooms.values()]
      .filter((r) => !r.started && new Date(r.updated_at).getTime() >= cutoff)
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    onRooms(list);
  };

  // Re-filter periodically so stale rows drop off without needing a
  // server event.
  const sweepTimer = setInterval(emit, 15_000);

  // Initial fetch.
  (async () => {
    const { data, error } = await client.from('rooms').select('*');
    if (error) { console.warn('fetch rooms failed', error); return; }
    for (const r of data || []) rooms.set(r.code, r);
    emit();
  })();

  const channelName = `rooms-list-${Math.random().toString(36).slice(2, 10)}`;
  const channel = client
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, (payload) => {
      if (payload.eventType === 'DELETE') {
        rooms.delete(payload.old.code);
      } else {
        rooms.set(payload.new.code, payload.new);
      }
      emit();
    })
    .subscribe();

  return () => {
    clearInterval(sweepTimer);
    client.removeChannel(channel);
  };
}
