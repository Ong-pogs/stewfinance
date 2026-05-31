import { createClient, SupabaseClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Optional: when Supabase isn't configured, the track route falls back to a
// local JSONL sink so the demo funnel works without external creds.
export const supabaseAdmin: SupabaseClient | null =
  url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
