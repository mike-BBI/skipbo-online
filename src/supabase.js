// Shared Supabase client. Consolidating it here lets every feature
// (rooms, profiles, etc.) use the same auth/realtime session instead
// of spinning up parallel GoTrueClient instances.

import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseEnabled = Boolean(URL && KEY);
export const supabase = supabaseEnabled ? createClient(URL, KEY) : null;
