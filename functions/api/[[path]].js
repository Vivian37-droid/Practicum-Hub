// Cloudflare Pages Function catch-all — replaces the single
// netlify/functions/api.mjs Netlify Function. Same path-dispatch style as
// the old file (one `if (path === '...')` per view), so the two are easy to
// diff against each other during the migration.

import { context } from '../_shared/context.js';
import { HttpError, json, requireSameOrigin } from '../_shared/util.js';
import * as h from './_handlers.js';

export async function onRequest({ request, env }) {
  try {
    requireSameOrigin(request);
    const ctx = await context(request, env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    let body = {};
    if (!['GET', 'HEAD'].includes(request.method)) { try { body = await request.json(); } catch {} }
    const method = request.method;

    if (path === 'bootstrap') return json({ profile: ctx.profile, role: ctx.role, dashboard: await h.dashboard(ctx, env) });
    if (path === 'dashboard') return json(await h.dashboard(ctx, env));
    if (path === 'intern-overview') return json(await h.internOverview(ctx, env, url));
    if (path === 'interns') return json(await h.interns(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'requirements') return json(await h.requirements(ctx, env, url, body, method));
    if (path === 'cases') return json(await h.cases(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'encounters') return json(await h.encounters(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'hours') return json(await h.hoursView(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'hours-feed') return json(await h.hoursFeed(ctx, env));
    if (path === 'supervision') return json(await h.supervision(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'supervision-feed') return json(await h.supervisionFeed(ctx, env));
    if (path === 'competencies') return json(await h.competencies(ctx, env, url, body, method));
    if (path === 'reports') return json(await h.reports(ctx, env, url, body, method));
    if (path === 'referrals') return json(await h.referrals(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'milestones') return json(await h.milestones(ctx, env, url, body, method));
    if (path === 'pilot-context') return json(await h.pilotContext(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'feedback') return json(await h.feedback(ctx, env, url, body, method), method === 'POST' ? 201 : 200);
    if (path === 'audit-restore') return json(await h.restoreAudit(ctx, env, url, body, method), 201);
    if (path === 'programme') return json(await h.programme(ctx, env));
    throw new HttpError(404, 'Not found');
  } catch (error) {
    console.error(error);
    return json({ error: error.message || 'Unexpected error' }, error.status || 500);
  }
}
