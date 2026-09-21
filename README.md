# Stellenbosch RC Practicum Hub — Cloudflare Pages + Supabase

This is the rebuild described in `REBUILD_SPEC.md` from the old
Netlify-hosted app (`Vivian37-droid/Practicum-Hub`). Same features, same
data model, new stack — see that spec for the full history and reasoning.
Frontend logic (`public/app.js`, `public/index.html`) is carried over almost
unchanged; what changed is what it talks to:

| | Old (Netlify) | New (this repo) |
|---|---|---|
| Hosting | Netlify static + Functions | Cloudflare Pages + Pages Functions |
| Database | Netlify DB (Neon Postgres) | Supabase Postgres |
| Auth | Netlify Identity | Supabase Auth |
| Schema | none checked in (ad hoc) | `supabase/migrations/0001_init.sql` |

## One-time setup

### 1. Create the Supabase project

1. Create a project at supabase.com, **on the work account**, not personal
   (per REBUILD_SPEC.md §8.1 — keeps billing/usage attributable to work).
2. In the SQL editor, run every file in `supabase/migrations/` in numerical
   order. Existing installations should run only the migrations that have
   not yet been applied. Migration `0012_integrated_placement_workflow.sql`
   links referrals to cases and creates placement milestones. If you use the
   Supabase CLI instead: `supabase link` then `supabase db push`.
3. Under **Authentication → Providers**, keep only Email enabled.
4. Under **Authentication → URL Configuration**, set the Site URL to your
   Cloudflare Pages URL (or custom domain) once you have it — this is where
   invite/recovery links redirect back to.
5. Under **Project Settings → API**, note down:
   - Project URL
   - `anon` `public` key
   - `service_role` key (**secret** — server-side only, never in the browser)
6. Under **Project Settings → Database → Connection pooling**, copy the
   **Transaction mode** connection string (port 6543) — this is what the
   backend uses (Cloudflare Workers' TCP support suits pooled, short-lived
   connections; the direct :5432 URL is for long-lived server processes).

### 2. Create your own programme_lead account

Rather than a hardcoded seed row, sign yourself up as the first user via
Supabase's dashboard (**Authentication → Users → Invite user**) with your
own email, then add that email to the `PROGRAMME_LEAD_EMAILS` secret below —
`context()` (`functions/_shared/context.js`) promotes anyone in that list to
`programme_lead` on their first authenticated request, same as the old
`leadEmails()` check in `netlify/functions/api.mjs`.

### 3. Configure Cloudflare Pages

1. Create a Pages project in the **work** Cloudflare account, connected to
   this repo, build output directory `public`.
2. Under **Settings → Environment variables**, add these as **secrets** for
   both Production and Preview:
   - `SUPABASE_DB_URL` — the pooler connection string from step 1.6
   - `SUPABASE_URL` — the project URL from step 1.5
   - `SUPABASE_SERVICE_ROLE_KEY` — from step 1.5
   - `PROGRAMME_LEAD_EMAILS` — comma-separated, e.g. `vivian.leibrandt@westerncape.gov.za`
   - `PUBLIC_SITE_URL` — your Pages URL, e.g. `https://practicum-hub.pages.dev`
3. Set compatibility flags: `nodejs_compat` (needed by `postgres` and
   `@supabase/supabase-js`), compatibility date `2026-09-01` or later — both
   are already in `wrangler.toml` for local `wrangler pages dev`/`deploy`,
   but the dashboard's own Pages project settings need it set too for git-
   push deploys.
4. Fill in `public/config.js` with the real Project URL and `anon` key (this
   file is intentionally plain and public — the anon key alone cannot read
   or write any table, because RLS is enabled with no policies; see the
   comment at the top of the migration file). Commit it once filled in.

### 4. Local development

```
npm install
npm run dev     # wrangler pages dev, serves public/ + functions/ locally
```

You'll still need the Supabase project reachable (it's a hosted service, so
local dev talks to your real dev/staging Supabase project — consider a
separate Supabase project for this if you don't want local testing touching
production data).

## Migrating real data from the old Netlify DB

Per REBUILD_SPEC.md §8.3 — do this via a real export, not by re-typing:

```
# From the OLD Netlify DB connection string:
pg_dump --data-only --column-inserts \
  -t profiles -t cases -t referrals -t encounters -t hours \
  -t supervision_items -t competency_progress -t requirement_opening_balances \
  -t deliverable_progress -t monthly_reports -t weekly_schedule_items \
  -t planned_activities -t pilot_feedback \
  "$OLD_NETLIFY_DB_URL" > pilot-data.sql

# Then apply to the NEW Supabase DB (after 0001_init.sql has already run,
# so requirement_profiles/requirement_components/competency_definitions IDs
# already exist and match what profiles/competency_progress reference):
psql "$SUPABASE_DB_URL" -f pilot-data.sql
```

Each intern's Supabase Auth account still needs to be created separately
(the old `identity_user_id` values won't exist in the new Supabase
`auth.users` table) — either re-invite each intern via the Interns screen
(now sends a real invite automatically, closing the gap in REBUILD_SPEC.md
§5) or use `supabase.auth.admin.inviteUserByEmail` directly for a bulk
import script.

## What changed in the port (beyond the stack swap)

- **§3 bugs are not reintroduced.** The single delegated `submit` listener
  (`FORM_HANDLERS`/`registerForm`) is unchanged in `public/app.js`. The
  `updated_by_identity_user_id` column exists on every table that needs it
  from the first migration — there is no more drift between what the code
  queries and what the database has, because this file *is* the schema.
- **§4 gap closed:** `functions/api/_handlers.js` adds `supervisionFeed()`
  and `hoursFeed()` (routes `GET /api/supervision-feed`, `GET
  /api/hours-feed`) — a combined, cross-intern view for programme_lead/
  supervisor. In the UI, opening Supervision or Activity Log without picking
  an intern from the switcher now shows this combined feed instead of just
  "select an intern first."
- **§5 gap closed:** `interns()` in `_handlers.js` calls
  `supabase.auth.admin.inviteUserByEmail` when a genuinely new intern
  profile is created, so adding an intern sends their sign-in invitation
  immediately — no separate manual step in a different dashboard.
- **Demo/preview mode is unchanged** (`?preview=intern|programme_lead|management`,
  or localhost) — still pure client-side fake data, no backend calls.
- **Integrated operational workflow:** booked, intake-completed and active
  referrals automatically create or update one linked case. The Programme
  Lead dashboard adds acceptance, stale-case and milestone prompts; the
  intern overview brings requirements, referrals, cases, supervision,
  schedule and milestones together; and a read-only intern preview shows
  the intern-facing placement summary without granting intern permissions.

## Architecture note: why `postgres` + Supabase Auth, not RLS + supabase-js everywhere

The Pages Function (`functions/api/[[path]].js` → `_handlers.js`) connects
directly to Postgres with the `postgres` npm package (which has native
Cloudflare Workers TCP-socket support) using the `service_role`/pooler
connection string, and does its own authorization in JS — replicating the
old Netlify Function's `db.pool.query()` + in-JS role checks almost line for
line. This was a deliberate choice over rewriting the business logic (the
pace/projection/caseload math in `requirementProgress()`) against the
supabase-js query builder or as SQL functions: the math is intricate and the
risk of a subtle translation bug was judged higher than the benefit of a
"more idiomatic Supabase" architecture. Row Level Security is still enabled
on every table as defense-in-depth (see the migration file), so the
browser's `anon` key — used only for Supabase Auth (`supabase-js` on the
frontend) — cannot reach any table directly.

If this is ever revisited, the natural next step is converting
`requirementProgress()` into a Postgres function (`supabase/migrations/
0002_functions.sql`, called via `.rpc()`) so per-intern requirement
computation happens in one round trip instead of ~7 queries — a real
performance win once the intern count grows, but not required for the pilot
scale this is launching at.

## Deploy checklist (REBUILD_SPEC.md §8)

1. ✅ Supabase project + Cloudflare Pages project on the work account.
2. ✅ Schema migration (`0001_init.sql`) — apply before anything else.
3. ⬜ Export real pilot data from the old Netlify DB and import (see above).
4. ✅ Frontend ported.
5. ✅ Netlify Identity → Supabase Auth.
6. ✅ Auto-invite on intern creation.
7. ⬜ Point your domain at the Cloudflare Pages project.
8. ⬜ Keep the old Netlify site live until this one is verified end-to-end
   with a real login, then decommission it.
