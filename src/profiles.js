// Supabase-backed shared profile directory. Every player signs in by
// picking their name from a public list (or adding a new one) — no
// password, no email. Suitable for a trusted family group.
//
// Profiles live cross-device; game records reference profile.id so
// lifetime stats follow a player between phone, laptop, etc.

import { supabase, supabaseEnabled } from './supabase.js';

export { supabaseEnabled };

export async function listProfiles() {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('last_seen_at', { ascending: false });
  if (error) { console.warn('listProfiles failed', error); return []; }
  return data || [];
}

export async function createProfile(name) {
  const clean = String(name || '').trim().slice(0, 20);
  if (!clean) return { ok: false, error: 'Please enter a name.' };
  if (!supabase) return { ok: true, profile: { id: localId(), name: clean } };
  const { data, error } = await supabase
    .from('profiles')
    .insert({ name: clean })
    .select()
    .single();
  if (error) {
    // 23505 = unique_violation (lower(name) index already has this one).
    if (error.code === '23505') {
      return { ok: false, error: `"${clean}" is already taken — tap their name to sign in as them, or pick a different name.` };
    }
    return { ok: false, error: error.message || 'Could not create profile.' };
  }
  return { ok: true, profile: data };
}

export async function touchProfile(id) {
  if (!supabase || !id) return;
  await supabase
    .from('profiles')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', id);
}

function localId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

// Record a completed game against a profile so lifetime stats persist
// across devices. Silent no-op if Supabase isn't configured.
export async function recordGameForProfile(profileId, record) {
  if (!supabase || !profileId) return;
  const { error } = await supabase.from('game_records').insert({
    profile_id: profileId,
    won: !!record.won,
    turn_count: record.turnCount ?? null,
    duration_ms: record.durationMs ?? null,
    deck_count: record.deckCount ?? 1,
    rules: record.rules ?? null,
    players: record.players ?? null,
    game_type: record.gameType || 'skipbo',
    started_at: record.startedAt ? new Date(record.startedAt).toISOString() : null,
    ended_at: record.endedAt ? new Date(record.endedAt).toISOString() : new Date().toISOString(),
  });
  if (error) console.warn('recordGameForProfile failed', error);
}

export async function fetchHistoryForProfile(profileId, { gameType, limit = 50 } = {}) {
  if (!supabase || !profileId) return [];
  let q = supabase
    .from('game_records')
    .select('*')
    .eq('profile_id', profileId)
    .order('ended_at', { ascending: false })
    .limit(limit);
  if (gameType) q = q.eq('game_type', gameType);
  const { data, error } = await q;
  if (error) { console.warn('fetchHistoryForProfile failed', error); return []; }
  return data || [];
}
