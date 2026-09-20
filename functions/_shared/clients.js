// Single Supabase-facing client, reached only over HTTP (PostgREST + GoTrue)
// via supabase-js. An earlier version of this file also exported getSql(env),
// a raw Postgres connection over postgres.js for Cloudflare Workers' TCP
// socket API — but functions/api/_handlers.js never actually called it; every
// handler has always gone through getAdmin().from()/.rpc() instead. Removing
// the unused export and the postgres dependency it required.
//
// getAdmin(env) is used for everything: verifying a caller's auth token
// (auth.getUser), sending invite emails (auth.admin.inviteUserByEmail), and
// all data access via .from()/.rpc() with the service_role key (which
// bypasses Row Level Security).
//
// Cached on `globalThis` so a warm Worker isolate reuses the same client
// across requests instead of re-creating it every time.

import { createClient } from '@supabase/supabase-js';

export function getAdmin(env) {
  if (!globalThis.__phAdmin) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not configured');
    globalThis.__phAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return globalThis.__phAdmin;
}
