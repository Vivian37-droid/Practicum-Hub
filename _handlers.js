// View handlers — a near line-for-line port of the corresponding functions
// in the old netlify/functions/api.mjs (dashboard, interns, requirements,
// cases, encounters, hours, supervision, competencies, reports, referrals,
// pilotContext, feedback, programme), using postgres.js tagged-template
// queries against Supabase instead of node-postgres's pool.query($1,$2,...).
//
// Two additions beyond the old app, both called out in REBUILD_SPEC.md as
// things to build in this rebuild rather than defer again:
//   - interns(): POST now sends a real Supabase Auth invite email (§5).
//   - supervisionFeed() / hoursFeed(): cross-intern aggregate views for
//     programme_lead/supervisor (§4 gap — "no bird's-eye view").

import { getSql, getAdmin } from '../_shared/clients.js';
import { requireRole, assertInternAccess, audit, loadProfile, ensureRequirementProfile } from '../_shared/context.js';
import {
  HttpError, num, round, dateValue, limited, requireMethod, cleanEmail,
  monthEnd, CASE_STATUSES, SUPERVISION_STATUSES, SUPERVISION_PRIORITIES,
  SESSION_TYPES, GENDERS, REFERRAL_STATUSES, REFERRAL_PRIORITIES
} from '../_shared/util.js';

async function requirementProgress(env, id) {
  const sql = getSql(env);
  const profile = await loadProfile(env, id);
  const components = await sql`SELECT * FROM requirement_components WHERE requirement_profile_id = ${profile.requirement_profile_id} ORDER BY sort_order, name`;
  const manual = await sql`
    SELECT component_code, SUM(hours)::float total,
      SUM(hours) FILTER(WHERE work_date >= CURRENT_DATE - 27)::float recent_28d
    FROM hours WHERE intern_profile_id = ${id} AND component_code IS NOT NULL GROUP BY component_code`;
  const manualMap = Object.fromEntries(manual.map(x => [x.component_code, { total: num(x.total), recent: num(x.recent_28d) }]));
  const [encounter] = await sql`
    SELECT COALESCE(SUM(duration_minutes) FILTER(WHERE attended), 0)::float minutes,
      COUNT(*)::int booked, COUNT(*) FILTER(WHERE attended)::int attended,
      AVG(duration_minutes) FILTER(WHERE attended AND duration_minutes > 0)::float avg_minutes
    FROM encounters WHERE intern_profile_id = ${id}`;
  const [recentEncounter] = await sql`
    SELECT COALESCE(SUM(duration_minutes) FILTER(WHERE attended), 0)::float minutes
    FROM encounters WHERE intern_profile_id = ${id} AND encounter_date >= CURRENT_DATE - 27`;
  const [activeCases] = await sql`
    SELECT COUNT(*)::int n, COALESCE(SUM(1.0 / NULLIF(planned_frequency_weeks, 0)), 0)::float weekly_bookings
    FROM cases WHERE intern_profile_id = ${id} AND status IN ('Booked','Intake','Active','Exit review')`;
  const deliverables = await sql`SELECT component_id, status, note FROM deliverable_progress WHERE intern_profile_id = ${id}`;
  const deliverableMap = Object.fromEntries(deliverables.map(x => [x.component_id, x]));
  const opening = await sql`SELECT component_id, hours::float hours, note FROM requirement_opening_balances WHERE intern_profile_id = ${id}`;
  const openingMap = Object.fromEntries(opening.map(x => [x.component_id, x]));

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
  const estimatedClinicalTargetDate = estimatedClinicalWeeksToTarget == null ? null : new Date(now.getTime() + estimatedClinicalWeeksToTarget * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
  const sql = getSql(env);
  if (ctx.role === 'intern') {
    const [[cases], [supervision]] = await Promise.all([
      sql`SELECT COUNT(*)::int n FROM cases WHERE intern_profile_id = ${ctx.profile.id} AND status <> 'Exited'`,
      sql`SELECT COUNT(*)::int n FROM supervision_items WHERE intern_profile_id = ${ctx.profile.id} AND status = 'Open'`
    ]);
    const requirements = await requirementProgress(env, ctx.profile.id);
    return { profile: ctx.profile, requirements, metrics: { active_cases: cases.n, open_supervision: supervision.n } };
  }
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const supervisorFilter = ctx.role === 'supervisor' ? sql`AND supervisor_identity_user_id = ${ctx.user.id}` : sql``;
  let interns = await sql`
    SELECT p.*,
      COALESCE((SELECT COUNT(*) FROM cases x WHERE x.intern_profile_id = p.id AND x.status <> 'Exited'), 0)::int active_cases,
      COALESCE((SELECT COUNT(*) FROM supervision_items s WHERE s.intern_profile_id = p.id AND s.status = 'Open'), 0)::int open_supervision
    FROM profiles p WHERE role = 'intern' AND active = true ${supervisorFilter} ORDER BY display_name`;
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
  return { profile: ctx.profile, interns, metrics };
}

export async function interns(ctx, env, body, method) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const sql = getSql(env);
  if (method === 'GET') {
    const supervisorFilter = ctx.role === 'supervisor' ? sql`AND supervisor_identity_user_id = ${ctx.user.id}` : sql``;
    let rows = await sql`
      SELECT p.*,
        COALESCE((SELECT COUNT(*) FROM cases x WHERE x.intern_profile_id = p.id AND x.status <> 'Exited'), 0)::int active_cases,
        COALESCE((SELECT COUNT(*) FROM supervision_items s WHERE s.intern_profile_id = p.id AND s.status = 'Open'), 0)::int open_supervision
      FROM profiles p WHERE role = 'intern' ${supervisorFilter} ORDER BY active DESC, display_name`;
    rows = await Promise.all(rows.map(async p => ({ ...p, requirement_summary: (await requirementProgress(env, p.id)).summary })));
    return rows;
  }
  requireRole(ctx, ['programme_lead']);
  const email = cleanEmail(body.email);
  const name = String(body.display_name || '').trim();
  if (!email || !name) throw new HttpError(400, 'Name and email are required');
  const institution = body.institution || 'Other';
  const code = institution === 'SACAP' ? 'sacap-bpsych' : institution === 'Cornerstone Institute' ? 'cornerstone-bpsych' : 'generic-720';
  const [rp] = await sql`SELECT id, overall_programme_hours FROM requirement_profiles WHERE code = ${code}`;
  const wasExisting = !!(await sql`SELECT 1 FROM profiles WHERE email = ${email}`)[0];
  const [row] = await sql`
    INSERT INTO profiles(email, display_name, role, institution, placement_start, placement_end, required_hours, requirement_profile_id, supervisor_identity_user_id, default_session_minutes)
    VALUES (${email}, ${name}, 'intern', ${institution}, ${body.placement_start || null}, ${body.placement_end || null}, ${num(rp?.overall_programme_hours || 720)}, ${rp?.id || null}, ${ctx.user.id}, ${num(body.default_session_minutes || 60)})
    ON CONFLICT(email) DO UPDATE SET display_name = EXCLUDED.display_name, institution = EXCLUDED.institution,
      placement_start = EXCLUDED.placement_start, placement_end = EXCLUDED.placement_end, required_hours = EXCLUDED.required_hours,
      requirement_profile_id = EXCLUDED.requirement_profile_id, supervisor_identity_user_id = EXCLUDED.supervisor_identity_user_id,
      default_session_minutes = EXCLUDED.default_session_minutes, active = true
    RETURNING *`;
  await audit(ctx, env, 'create_or_update', 'intern', row.id, { institution }, row.id);

  // §5 fix: sending the invite is no longer a separate manual step in a
  // different vendor dashboard — creating the placement here sends it.
  let invite = { sent: false, reason: null };
  if (!wasExisting) {
    try {
      const admin = getAdmin(env);
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
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return requirementProgress(env, id);
  if (method === 'PATCH') {
    const [component] = await sql`
      SELECT c.* FROM requirement_components c JOIN profiles p ON p.requirement_profile_id = c.requirement_profile_id
      WHERE c.id = ${Number(body.component_id)} AND p.id = ${id}`;
    if (!component) throw new HttpError(400, 'Requirement component not found');
    if (body.action === 'opening_balance') {
      requireRole(ctx, ['programme_lead', 'supervisor']);
      const value = num(body.hours);
      if (value < 0 || value > 2000) throw new HttpError(400, 'Invalid opening balance');
      const [row] = await sql`
        INSERT INTO requirement_opening_balances(intern_profile_id, component_id, hours, note, updated_by_identity_user_id)
        VALUES (${id}, ${component.id}, ${value}, ${body.note || 'Opening balance from existing institutional logbook'}, ${ctx.user.id})
        ON CONFLICT(intern_profile_id, component_id) DO UPDATE SET hours = EXCLUDED.hours, note = EXCLUDED.note,
          updated_by_identity_user_id = EXCLUDED.updated_by_identity_user_id, updated_at = NOW()
        RETURNING *`;
      await audit(ctx, env, 'update', 'opening_balance', row.id, { component: component.code, hours: value }, id);
      return row;
    }
    if (component.calculation_mode !== 'deliverable') throw new HttpError(400, 'Deliverable not found');
    const status = ['Not started', 'In progress', 'Complete'].includes(body.status) ? body.status : 'Not started';
    const [row] = await sql`
      INSERT INTO deliverable_progress(intern_profile_id, component_id, status, note, updated_by_identity_user_id)
      VALUES (${id}, ${component.id}, ${status}, ${body.note || null}, ${ctx.user.id})
      ON CONFLICT(intern_profile_id, component_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note,
        updated_by_identity_user_id = EXCLUDED.updated_by_identity_user_id, updated_at = NOW()
      RETURNING *`;
    await audit(ctx, env, 'update', 'deliverable', row.id, { status }, id);
    return row;
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function cases(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  if (method === 'GET') {
    if (id) {
      await assertInternAccess(ctx, id, env);
      return sql`SELECT x.*, p.display_name intern_name FROM cases x JOIN profiles p ON p.id = x.intern_profile_id WHERE intern_profile_id = ${id} ORDER BY updated_at DESC`;
    }
    requireRole(ctx, ['programme_lead', 'supervisor']);
    if (ctx.role === 'supervisor') return sql`SELECT x.*, p.display_name intern_name FROM cases x JOIN profiles p ON p.id = x.intern_profile_id WHERE p.supervisor_identity_user_id = ${ctx.user.id} ORDER BY x.updated_at DESC`;
    return sql`SELECT x.*, p.display_name intern_name FROM cases x JOIN profiles p ON p.id = x.intern_profile_id ORDER BY x.updated_at DESC`;
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
    const [row] = await sql`
      INSERT INTO cases(case_code, intern_profile_id, site, presenting_category, status, planned_frequency_weeks, created_by_identity_user_id)
      VALUES (${caseCode}, ${id}, ${site}, ${category}, ${status}, ${frequency}, ${ctx.user.id}) RETURNING *`;
    await audit(ctx, env, 'create', 'case', row.id, null, id);
    return row;
  }
  if (method === 'PATCH') {
    const [row] = await sql`SELECT * FROM cases WHERE id = ${Number(body.id)}`;
    if (!row) throw new HttpError(404, 'Case not found');
    await assertInternAccess(ctx, row.intern_profile_id, env);
    const status = body.status || row.status;
    if (!CASE_STATUSES.has(status)) throw new HttpError(400, 'Invalid case status');
    const requestedFrequency = body.planned_frequency_weeks == null ? null : Number(body.planned_frequency_weeks);
    if (requestedFrequency != null && (ctx.role === 'intern' || !Number.isInteger(requestedFrequency) || requestedFrequency < 1 || requestedFrequency > 52)) throw new HttpError(403, 'Only a supervisor can change planned frequency');
    const supervisionStatus = limited(body.supervision_status, 60, 'Supervision status');
    const [updated] = await sql`
      UPDATE cases SET status = ${status}, supervision_status = COALESCE(${supervisionStatus}, supervision_status),
        planned_frequency_weeks = COALESCE(${requestedFrequency}, planned_frequency_weeks),
        first_contact_at = CASE WHEN ${status} IN ('Contact attempted','Booked','Intake','Active','Exit review','Exited') THEN COALESCE(first_contact_at, NOW()) ELSE first_contact_at END,
        booked_at = CASE WHEN ${status} IN ('Booked','Intake','Active','Exit review','Exited') THEN COALESCE(booked_at, NOW()) ELSE booked_at END,
        intake_at = CASE WHEN ${status} IN ('Intake','Active','Exit review','Exited') THEN COALESCE(intake_at, NOW()) ELSE intake_at END,
        exited_at = CASE WHEN ${status} = 'Exited' THEN COALESCE(exited_at, NOW()) ELSE exited_at END,
        updated_at = NOW()
      WHERE id = ${row.id} RETURNING *`;
    await audit(ctx, env, 'update', 'case', row.id, { status, planned_frequency_weeks: updated.planned_frequency_weeks }, row.intern_profile_id);
    return updated;
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function encounters(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return sql`SELECT e.*, x.case_code FROM encounters e JOIN cases x ON x.id = e.case_id WHERE e.intern_profile_id = ${id} ORDER BY encounter_date DESC, created_at DESC`;
  requireMethod(method, ['POST']);
  const [theCase] = await sql`SELECT * FROM cases WHERE id = ${Number(body.case_id)}`;
  if (!theCase || theCase.intern_profile_id !== id) throw new HttpError(400, 'Case does not belong to this intern');
  const booked = String(body.booked) !== 'false';
  const attended = String(body.attended) !== 'false';
  const profile = await loadProfile(env, id);
  const duration = attended ? Math.max(1, num(body.duration_minutes || profile.default_session_minutes || 60)) : 0;
  if (duration > 480) throw new HttpError(400, 'Duration cannot exceed 480 minutes');
  if (!SESSION_TYPES.has(body.session_type)) throw new HttpError(400, 'Invalid session type');
  const gender = body.patient_gender || 'Unknown';
  if (!GENDERS.has(gender)) throw new HttpError(400, 'Invalid gender value');
  const [row] = await sql`
    INSERT INTO encounters(case_id, intern_profile_id, encounter_date, booked, attended, session_type, patient_gender, site, duration_minutes, created_by_identity_user_id)
    VALUES (${theCase.id}, ${id}, ${dateValue(body.encounter_date, 'Encounter date')}, ${booked}, ${attended}, ${body.session_type}, ${gender}, ${theCase.site}, ${duration}, ${ctx.user.id})
    RETURNING *`;
  if (attended) {
    await sql`
      UPDATE cases SET sessions = (SELECT COUNT(*) FROM encounters WHERE case_id = ${theCase.id} AND attended = true),
        status = CASE WHEN status IN ('Allocated','Contact attempted','Booked','Intake') THEN 'Active' ELSE status END,
        updated_at = NOW()
      WHERE id = ${theCase.id}`;
  }
  await audit(ctx, env, 'create', 'encounter', row.id, { attended, duration_minutes: duration }, id);
  return row;
}

export async function hoursView(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') {
    const entries = await sql`
      SELECT h.*, c.name component_name, c.manual_label, c.calculation_mode
      FROM hours h LEFT JOIN requirement_components c ON c.code = h.component_code AND c.requirement_profile_id = (SELECT requirement_profile_id FROM profiles WHERE id = ${id})
      WHERE h.intern_profile_id = ${id} ORDER BY work_date DESC, h.created_at DESC LIMIT 300`;
    const components = await sql`
      SELECT c.* FROM requirement_components c JOIN profiles p ON p.requirement_profile_id = c.requirement_profile_id
      WHERE p.id = ${id} AND c.calculation_mode IN ('manual','manual_plus_individual_encounters') ORDER BY c.sort_order`;
    return { entries, components };
  }
  requireMethod(method, ['POST']);
  const value = num(body.hours);
  if (!(value > 0 && value <= 24)) throw new HttpError(400, 'Hours must be greater than 0 and no more than 24');
  const [component] = await sql`
    SELECT c.* FROM requirement_components c JOIN profiles p ON p.requirement_profile_id = c.requirement_profile_id
    WHERE p.id = ${id} AND c.code = ${body.component_code}`;
  if (!component || !['manual', 'manual_plus_individual_encounters'].includes(component.calculation_mode)) throw new HttpError(400, 'Choose a valid activity category');
  const [row] = await sql`
    INSERT INTO hours(intern_profile_id, work_date, category, component_code, hours, note, created_by_identity_user_id)
    VALUES (${id}, ${dateValue(body.work_date, 'Work date')}, ${component.name}, ${component.code}, ${value}, ${limited(body.note, 1000, 'Note')}, ${ctx.user.id})
    RETURNING *`;
  await audit(ctx, env, 'create', 'hours', row.id, { component_code: component.code, hours: value }, id);
  return row;
}

// §4 gap fix: a combined, cross-intern activity feed for programme_lead /
// supervisor, instead of only being able to see one intern's log at a time
// via the intern switcher.
export async function hoursFeed(ctx, env) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const sql = getSql(env);
  const supervisorFilter = ctx.role === 'supervisor' ? sql`AND p.supervisor_identity_user_id = ${ctx.user.id}` : sql``;
  return sql`
    SELECT h.*, p.display_name intern_name, c.name component_name, c.manual_label
    FROM hours h JOIN profiles p ON p.id = h.intern_profile_id
    LEFT JOIN requirement_components c ON c.code = h.component_code AND c.requirement_profile_id = p.requirement_profile_id
    WHERE p.role = 'intern' ${supervisorFilter}
    ORDER BY h.work_date DESC, h.created_at DESC LIMIT 300`;
}

export async function supervision(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  if (method === 'PATCH') {
    requireRole(ctx, ['programme_lead', 'supervisor']);
    const [row] = await sql`SELECT * FROM supervision_items WHERE id = ${Number(body.id)}`;
    if (!row) throw new HttpError(404, 'Supervision item not found');
    await assertInternAccess(ctx, row.intern_profile_id, env);
    const status = body.status || row.status;
    if (!SUPERVISION_STATUSES.has(status)) throw new HttpError(400, 'Invalid supervision status');
    const note = body.supervisor_note == null ? row.supervisor_note : limited(body.supervisor_note, 3000, 'Supervisor response');
    const [updated] = await sql`UPDATE supervision_items SET supervisor_note = ${note}, status = ${status}, updated_at = NOW() WHERE id = ${row.id} RETURNING *`;
    return updated;
  }
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return sql`
    SELECT s.*, x.case_code FROM supervision_items s LEFT JOIN cases x ON x.id = s.case_id
    WHERE s.intern_profile_id = ${id} ORDER BY CASE WHEN s.status = 'Open' THEN 0 ELSE 1 END, created_at DESC`;
  requireMethod(method, ['POST']);
  const priority = body.priority || 'Routine';
  if (!SUPERVISION_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid supervision priority');
  const caseId = body.case_id ? Number(body.case_id) : null;
  if (caseId) {
    const [linkedCase] = await sql`SELECT 1 FROM cases WHERE id = ${caseId} AND intern_profile_id = ${id}`;
    if (!linkedCase) throw new HttpError(400, 'Case does not belong to this intern');
  }
  const [row] = await sql`
    INSERT INTO supervision_items(intern_profile_id, case_id, topic, question, priority, action_taken, created_by_identity_user_id)
    VALUES (${id}, ${caseId}, ${limited(body.topic, 200, 'Topic', true)}, ${limited(body.question, 3000, 'Question', true)}, ${priority}, ${limited(body.action_taken, 3000, 'Action taken')}, ${ctx.user.id})
    RETURNING *`;
  await audit(ctx, env, 'create', 'supervision', row.id, { priority: row.priority }, id);
  return row;
}

// §4 gap fix: a combined, cross-intern open-supervision feed for
// programme_lead / supervisor.
export async function supervisionFeed(ctx, env) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const sql = getSql(env);
  const supervisorFilter = ctx.role === 'supervisor' ? sql`AND p.supervisor_identity_user_id = ${ctx.user.id}` : sql``;
  return sql`
    SELECT s.*, x.case_code, p.display_name intern_name
    FROM supervision_items s JOIN profiles p ON p.id = s.intern_profile_id LEFT JOIN cases x ON x.id = s.case_id
    WHERE p.role = 'intern' ${supervisorFilter}
    ORDER BY CASE WHEN s.status = 'Open' THEN 0 ELSE 1 END, s.created_at DESC LIMIT 300`;
}

export async function competencies(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return sql`
    SELECT d.*, p.intern_rating, p.supervisor_rating, p.evidence, p.supervisor_comment
    FROM competency_definitions d LEFT JOIN competency_progress p ON p.competency_id = d.id AND p.intern_profile_id = ${id}
    ORDER BY sort_order`;
  requireMethod(method, ['POST']);
  const [definition] = await sql`SELECT 1 FROM competency_definitions WHERE id = ${Number(body.competency_id)}`;
  if (!definition) throw new HttpError(400, 'Competency not found');
  const [old = {}] = await sql`SELECT * FROM competency_progress WHERE intern_profile_id = ${id} AND competency_id = ${body.competency_id}`;
  const internRating = ctx.role === 'intern' ? (body.intern_rating ?? old.intern_rating) : old.intern_rating;
  const supervisorRating = ctx.role === 'intern' ? old.supervisor_rating : (body.supervisor_rating ?? old.supervisor_rating);
  const evidence = ctx.role === 'intern' ? (body.evidence ?? old.evidence) : old.evidence;
  const comment = ctx.role === 'intern' ? old.supervisor_comment : (body.supervisor_comment ?? old.supervisor_comment);
  for (const rating of [internRating, supervisorRating]) if (rating != null && (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)) throw new HttpError(400, 'Ratings must be between 1 and 5');
  const [row] = await sql`
    INSERT INTO competency_progress(intern_profile_id, competency_id, intern_rating, supervisor_rating, evidence, supervisor_comment, updated_by_identity_user_id)
    VALUES (${id}, ${body.competency_id}, ${internRating}, ${supervisorRating}, ${limited(evidence, 3000, 'Evidence')}, ${limited(comment, 3000, 'Supervisor comment')}, ${ctx.user.id})
    ON CONFLICT(intern_profile_id, competency_id) DO UPDATE SET intern_rating = EXCLUDED.intern_rating,
      supervisor_rating = EXCLUDED.supervisor_rating, evidence = EXCLUDED.evidence, supervisor_comment = EXCLUDED.supervisor_comment,
      updated_by_identity_user_id = EXCLUDED.updated_by_identity_user_id, updated_at = NOW()
    RETURNING *`;
  return row;
}

async function rangeRequirementHours(env, id, start, end) {
  const sql = getSql(env);
  const profile = await loadProfile(env, id);
  const components = await sql`SELECT * FROM requirement_components WHERE requirement_profile_id = ${profile.requirement_profile_id} ORDER BY sort_order`;
  const manual = await sql`SELECT component_code, SUM(hours)::float total FROM hours WHERE intern_profile_id = ${id} AND work_date >= ${start} AND work_date < ${end} GROUP BY component_code`;
  const manualMap = Object.fromEntries(manual.map(x => [x.component_code, num(x.total)]));
  const [encounterRow] = await sql`SELECT COALESCE(SUM(duration_minutes) FILTER(WHERE attended), 0)::float minutes FROM encounters WHERE intern_profile_id = ${id} AND encounter_date >= ${start} AND encounter_date < ${end}`;
  const encounterHours = num(encounterRow.minutes) / 60;
  return components.filter(c => c.target_hours != null).map(c => {
    let value = num(manualMap[c.code]);
    if (c.calculation_mode === 'individual_encounters') value = encounterHours;
    if (c.calculation_mode === 'manual_plus_individual_encounters') value += encounterHours;
    return { code: c.code, name: c.name, total: round(value, 1) };
  }).filter(x => x.total > 0);
}

export async function reports(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  const month = (url.searchParams.get('month') || body.month || `${new Date().toISOString().slice(0, 7)}-01`).slice(0, 7) + '-01';
  const end = monthEnd(month);
  if (method === 'GET') {
    const [[reportRow], [stats], activity] = await Promise.all([
      sql`SELECT * FROM monthly_reports WHERE intern_profile_id = ${id} AND month = ${month}`,
      sql`SELECT COUNT(*)::int booked, COUNT(*) FILTER(WHERE attended)::int attended,
        COUNT(*) FILTER(WHERE attended AND patient_gender = 'Female')::int female,
        COUNT(*) FILTER(WHERE attended AND patient_gender = 'Male')::int male,
        COUNT(*) FILTER(WHERE attended AND session_type = 'First')::int first_sessions,
        COUNT(*) FILTER(WHERE attended AND session_type = 'Follow-up')::int follow_up_sessions,
        COALESCE(SUM(duration_minutes) FILTER(WHERE attended), 0)::float counselling_minutes
        FROM encounters WHERE intern_profile_id = ${id} AND encounter_date >= ${month} AND encounter_date < ${end}`,
      rangeRequirementHours(env, id, month, end)
    ]);
    return { report: reportRow || { status: 'Draft' }, hours: activity, stats };
  }
  requireMethod(method, ['POST']);
  const status = ctx.role === 'intern' ? 'Submitted' : 'Reviewed';
  const internComment = limited(body.intern_comment, 5000, 'Intern comment');
  const supervisorComment = limited(body.supervisor_comment, 5000, 'Supervisor comment');
  const [row] = await sql`
    INSERT INTO monthly_reports(intern_profile_id, month, status, intern_comment, supervisor_comment, submitted_at, reviewed_at)
    VALUES (${id}, ${month}, ${status}, ${internComment}, ${supervisorComment}, CASE WHEN ${status} = 'Submitted' THEN NOW() END, CASE WHEN ${status} = 'Reviewed' THEN NOW() END)
    ON CONFLICT(intern_profile_id, month) DO UPDATE SET status = EXCLUDED.status,
      intern_comment = COALESCE(EXCLUDED.intern_comment, monthly_reports.intern_comment),
      supervisor_comment = COALESCE(EXCLUDED.supervisor_comment, monthly_reports.supervisor_comment),
      submitted_at = CASE WHEN EXCLUDED.status = 'Submitted' THEN NOW() ELSE monthly_reports.submitted_at END,
      reviewed_at = CASE WHEN EXCLUDED.status = 'Reviewed' THEN NOW() ELSE monthly_reports.reviewed_at END,
      updated_at = NOW()
    RETURNING *`;
  return row;
}

export async function referrals(ctx, env, url, body, method) {
  const sql = getSql(env);
  const requestedId = Number(url.searchParams.get('intern_id') || body.intern_profile_id || 0);
  const id = ctx.role === 'intern' ? ctx.profile.id : requestedId;
  if (method === 'GET') {
    if (id) {
      await assertInternAccess(ctx, id, env);
      return sql`
        SELECT r.*, p.display_name intern_name FROM referrals r JOIN profiles p ON p.id = r.intern_profile_id
        WHERE r.intern_profile_id = ${id} ORDER BY COALESCE(r.next_action_date, r.referral_date) DESC, r.created_at DESC`;
    }
    requireRole(ctx, ['programme_lead', 'supervisor']);
    if (ctx.role === 'supervisor') return sql`
      SELECT r.*, p.display_name intern_name FROM referrals r JOIN profiles p ON p.id = r.intern_profile_id
      WHERE p.supervisor_identity_user_id = ${ctx.user.id} ORDER BY COALESCE(r.next_action_date, r.referral_date) DESC, r.created_at DESC`;
    return sql`
      SELECT r.*, p.display_name intern_name FROM referrals r JOIN profiles p ON p.id = r.intern_profile_id
      ORDER BY COALESCE(r.next_action_date, r.referral_date) DESC, r.created_at DESC`;
  }
  requireMethod(method, ['POST', 'PATCH']);
  if (method === 'POST') {
    await assertInternAccess(ctx, id, env);
    const status = body.status || 'Allocated';
    const priority = body.priority || 'Routine';
    if (!REFERRAL_STATUSES.has(status) || !REFERRAL_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid referral status or priority');
    const attempts = Math.max(0, Math.min(100, Number(body.contact_attempts || 0)));
    const [row] = await sql`
      INSERT INTO referrals(intern_profile_id, referral_code, referral_date, referral_source, site, presenting_category, priority, status, contact_attempts, next_action_date, last_update, created_by_identity_user_id, updated_by_identity_user_id)
      VALUES (${id}, ${limited(body.referral_code, 50, 'Referral code', true)?.toUpperCase()}, ${dateValue(body.referral_date, 'Referral date')}, ${limited(body.referral_source, 100, 'Referral source')}, ${limited(body.site, 120, 'Site')}, ${limited(body.presenting_category, 120, 'Presenting category')}, ${priority}, ${status}, ${attempts}, ${body.next_action_date ? dateValue(body.next_action_date, 'Next action date') : null}, ${limited(body.last_update, 1000, 'Operational update')}, ${ctx.user.id}, ${ctx.user.id})
      RETURNING *`;
    await audit(ctx, env, 'create', 'referral', row.id, { status }, id);
    return row;
  }
  const [current] = await sql`SELECT * FROM referrals WHERE id = ${Number(body.id)}`;
  if (!current) throw new HttpError(404, 'Referral not found');
  await assertInternAccess(ctx, current.intern_profile_id, env);
  const status = body.status || current.status;
  const priority = body.priority || current.priority;
  if (!REFERRAL_STATUSES.has(status) || !REFERRAL_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid referral status or priority');
  const attempts = body.contact_attempts == null ? current.contact_attempts : Number(body.contact_attempts);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 100) throw new HttpError(400, 'Invalid contact attempts');
  const nextActionDate = body.next_action_date ? dateValue(body.next_action_date, 'Next action date') : null;
  const lastUpdate = limited(body.last_update, 1000, 'Operational update');
  const [row] = await sql`
    UPDATE referrals SET priority = ${priority}, status = ${status}, contact_attempts = ${attempts}, next_action_date = ${nextActionDate},
      last_update = ${lastUpdate}, updated_by_identity_user_id = ${ctx.user.id}, updated_at = NOW(),
      closed_at = CASE WHEN ${status} LIKE 'Closed%' THEN COALESCE(closed_at, NOW()) ELSE NULL END
    WHERE id = ${current.id} RETURNING *`;
  await audit(ctx, env, 'update', 'referral', row.id, { status }, current.intern_profile_id);
  return row;
}

export async function pilotContext(ctx, env, url) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : 0));
  await assertInternAccess(ctx, id, env);
  const [schedule, planned] = await Promise.all([
    sql`SELECT * FROM weekly_schedule_items WHERE intern_profile_id = ${id} AND active = true ORDER BY weekday, start_time NULLS LAST`,
    sql`SELECT * FROM planned_activities WHERE intern_profile_id = ${id} AND status <> 'Cancelled' ORDER BY activity_date NULLS LAST, id`
  ]);
  return { schedule, planned };
}

export async function feedback(ctx, env, url, body, method) {
  const sql = getSql(env);
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id, env);
  if (method === 'GET') return sql`SELECT * FROM pilot_feedback WHERE intern_profile_id = ${id} ORDER BY created_at DESC LIMIT 200`;
  if (method === 'POST') {
    const message = String(body.message || '').trim();
    if (!message) throw new HttpError(400, 'Feedback is required');
    const rating = body.rating ? Math.max(1, Math.min(5, Number(body.rating))) : null;
    const [row] = await sql`
      INSERT INTO pilot_feedback(intern_profile_id, feedback_type, rating, message, context_view)
      VALUES (${id}, ${body.feedback_type || 'General'}, ${rating}, ${message}, ${body.context_view || null})
      RETURNING *`;
    await audit(ctx, env, 'create', 'pilot_feedback', row.id, { type: row.feedback_type }, id);
    return row;
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function programme(ctx, env) {
  requireRole(ctx, ['programme_lead', 'management']);
  const sql = getSql(env);
  const [internRows, [caseRow], [supervisionRow], [reportsRow], sitesRows, [encounterRow], [waitRow]] = await Promise.all([
    sql`SELECT id, institution FROM profiles WHERE role = 'intern' AND active = true`,
    sql`SELECT COUNT(*)::int total, COUNT(*) FILTER(WHERE status <> 'Exited')::int active FROM cases`,
    sql`SELECT COUNT(*)::int n FROM supervision_items WHERE status = 'Open'`,
    sql`SELECT COUNT(*) FILTER(WHERE status = 'Reviewed')::int reviewed FROM monthly_reports WHERE month = date_trunc('month', CURRENT_DATE)::date`,
    sql`SELECT site, COUNT(*)::int cases FROM cases GROUP BY site ORDER BY cases DESC`,
    sql`SELECT COUNT(*)::int booked, COUNT(*) FILTER(WHERE attended)::int attended FROM encounters`,
    sql`SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM (intake_at - allocated_at)) / 86400.0)::float med FROM cases WHERE intake_at IS NOT NULL`
  ]);
  const progress = await Promise.all(internRows.map(x => requirementProgress(env, x.id)));
  const totalHours = progress.reduce((s, x) => s + num(x.summary.total_completed), 0);
  const atRisk = progress.filter(x => x.summary.at_risk_components > 0).length;
  const booked = num(encounterRow.booked), attended = num(encounterRow.attended);
  const institutions = Object.entries(internRows.reduce((a, x) => { a[x.institution || 'Other'] = (a[x.institution || 'Other'] || 0) + 1; return a; }, {})).map(([institution, count]) => ({ institution, count }));
  return {
    metrics: {
      interns: internRows.length,
      cases: caseRow.total,
      active_cases: caseRow.active,
      hours: round(totalHours, 1),
      at_risk_interns: atRisk,
      open_supervision: supervisionRow.n,
      reviewed_reports: reportsRow.reviewed,
      booked, attended,
      attendance_rate: booked ? Math.round(attended / booked * 100) : null,
      median_days_to_intake: waitRow.med
    },
    sites: sitesRows,
    institutions
  };
}
