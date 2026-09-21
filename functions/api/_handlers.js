// View handlers — a port of the corresponding functions in the old
// netlify/functions/api.mjs (dashboard, interns, requirements, cases,
// encounters, hours, supervision, competencies, reports, referrals,
// pilotContext, feedback, programme).
//
// As of the PostgREST migration, these no longer run raw `sql`
// tagged-template queries over a direct TCP Postgres connection (which was
// unreliable from Cloudflare Pages Functions — see clients.js). Simple
// single-table reads/writes use supabase-js's `.from()` query builder;
// joins PostgREST can't embed cleanly, multi-row aggregates, and
// conditional/only-once-set-timestamp updates call the Postgres functions
// defined in supabase/migrations/0002_rpc_functions.sql via `.rpc()`.
// Every call is still exactly one HTTP round trip.
//
// Two additions beyond the old app, both called out in REBUILD_SPEC.md as
// things to build in this rebuild rather than defer again:
//   - interns(): POST now sends a real Supabase Auth invite email (§5).
//   - supervisionFeed() / hoursFeed(): cross-intern aggregate views for
//     programme_lead/supervisor (§4 gap — "no bird's-eye view").

import { getAdmin } from '../_shared/clients.js';
import { requireRole, assertInternAccess, audit, loadProfile } from '../_shared/context.js';
import {
  HttpError, num, round, dateValue, limited, requireMethod, cleanEmail, unwrap,
  monthEnd, CASE_STATUSES, SUPERVISION_STATUSES, SUPERVISION_PRIORITIES,
  SESSION_TYPES, GENDERS, REFERRAL_STATUSES, REFERRAL_PRIORITIES
} from '../_shared/util.js';

// Flattens a PostgREST-embedded `profiles(display_name)` (or
// `profiles!inner(...)`) relation into a top-level `intern_name` field,
// matching the shape the old `JOIN profiles p ... p.display_name intern_name`
// queries returned.
function withInternName(rows) {
  return (rows || []).map(r => {
    const { profiles, ...rest } = r;
    return { ...rest, intern_name: profiles?.display_name ?? null };
  });
}

// The old SQL ordered referrals by `COALESCE(next_action_date, referral_date)
// DESC`, which PostgREST's `.order()` can't express directly (it orders by a
// single real column). Sorting client-side after fetching in created_at-desc
// order keeps the same effective ordering, since JS's sort is stable.
function sortReferrals(rows) {
  return rows.sort((a, b) => new Date(b.next_action_date || b.referral_date) - new Date(a.next_action_date || a.referral_date));
}

const ACTIVITY_SERVICE_TYPES = new Set([
  'Individual counselling',
  'Group counselling',
  'Family counselling',
  'Community talk / psychoeducation',
  'Public health / advocacy',
  'Preparation / documentation',
  'Training',
  'Supervision',
  'Psychological assessment',
  'Ethical / professional activity',
  'Other professional activity'
]);
function activityServiceType(value) {
  const result = value || 'Other professional activity';
  if (!ACTIVITY_SERVICE_TYPES.has(result)) throw new HttpError(400, 'Choose a valid activity type');
  return result;
}

async function requirementProgress(env, id) {
  const admin = getAdmin(env);
  const { data, error } = await admin.rpc('requirement_progress_data', { p_intern_id: id });
  if (error) {
    if (/Intern not found/i.test(error.message || '')) throw new HttpError(404, 'Intern not found');
    throw new HttpError(500, error.message);
  }
  const profile = data.profile;
  const components = data.components || [];
  const manualMap = data.manual || {};
  const encounter = data.encounter || {};
  const recentEncounter = data.recent_encounter || {};
  const activeCases = data.active_cases || {};
  const deliverableMap = data.deliverables || {};
  const openingMap = data.opening || {};

  const start = profile.placement_start ? new Date(profile.placement_start) : null;
  const end = profile.placement_end ? new Date(profile.placement_end) : null;
  const now = new Date();
  const weeksBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / (7 * 86400000));
  const elapsedWeeks = start ? Math.max(0.25, weeksBetween(start, now)) : null;
  const recentWindowWeeks = elapsedWeeks == null ? 4 : Math.min(4, elapsedWeeks);
  const weeksRemaining = end ? Math.max(0, weeksBetween(now, end)) : null;
  const attendance = num(encounter.booked) ? num(encounter.attended) / num(encounter.booked) : null;
  const averageSessionMinutes = num(encounter.avg_minutes) || num(profile.default_session_minutes) || 60;
  const encounterHours = num(encounter.minutes) / 60;
  const recentEncounterHours = num(recentEncounter.minutes) / 60;

  const rows = components.map(component => {
    const openingHours = num(openingMap[component.id]?.hours);
    const manualHours = num(manualMap[component.code]?.total);
    const recentManualHours = num(manualMap[component.code]?.recent);
    let completed = openingHours + manualHours;
    let recentHours = recentManualHours;
    if (component.calculation_mode === 'individual_encounters') {
      completed = openingHours + encounterHours;
      recentHours = recentEncounterHours;
    } else if (component.calculation_mode === 'manual_plus_individual_encounters') {
      completed = openingHours + manualHours + encounterHours;
      recentHours = recentManualHours + recentEncounterHours;
    }

    if (component.calculation_mode === 'deliverable') {
      const d = deliverableMap[component.id] || { status: 'Not started', note: null };
      return { ...component, deliverable_status: d.status, deliverable_note: d.note, status: d.status === 'Complete' ? 'Complete' : 'Action needed' };
    }

    const target = component.target_hours == null ? null : num(component.target_hours);
    const remaining = target == null ? null : Math.max(0, target - completed);
    const recentWeeklyPace = recentWindowWeeks ? recentHours / recentWindowWeeks : 0;
    const lifetimeWeeklyPace = elapsedWeeks ? completed / elapsedWeeks : 0;
    const paceForProjection = elapsedWeeks != null && elapsedWeeks < 4 ? lifetimeWeeklyPace : recentWeeklyPace;
    const neededPerWeek = target == null || weeksRemaining == null || weeksRemaining <= 0 ? null : remaining / weeksRemaining;
    const projected = target == null || weeksRemaining == null ? null : completed + paceForProjection * weeksRemaining;
    let status = 'Not configured';
    if (target != null) {
      if (remaining <= 0) status = 'Complete';
      else if (!component.counts_for_pace) status = 'Monitor';
      else if (weeksRemaining == null) status = 'Dates needed';
      else if (weeksRemaining <= 0) status = 'Target at risk';
      else if (projected >= target) status = 'On track';
      else if (projected >= target * 0.9) status = 'Watch';
      else status = 'Target at risk';
    }
    return {
      ...component,
      opening_balance: round(openingHours, 1),
      opening_balance_note: openingMap[component.id]?.note || null,
      completed: round(completed, 1),
      remaining: remaining == null ? null : round(remaining, 1),
      recent_weekly_pace: round(recentWeeklyPace, 1),
      lifetime_weekly_pace: round(lifetimeWeeklyPace, 1),
      needed_per_week: neededPerWeek == null ? null : round(neededPerWeek, 1),
      projected_completion: projected == null ? null : round(projected, 1),
      status
    };
  });

  const hourComponents = rows.filter(x => x.target_hours != null && x.calculation_mode !== 'deliverable');
  const totalCompleted = hourComponents.reduce((sum, x) => sum + num(x.completed), 0);
  const totalTarget = num(profile.overall_programme_hours || profile.required_hours || 720);
  const atRisk = rows.filter(x => x.status === 'Target at risk').length;
  const watch = rows.filter(x => x.status === 'Watch').length;
  const datesNeeded = rows.filter(x => x.status === 'Dates needed').length;
  const outstandingDeliverables = rows.filter(x => x.calculation_mode === 'deliverable' && x.deliverable_status !== 'Complete').length;

  const clinical = rows.find(x => ['individual_counselling', 'combined_counselling'].includes(x.component_type));
  const sessionHours = averageSessionMinutes / 60;
  const sessionsRemaining = clinical?.remaining == null ? null : num(clinical.remaining) / sessionHours;
  const bookingsRemaining = sessionsRemaining == null || attendance == null ? null : sessionsRemaining / attendance;
  const sessionsNeeded = clinical?.needed_per_week == null ? null : clinical.needed_per_week / sessionHours;
  const bookingsNeeded = sessionsNeeded == null || attendance == null ? null : sessionsNeeded / attendance;
  const recentClinicalWeeklyPace = num(clinical?.recent_weekly_pace);
  const estimatedClinicalWeeksToTarget = clinical?.remaining != null && recentClinicalWeeklyPace > 0 ? num(clinical.remaining) / recentClinicalWeeklyPace : null;
  // Prompt 8: "present implausibly distant projections as 'not viable at
  // current pace' rather than a falsely precise date." A ~6-month
  // practicum projecting a completion date years out at the current pace
  // isn't a useful estimate — it's noise dressed up as precision. 104
  // weeks (2 years) is a generous cap: nothing this app tracks plausibly
  // extends a placement anywhere near that far.
  const PACE_HORIZON_WEEKS = 104;
  const clinicalPaceNotViable = estimatedClinicalWeeksToTarget != null && estimatedClinicalWeeksToTarget > PACE_HORIZON_WEEKS;
  const estimatedClinicalTargetDate = (estimatedClinicalWeeksToTarget == null || clinicalPaceNotViable) ? null : new Date(now.getTime() + estimatedClinicalWeeksToTarget * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const plannedWeeklyBookings = num(activeCases.weekly_bookings);
  const expectedAttended = plannedWeeklyBookings * (attendance ?? 1);
  const expectedClinicalHours = expectedAttended * sessionHours;
  let caseloadStatus = 'Insufficient data';
  let additionalBookings = null;
  if (clinical?.needed_per_week != null) {
    if (expectedClinicalHours >= clinical.needed_per_week * 0.95) caseloadStatus = 'Current individual caseload appears sufficient';
    else {
      caseloadStatus = 'Additional allocation / throughput may be needed';
      const gap = Math.max(0, clinical.needed_per_week - expectedClinicalHours);
      additionalBookings = gap / sessionHours / (attendance && attendance > 0 ? attendance : 1);
    }
  }

  return {
    profile,
    components: rows,
    summary: {
      total_completed: round(totalCompleted, 1),
      total_target: totalTarget,
      overall_percent: totalTarget ? round(totalCompleted / totalTarget * 100, 0) : null,
      weeks_remaining: weeksRemaining == null ? null : round(weeksRemaining, 1),
      elapsed_weeks: elapsedWeeks == null ? null : round(elapsedWeeks, 1),
      attendance_rate: attendance == null ? null : round(attendance * 100, 0),
      average_session_minutes: round(averageSessionMinutes, 0),
      session_minutes_source: encounter.avg_minutes ? 'actual average' : 'configured default',
      clinical_component: clinical?.name || null,
      clinical_hours_needed_per_week: clinical?.needed_per_week ?? null,
      counselling_sessions_remaining: sessionsRemaining == null ? null : round(sessionsRemaining, 1),
      bookings_remaining: bookingsRemaining == null ? null : round(bookingsRemaining, 1),
      counselling_sessions_needed_per_week: sessionsNeeded == null ? null : round(sessionsNeeded, 1),
      bookings_needed_per_week: bookingsNeeded == null ? null : round(bookingsNeeded, 1),
      recent_clinical_weekly_pace: recentClinicalWeeklyPace ? round(recentClinicalWeeklyPace, 1) : null,
      estimated_clinical_weeks_to_target: estimatedClinicalWeeksToTarget == null ? null : round(estimatedClinicalWeeksToTarget, 1),
      estimated_clinical_target_date: estimatedClinicalTargetDate,
      clinical_pace_not_viable: clinicalPaceNotViable,
      active_cases: num(activeCases.n),
      planned_bookings_from_caseload: round(plannedWeeklyBookings, 1),
      expected_attended_sessions: round(expectedAttended, 1),
      caseload_status: caseloadStatus,
      additional_bookings_needed: additionalBookings == null ? null : round(additionalBookings, 1),
      at_risk_components: atRisk,
      watch_components: watch,
      dates_needed_components: datesNeeded,
      outstanding_deliverables: outstandingDeliverables
    }
  };
}

export async function dashboard(ctx, env) {
  if (ctx.role === 'management') return programme(ctx, env);
  const admin = getAdmin(env);
  if (ctx.role === 'intern') {
    const [casesRes, supervisionRes] = await Promise.all([
      admin.from('cases').select('id', { count: 'exact', head: true }).eq('intern_profile_id', ctx.profile.id).neq('status', 'Exited'),
      admin.from('supervision_items').select('id', { count: 'exact', head: true }).eq('intern_profile_id', ctx.profile.id).eq('status', 'Open')
    ]);
    if (casesRes.error) throw new HttpError(500, casesRes.error.message);
    if (supervisionRes.error) throw new HttpError(500, supervisionRes.error.message);
    const requirements = await requirementProgress(env, ctx.profile.id);
    return { profile: ctx.profile, requirements, metrics: { active_cases: casesRes.count, open_supervision: supervisionRes.count } };
  }
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const supervisorId = ctx.role === 'supervisor' ? ctx.user.id : null;
  const listRows = unwrap(await admin.rpc('list_interns_with_counts', { p_supervisor_id: supervisorId, p_only_active: true }));
  let interns = (listRows || []).map(r => r.profile);
  interns = await Promise.all(interns.map(async p => {
    const req = await requirementProgress(env, p.id);
    return { ...p, requirements: req.summary, requirement_profile_name: req.profile.requirement_profile_name };
  }));
  const metrics = interns.reduce((a, p) => ({
    interns: a.interns + 1,
    active_cases: a.active_cases + p.active_cases,
    open_supervision: a.open_supervision + p.open_supervision,
    at_risk: a.at_risk + (p.requirements.at_risk_components > 0 ? 1 : 0)
  }), { interns: 0, active_cases: 0, open_supervision: 0, at_risk: 0 });
  const queue = await buildQueue(env, ctx, interns, supervisorId);
  return { profile: ctx.profile, interns, metrics, queue };
}

// Prompt 6: "add an actionable dashboard queue for missing setup, overdue
// referrals, unreviewed reports, unresolved supervision items and other
// items requiring attention... each queue item must explain why it needs
// attention and link directly to the relevant record." Every item here is
// read directly off real rows (no invented/estimated data) and carries a
// `view` + `intern_id` the client uses to jump straight to the record with
// the right intern already selected.
async function buildQueue(env, ctx, interns, supervisorId) {
  const admin = getAdmin(env);
  const items = [];

  for (const p of interns) {
    const missing = [];
    if (!p.institution) missing.push('institution');
    if (!p.placement_start) missing.push('placement start date');
    if (!p.placement_end) missing.push('placement end date');
    if (!p.identity_user_id) missing.push('login invitation');
    if (missing.length) items.push({
      kind: 'missing_setup', severity: 'amber',
      title: `${p.display_name}: incomplete placement setup`,
      reason: `Missing ${missing.join(', ')}.`,
      view: 'interns', intern_id: p.id
    });
  }

  let refQuery = admin.from('referrals')
    .select('id, referral_code, status, next_action_date, intern_profile_id, profiles(display_name, supervisor_identity_user_id)')
    .not('next_action_date', 'is', null)
    .lt('next_action_date', new Date().toISOString().slice(0, 10))
    .order('next_action_date', { ascending: true })
    .limit(20);
  if (supervisorId) refQuery = refQuery.eq('profiles.supervisor_identity_user_id', supervisorId);
  const { data: overdueRefs, error: refErr } = await refQuery;
  if (refErr) throw new HttpError(500, refErr.message);
  for (const r of (overdueRefs || [])) {
    if (String(r.status || '').startsWith('Closed')) continue;
    const days = Math.max(0, Math.floor((Date.now() - new Date(r.next_action_date)) / 86400000));
    items.push({
      kind: 'overdue_referral', severity: 'red',
      title: `Referral ${r.referral_code || '#' + r.id} overdue`,
      reason: `Next action was due ${days} day${days === 1 ? '' : 's'} ago (${r.profiles?.display_name || 'intern'}).`,
      view: 'referrals', intern_id: r.intern_profile_id
    });
  }

  let repQuery = admin.from('monthly_reports')
    .select('id, month, submitted_at, intern_profile_id, profiles(display_name, supervisor_identity_user_id)')
    .eq('status', 'Submitted')
    .order('month', { ascending: true })
    .limit(20);
  if (supervisorId) repQuery = repQuery.eq('profiles.supervisor_identity_user_id', supervisorId);
  const { data: pendingReports, error: repErr } = await repQuery;
  if (repErr) throw new HttpError(500, repErr.message);
  for (const r of (pendingReports || [])) {
    items.push({
      kind: 'unreviewed_report', severity: 'amber',
      title: `${r.profiles?.display_name || 'Intern'}'s ${String(r.month).slice(0, 7)} report awaiting review`,
      reason: `Submitted${r.submitted_at ? ' ' + new Date(r.submitted_at).toLocaleDateString() : ''} and not yet reviewed.`,
      view: 'reports', intern_id: r.intern_profile_id
    });
  }

  const supRows = unwrap(await admin.rpc('supervision_feed', { p_supervisor_id: supervisorId }));
  for (const row of (supRows || [])) {
    const it = row.item || row;
    if (it.status !== 'Open') continue;
    items.push({
      kind: 'open_supervision', severity: it.priority === 'Urgent' ? 'red' : 'amber',
      title: `Supervision: ${it.topic || 'Untitled item'}${it.intern_name ? ' — ' + it.intern_name : ''}`,
      reason: `Open supervision item${it.priority ? ' (' + it.priority + ' priority)' : ''} awaiting a response.`,
      view: 'supervision', intern_id: it.intern_profile_id
    });
  }

  const rank = { red: 0, amber: 1 };
  items.sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
  return items.slice(0, 30);
}

export async function interns(ctx, env, url, body, method) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const admin = getAdmin(env);
  // Prompt 4: removing an intern used to hard-delete `profiles` (cascading
  // away every case/hours/supervision/report/referral row) and the linked
  // Supabase Auth account — irreversible, and it destroyed exactly the
  // hour-tracking history this app exists to keep. Deactivating instead
  // (profiles.active = false, a column/flag list_interns_with_counts,
  // upsert_intern and programme_metrics already respect) removes the intern
  // from active rosters and blocks their login (see the active-check in
  // context()) while preserving every historical record intact and
  // reversible via the PATCH reactivate branch below.
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const internId = Number(url.searchParams.get('id') || body.id || 0);
    if (!internId) throw new HttpError(400, 'Intern id is required');
    const { data: row, error } = await admin.from('profiles').select('id, display_name, email, active').eq('id', internId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Intern not found');
    if (row.active === false) throw new HttpError(400, 'This placement is already deactivated');
    const reason = limited(body.reason, 500, 'Reason', true);
    const { error: updErr } = await admin.from('profiles').update({ active: false }).eq('id', internId);
    if (updErr) throw new HttpError(500, updErr.message);
    await audit(ctx, env, 'deactivate', 'intern', internId, { display_name: row.display_name, email: row.email }, internId, reason);
    return { ok: true, deactivated_id: internId };
  }
  if (method === 'PATCH' && body.action === 'reactivate') {
    requireRole(ctx, ['programme_lead']);
    const internId = Number(body.id || 0);
    if (!internId) throw new HttpError(400, 'Intern id is required');
    const { data: row, error } = await admin.from('profiles').select('id, display_name, active').eq('id', internId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Intern not found');
    if (row.active !== false) throw new HttpError(400, 'This placement is already active');
    const { error: updErr } = await admin.from('profiles').update({ active: true }).eq('id', internId);
    if (updErr) throw new HttpError(500, updErr.message);
    await audit(ctx, env, 'reactivate', 'intern', internId, { display_name: row.display_name }, internId);
    return { ok: true, reactivated_id: internId };
  }
  if (method === 'PATCH' && body.action === 'purge_test_intern') {
    requireRole(ctx, ['programme_lead']);
    const internId = Number(body.id || 0);
    if (!internId) throw new HttpError(400, 'Intern id is required');
    const { data: row, error } = await admin.from('profiles').select('id, display_name, email, active, identity_user_id').eq('id', internId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Intern not found');
    if (row.active !== false) throw new HttpError(400, 'Deactivate the test placement before permanently deleting it');
    if (cleanEmail(body.confirm_email) !== cleanEmail(row.email)) throw new HttpError(400, 'Enter the intern email exactly to confirm permanent deletion');
    const reason = limited(body.reason, 500, 'Reason', true);
    await audit(ctx, env, 'purge_test_intern', 'intern', internId, { display_name: row.display_name, email: row.email }, internId, reason);
    if (row.identity_user_id) {
      const { error: authErr } = await admin.auth.admin.deleteUser(row.identity_user_id);
      if (authErr) throw new HttpError(500, `The placement was not deleted because the sign-in account could not be removed: ${authErr.message}`);
    }
    const { error: deleteErr } = await admin.from('profiles').delete().eq('id', internId);
    if (deleteErr) throw new HttpError(500, deleteErr.message);
    return { ok: true, purged_id: internId };
  }
  // Prompt 8: "invitation date, invitation status, last login and a safe
  // resend-invitation action." Supabase Auth already tracks invited_at/
  // confirmed_at/last_sign_in_at on the auth user itself — no new columns
  // needed, just surfacing what's already there.
  if (method === 'PATCH' && body.action === 'resend_invite') {
    requireRole(ctx, ['programme_lead']);
    const internId = Number(body.id || 0);
    if (!internId) throw new HttpError(400, 'Intern id is required');
    const { data: row, error } = await admin.from('profiles').select('id, display_name, email, identity_user_id').eq('id', internId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Intern not found');
    // Safe = never resend to someone who has already accepted and signed
    // in; that would be confusing at best, and inviteUserByEmail is meant
    // for first-time setup, not an already-active account.
    if (row.identity_user_id) {
      const { data: authLookup, error: authErr } = await admin.auth.admin.getUserById(row.identity_user_id);
      if (authErr) throw new HttpError(500, authErr.message);
      if (authLookup?.user?.confirmed_at) throw new HttpError(400, `${row.display_name} has already accepted their invitation and signed in — resending is not needed.`);
    }
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(row.email, {
      data: { display_name: row.display_name, roles: ['intern'] },
      redirectTo: env.PUBLIC_SITE_URL ? `${env.PUBLIC_SITE_URL}/` : undefined
    });
    if (inviteErr) throw new HttpError(500, inviteErr.message);
    await audit(ctx, env, 'resend_invite', 'intern', internId, { email: row.email }, internId);
    return { ok: true, resent_id: internId };
  }
  if (method === 'GET') {
    const supervisorId = ctx.role === 'supervisor' ? ctx.user.id : null;
    const listRows = unwrap(await admin.rpc('list_interns_with_counts', { p_supervisor_id: supervisorId, p_only_active: false }));
    let list = (listRows || []).map(r => r.profile);
    list = await Promise.all(list.map(async p => {
      let invite = { status: 'Not yet invited', invited_at: null, last_sign_in_at: null };
      if (p.identity_user_id) {
        try {
          const { data: authLookup, error: authErr } = await admin.auth.admin.getUserById(p.identity_user_id);
          if (authErr) throw authErr;
          const u = authLookup?.user;
          invite = {
            status: u?.confirmed_at ? 'Active' : 'Invited — pending',
            invited_at: u?.invited_at || u?.created_at || null,
            last_sign_in_at: u?.last_sign_in_at || null
          };
        } catch (e) {
          invite = { status: 'Unknown', invited_at: null, last_sign_in_at: null };
        }
      }
      return { ...p, requirement_summary: (await requirementProgress(env, p.id)).summary, invite };
    }));
    return list;
  }
  requireRole(ctx, ['programme_lead']);
  const email = cleanEmail(body.email);
  const name = String(body.display_name || '').trim();
  if (!email || !name) throw new HttpError(400, 'Name and email are required');
  const institution = body.institution || 'Other';
  const code = institution === 'SACAP' ? 'sacap-bpsych' : institution === 'Cornerstone Institute' ? 'cornerstone-bpsych' : 'generic-720';
  const result = unwrap(await admin.rpc('upsert_intern', {
    p_email: email,
    p_name: name,
    p_institution: institution,
    p_code: code,
    p_placement_start: body.placement_start || null,
    p_placement_end: body.placement_end || null,
    p_default_minutes: num(body.default_session_minutes || 60),
    p_supervisor_id: ctx.user.id
  }));
  const { was_existing: wasExisting, ...row } = result;
  await audit(ctx, env, 'create_or_update', 'intern', row.id, { institution }, row.id);

  // §5 fix: sending the invite is no longer a separate manual step in a
  // different vendor dashboard — creating the placement here sends it.
  let invite = { sent: false, reason: null };
  if (!wasExisting) {
    try {
      const { error } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { display_name: name, roles: ['intern'] },
        redirectTo: env.PUBLIC_SITE_URL ? `${env.PUBLIC_SITE_URL}/` : undefined
      });
      if (error) invite = { sent: false, reason: error.message };
      else invite = { sent: true, reason: null };
    } catch (e) {
      invite = { sent: false, reason: e.message || 'Invite could not be sent' };
    }
  }
  return { ...row, invite };
}

export async function requirements(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return requirementProgress(env, id);
  if (method === 'PATCH') {
    const { data: internRow, error: internErr } = await admin.from('profiles').select('requirement_profile_id').eq('id', id).maybeSingle();
    if (internErr) throw new HttpError(500, internErr.message);
    const { data: component, error: compErr } = await admin.from('requirement_components').select('*')
      .eq('id', Number(body.component_id))
      .eq('requirement_profile_id', internRow?.requirement_profile_id ?? -1)
      .maybeSingle();
    if (compErr) throw new HttpError(500, compErr.message);
    if (!component) throw new HttpError(400, 'Requirement component not found');
    if (body.action === 'opening_balance') {
      requireRole(ctx, ['programme_lead', 'supervisor']);
      const value = num(body.hours);
      if (value < 0 || value > 2000) throw new HttpError(400, 'Invalid opening balance');
      const row = unwrap(await admin.from('requirement_opening_balances').upsert({
        intern_profile_id: id,
        component_id: component.id,
        hours: value,
        note: body.note || 'Opening balance from existing institutional logbook',
        updated_by_identity_user_id: ctx.user.id,
        updated_at: new Date().toISOString()
      }, { onConflict: 'intern_profile_id,component_id' }).select().single());
      await audit(ctx, env, 'update', 'opening_balance', row.id, { component: component.code, hours: value }, id);
      return row;
    }
    if (component.calculation_mode !== 'deliverable') throw new HttpError(400, 'Deliverable not found');
    const status = ['Not started', 'In progress', 'Complete'].includes(body.status) ? body.status : 'Not started';
    const row = unwrap(await admin.from('deliverable_progress').upsert({
      intern_profile_id: id,
      component_id: component.id,
      status,
      note: body.note || null,
      updated_by_identity_user_id: ctx.user.id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'intern_profile_id,component_id' }).select().single());
    await audit(ctx, env, 'update', 'deliverable', row.id, { status }, id);
    return row;
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function cases(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const caseId = Number(url.searchParams.get('id') || body.id || 0);
    if (!caseId) throw new HttpError(400, 'Case id is required');
    const { data: row, error } = await admin.from('cases').select('*').eq('id', caseId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Case not found');
    // A case's encounters cascade-delete with it (encounters.case_id ON
    // DELETE CASCADE) — unlike referrals/supervision/pilot_feedback, that
    // child data can't be snapshotted back by restoreAudit(), so this stays
    // a real, unrecoverable deletion and always requires a reason.
    const reason = limited(body.reason, 500, 'Reason', true);
    await audit(ctx, env, 'delete', 'case', caseId, { case_code: row.case_code, sessions: row.sessions }, row.intern_profile_id, reason);
    const { error: delErr } = await admin.from('cases').delete().eq('id', caseId);
    if (delErr) throw new HttpError(500, delErr.message);
    return { ok: true, deleted_id: caseId };
  }
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  if (method === 'GET') {
    if (id) {
      await assertInternAccess(ctx, id, env);
      const rows = unwrap(await admin.from('cases').select('*, profiles(display_name)').eq('intern_profile_id', id).order('updated_at', { ascending: false }));
      return withInternName(rows);
    }
    requireRole(ctx, ['programme_lead', 'supervisor']);
    let q = admin.from('cases')
      .select(ctx.role === 'supervisor' ? '*, profiles!inner(display_name, supervisor_identity_user_id)' : '*, profiles(display_name)')
      .order('updated_at', { ascending: false });
    if (ctx.role === 'supervisor') q = q.eq('profiles.supervisor_identity_user_id', ctx.user.id);
    const rows = unwrap(await q);
    return withInternName(rows);
  }
  if (method === 'POST') {
    requireRole(ctx, ['programme_lead', 'supervisor']);
    await assertInternAccess(ctx, id, env);
    const caseCode = limited(body.case_code, 50, 'Case code', true)?.toUpperCase();
    const site = limited(body.site, 120, 'Site', true);
    const category = limited(body.presenting_category, 120, 'Presenting category');
    const status = body.status || 'Allocated';
    const frequency = Number(body.planned_frequency_weeks || 1);
    if (!CASE_STATUSES.has(status)) throw new HttpError(400, 'Invalid case status');
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > 52) throw new HttpError(400, 'Invalid planned frequency');
    const row = unwrap(await admin.from('cases').insert({
      case_code: caseCode,
      intern_profile_id: id,
      site,
      presenting_category: category,
      status,
      planned_frequency_weeks: frequency,
      created_by_identity_user_id: ctx.user.id
    }).select().single());
    await audit(ctx, env, 'create', 'case', row.id, null, id);
    return row;
  }
  if (method === 'PATCH') {
    const { data: row, error } = await admin.from('cases').select('*').eq('id', Number(body.id)).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Case not found');
    await assertInternAccess(ctx, row.intern_profile_id, env);
    const status = body.status || row.status;
    if (!CASE_STATUSES.has(status)) throw new HttpError(400, 'Invalid case status');
    const requestedFrequency = body.planned_frequency_weeks == null ? null : Number(body.planned_frequency_weeks);
    if (requestedFrequency != null && (ctx.role === 'intern' || !Number.isInteger(requestedFrequency) || requestedFrequency < 1 || requestedFrequency > 52)) throw new HttpError(403, 'Only a supervisor can change planned frequency');
    const supervisionStatus = limited(body.supervision_status, 60, 'Supervision status');
    const updated = unwrap(await admin.rpc('update_case_status', {
      p_case_id: row.id,
      p_status: status,
      p_supervision_status: supervisionStatus,
      p_frequency: requestedFrequency
    }));
    await audit(ctx, env, 'update', 'case', row.id, { status, planned_frequency_weeks: updated.planned_frequency_weeks }, row.intern_profile_id);
    return updated;
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function encounters(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const encId = Number(url.searchParams.get('id') || body.id || 0);
    if (!encId) throw new HttpError(400, 'Encounter id is required');
    const { data: row, error } = await admin.from('encounters').select('*').eq('id', encId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Encounter not found');
    const reason = limited(body.reason, 500, 'Reason');
    await audit(ctx, env, 'delete', 'encounter', encId, { ...row }, row.intern_profile_id, reason);
    const { error: delErr } = await admin.from('encounters').delete().eq('id', encId);
    if (delErr) throw new HttpError(500, delErr.message);
    return { ok: true, deleted_id: encId };
  }
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') {
    const rows = unwrap(await admin.from('encounters').select('*, cases(case_code)').eq('intern_profile_id', id)
      .order('encounter_date', { ascending: false }).order('created_at', { ascending: false }));
    return rows.map(r => { const { cases: c, ...rest } = r; return { ...rest, case_code: c?.case_code ?? null }; });
  }
  requireMethod(method, ['POST']);
  const { data: theCase, error: caseErr } = await admin.from('cases').select('*').eq('id', Number(body.case_id)).maybeSingle();
  if (caseErr) throw new HttpError(500, caseErr.message);
  if (!theCase || theCase.intern_profile_id !== id) throw new HttpError(400, 'Case does not belong to this intern');
  const booked = String(body.booked) !== 'false';
  const attended = String(body.attended) !== 'false';
  const profile = await loadProfile(env, id);
  const duration = attended ? Math.max(1, num(body.duration_minutes || profile.default_session_minutes || 60)) : 0;
  if (duration > 480) throw new HttpError(400, 'Duration cannot exceed 480 minutes');
  if (!SESSION_TYPES.has(body.session_type)) throw new HttpError(400, 'Invalid session type');
  const gender = body.patient_gender || 'Unknown';
  if (!GENDERS.has(gender)) throw new HttpError(400, 'Invalid gender value');
  const row = unwrap(await admin.rpc('create_encounter', {
    p_case_id: theCase.id,
    p_intern_id: id,
    p_encounter_date: dateValue(body.encounter_date, 'Encounter date'),
    p_booked: booked,
    p_attended: attended,
    p_session_type: body.session_type,
    p_gender: gender,
    p_site: theCase.site,
    p_duration: duration,
    p_created_by: ctx.user.id
  }));
  await audit(ctx, env, 'create', 'encounter', row.id, { attended, duration_minutes: duration }, id);
  return row;
}

export async function hoursView(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const hoursId = Number(url.searchParams.get('id') || body.id || 0);
    if (!hoursId) throw new HttpError(400, 'Hours entry id is required');
    const { data: row, error } = await admin.from('hours').select('*').eq('id', hoursId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Hours entry not found');
    // Prompt 4: "a correction workflow for logged hours rather than silent
    // destructive deletion" — the PATCH branch below is the primary path for
    // fixing a wrong entry now. Delete remains for genuine duplicates/
    // wrong-intern entries, and always requires a reason since it destroys
    // logged clinical-hour evidence outright.
    const reason = limited(body.reason, 500, 'Reason', true);
    await audit(ctx, env, 'delete', 'hours', hoursId, { ...row }, row.intern_profile_id, reason);
    const { error: delErr } = await admin.from('hours').delete().eq('id', hoursId);
    if (delErr) throw new HttpError(500, delErr.message);
    return { ok: true, deleted_id: hoursId };
  }
  if (method === 'PATCH') {
    requireRole(ctx, ['programme_lead']);
    const hoursId = Number(body.id || 0);
    if (!hoursId) throw new HttpError(400, 'Hours entry id is required');
    const { data: row, error } = await admin.from('hours').select('*').eq('id', hoursId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Hours entry not found');
    const reason = limited(body.reason, 500, 'Correction reason', true);
    const value = body.hours == null ? row.hours : num(body.hours);
    if (!(value > 0 && value <= 24)) throw new HttpError(400, 'Hours must be greater than 0 and no more than 24');
    const workDate = body.work_date ? dateValue(body.work_date, 'Work date') : row.work_date;
    let componentCode = row.component_code, category = row.category;
    if (body.component_code && body.component_code !== row.component_code) {
      const { data: profileRow, error: profErr } = await admin.from('profiles').select('requirement_profile_id').eq('id', row.intern_profile_id).maybeSingle();
      if (profErr) throw new HttpError(500, profErr.message);
      const { data: component, error: compErr } = await admin.from('requirement_components').select('*')
        .eq('requirement_profile_id', profileRow?.requirement_profile_id ?? -1)
        .eq('code', body.component_code).maybeSingle();
      if (compErr) throw new HttpError(500, compErr.message);
      if (!component || !['manual', 'manual_plus_individual_encounters'].includes(component.calculation_mode)) throw new HttpError(400, 'Choose a valid activity category');
      componentCode = component.code; category = component.name;
    }
    const note = body.note == null ? row.note : limited(body.note, 1000, 'Note');
    const updated = unwrap(await admin.from('hours').update({
      work_date: workDate, hours: value, component_code: componentCode, category, note,
      site: body.site == null ? row.site : limited(body.site, 120, 'Facility', true),
      service_type: body.service_type == null ? row.service_type : activityServiceType(body.service_type)
    }).eq('id', hoursId).select().single());
    await audit(ctx, env, 'correct', 'hours', hoursId, { before: row, after: updated }, row.intern_profile_id, reason);
    return updated;
  }
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') {
    const entryRows = unwrap(await admin.rpc('hours_entries_with_component', { p_intern_id: id }));
    let entries = (entryRows || []).map(r => r.entry);
    // Prompt 8: "add edit/correction history" for the Activity log itself
    // (Prompt 4 already built the correction workflow and audit trail;
    // Prompt 7 surfaced it on Reports — this is the same audit_log data
    // shown directly against each entry here).
    const entryIds = entries.map(e => String(e.id));
    if (entryIds.length) {
      const { data: historyRows, error: histErr } = await admin.from('audit_log').select('entity_id, reason, created_at, detail')
        .eq('entity_type', 'hours').eq('action', 'correct').in('entity_id', entryIds).order('created_at', { ascending: false });
      if (histErr) throw new HttpError(500, histErr.message);
      const historyByEntryId = {};
      for (const h of (historyRows || [])) {
        const detail = h.detail ? JSON.parse(h.detail) : null;
        (historyByEntryId[h.entity_id] ||= []).push({ created_at: h.created_at, reason: h.reason, before: detail?.before, after: detail?.after });
      }
      entries = entries.map(e => ({ ...e, correction_history: historyByEntryId[String(e.id)] || [] }));
    }
    const { data: profileRow, error: profErr } = await admin.from('profiles').select('requirement_profile_id').eq('id', id).maybeSingle();
    if (profErr) throw new HttpError(500, profErr.message);
    const components = unwrap(await admin.from('requirement_components').select('*')
      .eq('requirement_profile_id', profileRow?.requirement_profile_id ?? -1)
      .in('calculation_mode', ['manual', 'manual_plus_individual_encounters'])
      .order('sort_order'));
    return { entries, components };
  }
  requireMethod(method, ['POST']);
  const value = num(body.hours);
  if (!(value > 0 && value <= 24)) throw new HttpError(400, 'Hours must be greater than 0 and no more than 24');
  const { data: profileRow2, error: profErr2 } = await admin.from('profiles').select('requirement_profile_id').eq('id', id).maybeSingle();
  if (profErr2) throw new HttpError(500, profErr2.message);
  const { data: component, error: compErr } = await admin.from('requirement_components').select('*')
    .eq('requirement_profile_id', profileRow2?.requirement_profile_id ?? -1)
    .eq('code', body.component_code)
    .maybeSingle();
  if (compErr) throw new HttpError(500, compErr.message);
  if (!component || !['manual', 'manual_plus_individual_encounters'].includes(component.calculation_mode)) throw new HttpError(400, 'Choose a valid activity category');
  const row = unwrap(await admin.from('hours').insert({
    intern_profile_id: id,
    work_date: dateValue(body.work_date, 'Work date'),
    category: component.name,
    component_code: component.code,
    hours: value,
    site: limited(body.site, 120, 'Facility', true),
    service_type: activityServiceType(body.service_type),
    note: limited(body.note, 1000, 'Note'),
    created_by_identity_user_id: ctx.user.id
  }).select().single());
  await audit(ctx, env, 'create', 'hours', row.id, { component_code: component.code, hours: value }, id);
  return row;
}

// §4 gap fix: a combined, cross-intern activity feed for programme_lead /
// supervisor, instead of only being able to see one intern's log at a time
// via the intern switcher.
export async function hoursFeed(ctx, env) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const admin = getAdmin(env);
  const rows = unwrap(await admin.rpc('hours_feed', { p_supervisor_id: ctx.role === 'supervisor' ? ctx.user.id : null }));
  return (rows || []).map(r => r.entry);
}

export async function supervision(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const supId = Number(url.searchParams.get('id') || body.id || 0);
    if (!supId) throw new HttpError(400, 'Supervision item id is required');
    const { data: row, error } = await admin.from('supervision_items').select('*').eq('id', supId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Supervision item not found');
    const reason = limited(body.reason, 500, 'Reason');
    const auditId = await audit(ctx, env, 'delete', 'supervision', supId, { ...row }, row.intern_profile_id, reason);
    const { error: delErr } = await admin.from('supervision_items').delete().eq('id', supId);
    if (delErr) throw new HttpError(500, delErr.message);
    return { ok: true, deleted_id: supId, audit_id: auditId };
  }
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  if (method === 'PATCH') {
    requireRole(ctx, ['programme_lead', 'supervisor']);
    const { data: row, error } = await admin.from('supervision_items').select('*').eq('id', Number(body.id)).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Supervision item not found');
    await assertInternAccess(ctx, row.intern_profile_id, env);
    const status = body.status || row.status;
    if (!SUPERVISION_STATUSES.has(status)) throw new HttpError(400, 'Invalid supervision status');
    const note = body.supervisor_note == null ? row.supervisor_note : limited(body.supervisor_note, 3000, 'Supervisor response');
    const dueDate = body.due_date === undefined ? row.due_date : (body.due_date ? dateValue(body.due_date, 'Due date') : null);
    const updated = unwrap(await admin.from('supervision_items').update({
      supervisor_note: note, status, due_date: dueDate, updated_at: new Date().toISOString()
    }).eq('id', row.id).select().single());
    await audit(ctx, env, 'review', 'supervision', row.id, { status }, row.intern_profile_id);
    return updated;
  }
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') {
    const rows = unwrap(await admin.from('supervision_items').select('*, cases(case_code)').eq('intern_profile_id', id).order('created_at', { ascending: false }));
    let mapped = rows.map(r => { const { cases: c, ...rest } = r; return { ...rest, case_code: c?.case_code ?? null }; });
    // Prompt 8: "assigned supervisor" — resolved from profiles by identity
    // user id (no direct FK PostgREST could embed automatically, since
    // assigned_supervisor_identity_user_id references auth.users, not
    // profiles) rather than a second round trip per row.
    const supervisorIds = [...new Set(mapped.map(r => r.assigned_supervisor_identity_user_id).filter(Boolean))];
    if (supervisorIds.length) {
      const { data: supervisorProfiles, error: spErr } = await admin.from('profiles').select('identity_user_id, display_name').in('identity_user_id', supervisorIds);
      if (spErr) throw new HttpError(500, spErr.message);
      const nameById = Object.fromEntries((supervisorProfiles || []).map(p => [p.identity_user_id, p.display_name]));
      mapped = mapped.map(r => ({ ...r, assigned_supervisor_name: r.assigned_supervisor_identity_user_id ? (nameById[r.assigned_supervisor_identity_user_id] || null) : null }));
    } else {
      mapped = mapped.map(r => ({ ...r, assigned_supervisor_name: null }));
    }
    // Old SQL: ORDER BY CASE WHEN status = 'Open' THEN 0 ELSE 1 END, created_at DESC.
    // Array#sort is stable, so sorting the already created_at-desc-ordered
    // rows by "Open first" reproduces the same ordering.
    mapped.sort((a, b) => (a.status === 'Open' ? 0 : 1) - (b.status === 'Open' ? 0 : 1));
    return mapped;
  }
  requireMethod(method, ['POST']);
  const priority = body.priority || 'Routine';
  if (!SUPERVISION_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid supervision priority');
  const caseId = body.case_id ? Number(body.case_id) : null;
  if (caseId) {
    const { data: linkedCase, error: linkErr } = await admin.from('cases').select('id').eq('id', caseId).eq('intern_profile_id', id).maybeSingle();
    if (linkErr) throw new HttpError(500, linkErr.message);
    if (!linkedCase) throw new HttpError(400, 'Case does not belong to this intern');
  }
  const dueDate = body.due_date ? dateValue(body.due_date, 'Due date') : null;
  // Prompt 8: "assigned supervisor" defaults to whoever the intern is
  // already assigned to placement-wide — this surfaces who owns the item
  // without needing a separate reassignment step for the common case.
  const { data: internProfile, error: internErr } = await admin.from('profiles').select('supervisor_identity_user_id').eq('id', id).maybeSingle();
  if (internErr) throw new HttpError(500, internErr.message);
  const row = unwrap(await admin.from('supervision_items').insert({
    intern_profile_id: id,
    case_id: caseId,
    topic: limited(body.topic, 200, 'Topic', true),
    question: limited(body.question, 3000, 'Question', true),
    priority,
    due_date: dueDate,
    assigned_supervisor_identity_user_id: internProfile?.supervisor_identity_user_id || null,
    action_taken: limited(body.action_taken, 3000, 'Action taken'),
    created_by_identity_user_id: ctx.user.id
  }).select().single());
  await audit(ctx, env, 'create', 'supervision', row.id, { priority: row.priority }, id);
  return row;
}

// §4 gap fix: a combined, cross-intern open-supervision feed for
// programme_lead / supervisor.
export async function supervisionFeed(ctx, env) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const admin = getAdmin(env);
  const rows = unwrap(await admin.rpc('supervision_feed', { p_supervisor_id: ctx.role === 'supervisor' ? ctx.user.id : null }));
  return (rows || []).map(r => r.item);
}

export async function competencies(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') {
    const rows = unwrap(await admin.from('competency_definitions')
      .select('*, competency_progress(id, intern_rating, supervisor_rating, evidence, supervisor_comment, intern_profile_id)')
      .order('sort_order'));
    // Prompt 8: "add evidence history, rating history and supervisor
    // attribution" — reuses the audit trail every update already writes
    // (see the audit() call below) rather than a second history table,
    // same pattern as Reports' review_history and hours' corrections.
    const progressIds = rows.map(d => (d.competency_progress || []).find(x => x.intern_profile_id === id)?.id).filter(Boolean).map(String);
    const historyByProgressId = {};
    if (progressIds.length) {
      const { data: historyRows, error: histErr } = await admin.from('audit_log').select('entity_id, detail, created_at')
        .eq('entity_type', 'competency_progress').in('entity_id', progressIds).order('created_at', { ascending: false });
      if (histErr) throw new HttpError(500, histErr.message);
      for (const h of (historyRows || [])) {
        const detail = h.detail ? JSON.parse(h.detail) : {};
        (historyByProgressId[h.entity_id] ||= []).push({ created_at: h.created_at, ...detail });
      }
    }
    return rows.map(d => {
      const { competency_progress, ...rest } = d;
      const p = (competency_progress || []).find(x => x.intern_profile_id === id);
      return {
        ...rest,
        intern_rating: p?.intern_rating ?? null,
        supervisor_rating: p?.supervisor_rating ?? null,
        evidence: p?.evidence ?? null,
        supervisor_comment: p?.supervisor_comment ?? null,
        history: p?.id ? (historyByProgressId[String(p.id)] || []) : []
      };
    });
  }
  requireMethod(method, ['POST']);
  const { data: definition, error: defErr } = await admin.from('competency_definitions').select('id').eq('id', Number(body.competency_id)).maybeSingle();
  if (defErr) throw new HttpError(500, defErr.message);
  if (!definition) throw new HttpError(400, 'Competency not found');
  const { data: old, error: oldErr } = await admin.from('competency_progress').select('*')
    .eq('intern_profile_id', id).eq('competency_id', body.competency_id).maybeSingle();
  if (oldErr) throw new HttpError(500, oldErr.message);
  const oldRow = old || {};
  const internRating = ctx.role === 'intern' ? (body.intern_rating ?? oldRow.intern_rating) : oldRow.intern_rating;
  const supervisorRating = ctx.role === 'intern' ? oldRow.supervisor_rating : (body.supervisor_rating ?? oldRow.supervisor_rating);
  const evidence = ctx.role === 'intern' ? (body.evidence ?? oldRow.evidence) : oldRow.evidence;
  const comment = ctx.role === 'intern' ? oldRow.supervisor_comment : (body.supervisor_comment ?? oldRow.supervisor_comment);
  for (const rating of [internRating, supervisorRating]) if (rating != null && (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)) throw new HttpError(400, 'Ratings must be between 1 and 5');
  const limitedEvidence = limited(evidence, 3000, 'Evidence');
  const limitedComment = limited(comment, 3000, 'Supervisor comment');
  const row = unwrap(await admin.from('competency_progress').upsert({
    intern_profile_id: id,
    competency_id: body.competency_id,
    intern_rating: internRating,
    supervisor_rating: supervisorRating,
    evidence: limitedEvidence,
    supervisor_comment: limitedComment,
    updated_by_identity_user_id: ctx.user.id,
    updated_at: new Date().toISOString()
  }, { onConflict: 'intern_profile_id,competency_id' }).select().single());
  await audit(ctx, env, 'update', 'competency_progress', row.id, {
    intern_rating: internRating, supervisor_rating: supervisorRating,
    evidence: limitedEvidence, supervisor_comment: limitedComment,
    actor_role: ctx.role, actor_name: ctx.profile.display_name || ctx.profile.email
  }, id);
  return row;
}

async function rangeRequirementHours(env, id, start, end) {
  const admin = getAdmin(env);
  return unwrap(await admin.rpc('range_requirement_hours', { p_intern_id: id, p_start: start, p_end: end }));
}

// Prompt 7: "separation of verified, pending and corrected figures." Hours
// logged this period that were later corrected (functions/api/_handlers.js
// hoursView() PATCH, audited as action='correct') are flagged here so the
// report can show which figures were touched after the fact, instead of
// presenting a corrected number as if it had always read that way.
async function correctedHoursThisPeriod(admin, id, start, end) {
  const { data: periodHours, error: hoursErr } = await admin.from('hours').select('id').eq('intern_profile_id', id).gte('work_date', start).lt('work_date', end);
  if (hoursErr) throw new HttpError(500, hoursErr.message);
  const ids = (periodHours || []).map(r => String(r.id));
  if (!ids.length) return [];
  const { data: corrections, error: corrErr } = await admin.from('audit_log').select('entity_id, reason, created_at')
    .eq('entity_type', 'hours').eq('action', 'correct').in('entity_id', ids).order('created_at', { ascending: false });
  if (corrErr) throw new HttpError(500, corrErr.message);
  return corrections || [];
}

export async function reports(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  const month = (url.searchParams.get('month') || body.month || `${new Date().toISOString().slice(0, 7)}-01`).slice(0, 7) + '-01';
  const end = monthEnd(month);
  if (method === 'GET') {
    const [reportRes, statsRes, activity, corrections, trendRes, breakdownRes] = await Promise.all([
      admin.from('monthly_reports').select('*').eq('intern_profile_id', id).eq('month', month).maybeSingle(),
      admin.rpc('report_encounter_stats', { p_intern_id: id, p_start: month, p_end: end }),
      rangeRequirementHours(env, id, month, end),
      correctedHoursThisPeriod(admin, id, month, end),
      admin.rpc('report_trend_stats', { p_intern_id: id, p_months: 6 }),
      admin.rpc('report_activity_breakdown', { p_intern_id: id, p_start: month, p_end: end })
    ]);
    if (reportRes.error) throw new HttpError(500, reportRes.error.message);
    if (statsRes.error) throw new HttpError(500, statsRes.error.message);
    if (trendRes.error) throw new HttpError(500, trendRes.error.message);
    if (breakdownRes.error) throw new HttpError(500, breakdownRes.error.message);
    const report = reportRes.data || { status: 'Draft' };
    // Review history comes straight from the audit trail (Prompt 4), not a
    // separate log — every "review"/"submit" action against this exact
    // report id, oldest first. A report with no id yet (never saved) has no
    // history rows to find, so this is skipped rather than queried for -1.
    let reviewHistory = [];
    if (report.id) {
      const { data: historyRows, error: historyErr } = await admin.from('audit_log').select('action, reason, created_at, detail')
        .eq('entity_type', 'monthly_report').eq('entity_id', String(report.id)).order('created_at', { ascending: true });
      if (historyErr) throw new HttpError(500, historyErr.message);
      reviewHistory = historyRows || [];
    }
    return {
      report, hours: activity, stats: statsRes.data, activity_breakdown: breakdownRes.data || [],
      corrections,
      trend: trendRes.data || [],
      review_history: reviewHistory,
      refreshed_at: new Date().toISOString()
    };
  }
  requireMethod(method, ['POST']);
  const status = ctx.role === 'intern' ? 'Submitted' : 'Reviewed';
  const internComment = limited(body.intern_comment, 5000, 'Intern comment');
  const supervisorComment = limited(body.supervisor_comment, 5000, 'Supervisor comment');
  // Reviewer identity is taken from the authenticated session, never from
  // client-supplied input, so "reviewed by" on a report can't be spoofed.
  const reviewedByName = status === 'Reviewed' ? (ctx.profile.display_name || ctx.profile.email || null) : null;
  // Prompt 4: "makes the resulting state unambiguous" — find out up front
  // whether this is a first review or a re-click/second reviewer, since
  // upsert_monthly_report (0007) now only sets reviewed_at/reviewed_by_name
  // once. already_reviewed lets the client say "already reviewed by X —
  // comment updated" instead of implying the review was just re-stamped.
  const { data: existing, error: existingErr } = await admin.from('monthly_reports').select('status').eq('intern_profile_id', id).eq('month', month).maybeSingle();
  if (existingErr) throw new HttpError(500, existingErr.message);
  const alreadyReviewed = status === 'Reviewed' && existing?.status === 'Reviewed';
  const row = unwrap(await admin.rpc('upsert_monthly_report', {
    p_intern_id: id,
    p_month: month,
    p_status: status,
    p_intern_comment: internComment,
    p_supervisor_comment: supervisorComment,
    p_reviewed_by_name: reviewedByName
  }));
  await audit(ctx, env, status === 'Reviewed' ? 'review' : 'submit', 'monthly_report', row.id, { month, status, already_reviewed: alreadyReviewed }, id);
  return { ...row, already_reviewed: alreadyReviewed };
}

export async function referrals(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const refId = Number(url.searchParams.get('id') || body.id || 0);
    if (!refId) throw new HttpError(400, 'Referral id is required');
    const { data: row, error } = await admin.from('referrals').select('*').eq('id', refId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Referral not found');
    const reason = limited(body.reason, 500, 'Reason');
    const auditId = await audit(ctx, env, 'delete', 'referral', refId, { ...row }, row.intern_profile_id, reason);
    const { error: delErr } = await admin.from('referrals').delete().eq('id', refId);
    if (delErr) throw new HttpError(500, delErr.message);
    return { ok: true, deleted_id: refId, audit_id: auditId };
  }
  const requestedId = Number(url.searchParams.get('intern_id') || body.intern_profile_id || 0);
  const id = ctx.role === 'intern' ? ctx.profile.id : requestedId;
  if (method === 'GET') {
    if (id) {
      await assertInternAccess(ctx, id, env);
      const rows = unwrap(await admin.from('referrals').select('*, profiles(display_name)').eq('intern_profile_id', id).order('created_at', { ascending: false }));
      return sortReferrals(withInternName(rows));
    }
    requireRole(ctx, ['programme_lead', 'supervisor']);
    let q = admin.from('referrals')
      .select(ctx.role === 'supervisor' ? '*, profiles!inner(display_name, supervisor_identity_user_id)' : '*, profiles(display_name)')
      .order('created_at', { ascending: false });
    if (ctx.role === 'supervisor') q = q.eq('profiles.supervisor_identity_user_id', ctx.user.id);
    const rows = unwrap(await q);
    return sortReferrals(withInternName(rows));
  }
  requireMethod(method, ['POST', 'PATCH']);
  if (method === 'PATCH' && body.action === 'accept') {
    if (ctx.role !== 'intern') throw new HttpError(403, 'Only the allocated intern can accept a referral');
    const refId = Number(body.id || 0);
    const { data: current, error } = await admin.from('referrals').select('*').eq('id', refId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!current) throw new HttpError(404, 'Referral not found');
    if (current.intern_profile_id !== ctx.profile.id) throw new HttpError(403, 'This referral is not allocated to you');
    if (current.accepted_at) return current;
    const row = unwrap(await admin.from('referrals').update({
      accepted_at: new Date().toISOString(),
      accepted_by_identity_user_id: ctx.user.id,
      updated_by_identity_user_id: ctx.user.id,
      updated_at: new Date().toISOString()
    }).eq('id', refId).select().single());
    await audit(ctx, env, 'accept', 'referral', refId, { accepted_at: row.accepted_at }, current.intern_profile_id);
    return row;
  }
  if (method === 'POST') {
    await assertInternAccess(ctx, id, env);
    const status = body.status || 'Allocated';
    const priority = body.priority || 'Routine';
    if (!REFERRAL_STATUSES.has(status) || !REFERRAL_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid referral status or priority');
    const attempts = Math.max(0, Math.min(100, Number(body.contact_attempts || 0)));
    const selfAllocated = ctx.role === 'intern' && id === ctx.profile.id;
    const row = unwrap(await admin.from('referrals').insert({
      intern_profile_id: id,
      referral_code: limited(body.referral_code, 50, 'Referral code', true)?.toUpperCase(),
      referral_date: dateValue(body.referral_date, 'Referral date'),
      referral_source: limited(body.referral_source, 100, 'Referral source'),
      site: limited(body.site, 120, 'Site'),
      presenting_category: limited(body.presenting_category, 120, 'Presenting category'),
      priority,
      status,
      contact_attempts: attempts,
      next_action_date: body.next_action_date ? dateValue(body.next_action_date, 'Next action date') : null,
      last_update: limited(body.last_update, 1000, 'Operational update'),
      update_category: limited(body.update_category, 60, 'Operational update category'),
      accepted_at: selfAllocated ? new Date().toISOString() : null,
      accepted_by_identity_user_id: selfAllocated ? ctx.user.id : null,
      created_by_identity_user_id: ctx.user.id,
      updated_by_identity_user_id: ctx.user.id
    }).select().single());
    await audit(ctx, env, 'create', 'referral', row.id, { status, self_allocated: selfAllocated }, id);
    return row;
  }
  const { data: current, error: curErr } = await admin.from('referrals').select('*').eq('id', Number(body.id)).maybeSingle();
  if (curErr) throw new HttpError(500, curErr.message);
  if (!current) throw new HttpError(404, 'Referral not found');
  await assertInternAccess(ctx, current.intern_profile_id, env);
  const status = body.status || current.status;
  const priority = body.priority || current.priority;
  if (!REFERRAL_STATUSES.has(status) || !REFERRAL_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid referral status or priority');
  const attempts = body.contact_attempts == null ? current.contact_attempts : Number(body.contact_attempts);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 100) throw new HttpError(400, 'Invalid contact attempts');
  const nextActionDate = body.next_action_date ? dateValue(body.next_action_date, 'Next action date') : null;
  const lastUpdate = limited(body.last_update, 1000, 'Operational update');
  const updateCategory = body.update_category == null ? current.update_category : limited(body.update_category, 60, 'Operational update category');
  // Keep referral edits on the same direct PostgREST path used by creation
  // and acceptance. The previous RPC depended on the deployed database
  // having the latest overloaded update_referral signature; when that
  // signature drifted, the UI looked as though it saved but no edit reached
  // the row. A direct update removes that migration-order dependency.
  const closedAt = status.startsWith('Closed') ? (current.closed_at || new Date().toISOString()) : null;
  const row = unwrap(await admin.from('referrals').update({
    priority,
    status,
    contact_attempts: attempts,
    next_action_date: nextActionDate,
    last_update: lastUpdate,
    update_category: updateCategory,
    updated_by_identity_user_id: ctx.user.id,
    updated_at: new Date().toISOString(),
    closed_at: closedAt
  }).eq('id', current.id).select().single());
  await audit(ctx, env, 'update', 'referral', row.id, { status }, current.intern_profile_id);
  return row;
}

export async function pilotContext(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const itemId = Number(url.searchParams.get('id') || body.id || 0);
    if (!itemId) throw new HttpError(400, 'Schedule item id is required');
    const { data: row, error } = await admin.from('weekly_schedule_items').select('*').eq('id', itemId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Schedule item not found');
    const { error: delErr } = await admin.from('weekly_schedule_items').update({ active: false }).eq('id', itemId);
    if (delErr) throw new HttpError(500, delErr.message);
    await audit(ctx, env, 'delete', 'weekly_schedule_items', itemId, { title: row.title }, row.intern_profile_id);
    return { ok: true, deleted_id: itemId };
  }
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'POST') {
    requireRole(ctx, ['programme_lead']);
    const weekday = Number(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new HttpError(400, 'Weekday is required');
    const title = String(body.title || '').trim();
    if (!title) throw new HttpError(400, 'Title is required');
    const row = unwrap(await admin.from('weekly_schedule_items').insert({
      intern_profile_id: id,
      weekday,
      title,
      start_time: body.start_time || null,
      end_time: body.end_time || null,
      site: body.site || null,
      recurrence_note: body.recurrence_note || null,
      activity_type: body.activity_type || null,
      active: true
    }).select().single());
    await audit(ctx, env, 'create', 'weekly_schedule_items', row.id, { title, site: row.site }, id);
    return row;
  }
  const [scheduleRes, plannedRes] = await Promise.all([
    admin.from('weekly_schedule_items').select('*').eq('intern_profile_id', id).eq('active', true)
      .order('weekday', { ascending: true }).order('start_time', { ascending: true, nullsFirst: false }),
    admin.from('planned_activities').select('*').eq('intern_profile_id', id).neq('status', 'Cancelled')
      .order('activity_date', { ascending: true, nullsFirst: false }).order('id', { ascending: true })
  ]);
  if (scheduleRes.error) throw new HttpError(500, scheduleRes.error.message);
  if (plannedRes.error) throw new HttpError(500, plannedRes.error.message);
  return { schedule: scheduleRes.data, planned: plannedRes.data };
}

export async function feedback(ctx, env, url, body, method) {
  const admin = getAdmin(env);
  if (method === 'DELETE') {
    requireRole(ctx, ['programme_lead']);
    const fbId = Number(url.searchParams.get('id') || body.id || 0);
    if (!fbId) throw new HttpError(400, 'Feedback id is required');
    const { data: row, error } = await admin.from('pilot_feedback').select('*').eq('id', fbId).maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!row) throw new HttpError(404, 'Feedback not found');
    const reason = limited(body.reason, 500, 'Reason');
    const auditId = await audit(ctx, env, 'delete', 'pilot_feedback', fbId, { ...row }, row.intern_profile_id, reason);
    const { error: delErr } = await admin.from('pilot_feedback').delete().eq('id', fbId);
    if (delErr) throw new HttpError(500, delErr.message);
    return { ok: true, deleted_id: fbId, audit_id: auditId };
  }
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return unwrap(await admin.from('pilot_feedback').select('*').eq('intern_profile_id', id).order('created_at', { ascending: false }).limit(200));
  if (method === 'POST') {
    const message = String(body.message || '').trim();
    if (!message) throw new HttpError(400, 'Feedback is required');
    const rating = body.rating ? Math.max(1, Math.min(5, Number(body.rating))) : null;
    const row = unwrap(await admin.from('pilot_feedback').insert({
      intern_profile_id: id,
      feedback_type: body.feedback_type || 'General',
      rating,
      message,
      context_view: body.context_view || null
    }).select().single());
    await audit(ctx, env, 'create', 'pilot_feedback', row.id, { type: row.feedback_type }, id);
    return row;
  }
  throw new HttpError(405, 'Method not allowed');
}

// Prompt 4: "an undo or soft-delete approach where practical." Referrals,
// supervision items and pilot feedback have no child rows that cascade away
// on delete (unlike cases→encounters), so their full pre-delete row is
// captured in the audit_log entry above and can be re-inserted verbatim
// here — a genuine undo, not just a soft-delete flag. Intern removal uses
// its own reactivate PATCH above (soft-delete via profiles.active); case/
// hours/encounter deletes are not restorable this way (case deletion
// cascades away encounters; hours/encounters keep only a snapshot for audit
// context, since restoring them post-hoc into pace/hour totals a supervisor
// may have already acted on would be more confusing than helpful).
const RESTORABLE_TABLES = { referral: 'referrals', supervision: 'supervision_items', pilot_feedback: 'pilot_feedback' };

export async function restoreAudit(ctx, env, url, body, method) {
  requireMethod(method, ['POST']);
  requireRole(ctx, ['programme_lead']);
  const admin = getAdmin(env);
  const auditId = Number(body.audit_id || 0);
  if (!auditId) throw new HttpError(400, 'audit_id is required');
  const { data: logRow, error } = await admin.from('audit_log').select('*').eq('id', auditId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!logRow) throw new HttpError(404, 'Audit record not found');
  if (logRow.action !== 'delete') throw new HttpError(400, 'Only a deletion can be restored');
  if (logRow.restored_at) throw new HttpError(409, 'This record has already been restored');
  const table = RESTORABLE_TABLES[logRow.entity_type];
  if (!table) throw new HttpError(400, 'This record type cannot be restored');
  const snapshot = logRow.detail ? JSON.parse(logRow.detail) : null;
  if (!snapshot || snapshot.id == null) throw new HttpError(400, 'No restorable snapshot was recorded for this deletion');
  const { id: _oldId, ...fields } = snapshot;
  const restored = unwrap(await admin.from(table).insert(fields).select().single());
  const { error: markErr } = await admin.from('audit_log').update({ restored_at: new Date().toISOString() }).eq('id', auditId);
  if (markErr) throw new HttpError(500, markErr.message);
  await audit(ctx, env, 'restore', logRow.entity_type, restored.id, { restored_from_audit_id: auditId }, logRow.profile_id);
  return restored;
}

export async function programme(ctx, env) {
  requireRole(ctx, ['programme_lead', 'management']);
  const admin = getAdmin(env);
  const metrics = unwrap(await admin.rpc('programme_metrics'));
  const internIds = metrics.intern_ids || [];
  const progress = await Promise.all(internIds.map(iid => requirementProgress(env, iid)));
  const totalHours = progress.reduce((s, x) => s + num(x.summary.total_completed), 0);
  const atRisk = progress.filter(x => x.summary.at_risk_components > 0).length;
  const booked = num(metrics.encounters?.booked);
  const attended = num(metrics.encounters?.attended);
  return {
    metrics: {
      interns: internIds.length,
      cases: metrics.cases?.total ?? 0,
      active_cases: metrics.cases?.active ?? 0,
      hours: round(totalHours, 1),
      at_risk_interns: atRisk,
      open_supervision: metrics.open_supervision ?? 0,
      reviewed_reports: metrics.reviewed_reports ?? 0,
      booked, attended,
      attendance_rate: booked ? Math.round(attended / booked * 100) : null,
      median_days_to_intake: metrics.median_days_to_intake ?? null
    },
    sites: metrics.sites || [],
    institutions: metrics.institutions || [],
    refreshed_at: new Date().toISOString()
  };
}
