// Two Supabase-facing clients, mirroring what the old stack split across
// @netlify/database (direct Postgres access) and @netlify/identity (auth):
//
// - getSql(env): a direct Postgres connection (via postgres.js, which has
//   first-class support for Cloudflare Workers' TCP socket API — the same
//   runtime Pages Functions use) against Supabase's connection pooler. This
//   lets the query logic below be a near-literal port of the old
//   `db.pool.query('...$1...', [params])` calls, instead of a rewrite
//   against a different query builder — deliberately, to avoid introducing
//   new bugs in the pace/projection math while changing the stack under it.
// - getAdmin(env): the supabase-js client using the service_role key, used
//   only for verifying a caller's auth token (auth.getUser) and for sending
//   Supabase Auth invite emails (auth.admin.inviteUserByEmail) — the fix for
//   REBUILD_SPEC.md §5's "adding an intern doesn't send an invite" gap.
//
// Both are cached on `globalThis` so a warm Worker isolate reuses the same
// connection/client across requests instead of reconnecting every time.

import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

export function getSql(env) {
  if (!globalThis.__phSql) {
    if (!env.SUPABASE_DB_URL) throw new Error('SUPABASE_DB_URL is not configured');
    globalThis.__phSql = postgres(env.SUPABASE_DB_URL, {
      ssl: env.SUPABASE_DB_SSL === 'false' ? false : 'require',
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false
    });
  }
  return globalThis.__phSql;
}

export function getAdmin(env) {
  if (!globalThis.__phAdmin) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not configured');
    globalThis.__phAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return globalThis.__phAdmin;
}
