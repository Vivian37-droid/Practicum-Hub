import { getDatabase } from '@netlify/database';
import { getUser } from '@netlify/identity';

const db = getDatabase();
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const cleanEmail = v => String(v || '').trim().toLowerCase();
const num = v => Number(v || 0);
const round = (v, d = 1) => Number(num(v).toFixed(d));
const leadEmails = () => new Set((process.env.PROGRAMME_LEAD_EMAILS || '').split(',').map(cleanEmail).filter(Boolean));
const weeksBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / (7 * 86400000));
const monthEnd = start => { const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };
const CASE_STATUSES = new Set(['Allocated', 'Contact attempted', 'Booked', 'Intake', 'Active', 'Exit review', 'Exited']);
const SUPERVISION_STATUSES = new Set(['Open', 'Reviewed', 'Closed']);
const SUPERVISION_PRIORITIES = new Set(['Routine', 'Important', 'Risk / urgent']);
const SESSION_TYPES = new Set(['First', 'Follow-up']);
const GENDERS = new Set(['Female', 'Male', 'Other', 'Unknown']);
const dateValue = (value, label) => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new HttpError(400, `${label} is invalid`);
  return text;
};
const limited = (value, max, label, required = false) => {
  const text = String(value || '').trim();
  if (required && !text) throw new HttpError(400, `${label} is required`);
  if (text.length > max) throw new HttpError(400, `${label} is too long`);
  return text || null;
};
function requireMethod(method, allowed) {
  if (!allowed.includes(method)) throw new HttpError(405, 'Method not allowed');
}
function requireSameOrigin(request) {
  if (['GET', 'HEAD'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) throw new HttpError(403, 'Request origin is not allowed');
}

async function context() {
  const user = await getUser();
  if (!user) throw new HttpError(401, 'Please sign in');
  const email = cleanEmail(user.email);
  let profile = (await db.pool.query(
    'SELECT * FROM profiles WHERE identity_user_id=$1 OR lower(email)=$2 ORDER BY identity_user_id IS NOT NULL DESC LIMIT 1',
    [user.id, email]
  )).rows[0];
  const role = leadEmails().has(email)
    ? 'programme_lead'
    : (['programme_lead', 'supervisor', 'management', 'intern'].find(r => (user.roles || []).includes(r)) || 'intern');

  if (!profile) {
    profile = (await db.pool.query(
      'INSERT INTO profiles(identity_user_id,email,display_name,role) VALUES($1,$2,$3,$4) RETURNING *',
      [user.id, email, user.name || email.split('@')[0], role]
    )).rows[0];
  } else {
    profile = (await db.pool.query(
      'UPDATE profiles SET identity_user_id=$1,role=$2,updated_at=NOW() WHERE id=$3 RETURNING *',
      [user.id, role, profile.id]
    )).rows[0];
  }
  return { user, profile, role };
}

function requireRole(ctx, roles) {
  if (!roles.includes(ctx.role)) throw new HttpError(403, 'You do not have permission');
}

async function canAccessIntern(ctx, id) {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (ctx.role === 'programme_lead') return true;
  if (ctx.role === 'intern') return ctx.profile.id === id;
  if (ctx.role === 'supervisor') {
    return !!(await db.pool.query('SELECT 1 FROM profiles WHERE id=$1 AND supervisor_identity_user_id=$2', [id, ctx.user.id])).rows[0];
  }
  return false;
}
async function assertInternAccess(ctx, id) { if (!(await canAccessIntern(ctx, id))) throw new HttpError(403, 'You cannot access this intern record'); }
async function audit(ctx, action, entityType, entityId, detail, profileId) {
  await db.pool.query(
    'INSERT INTO audit_log(identity_user_id,profile_id,action,entity_type,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [ctx.user.id, profileId || ctx.profile.id, action, entityType, entityId ? String(entityId) : null, detail ? JSON.stringify(detail) : null]
  );
}

async function ensureRequirementProfile(profile) {
  if (profile.requirement_profile_id) return profile.requirement_profile_id;
  const code = profile.institution === 'SACAP' ? 'sacap-bpsych' : profile.institution === 'Cornerstone Institute' ? 'cornerstone-bpsych' : 'generic-720';
  const row = (await db.pool.query('SELECT id FROM requirement_profiles WHERE code=$1', [code])).rows[0];
  if (!row) return null;
  await db.pool.query('UPDATE profiles SET requirement_profile_id=$1 WHERE id=$2', [row.id, profile.id]);
  return row.id;
}

async function loadProfile(id) {
  let profile = (await db.pool.query(`SELECT p.*,rp.code requirement_profile_code,rp.name requirement_profile_name,rp.overall_programme_hours
    FROM profiles p LEFT JOIN requirement_profiles rp ON rp.id=p.requirement_profile_id WHERE p.id=$1`, [id])).rows[0];
  if (!profile) throw new HttpError(404, 'Intern not found');
  const rpId = await ensureRequirementProfile(profile);
  if (rpId && !profile.requirement_profile_id) {
    profile = (await db.pool.query(`SELECT p.*,rp.code requirement_profile_code,rp.name requirement_profile_name,rp.overall_programme_hours
      FROM profiles p LEFT JOIN requirement_profiles rp ON rp.id=p.requirement_profile_id WHERE p.id=$1`, [id])).rows[0];
  }
  return profile;
}

async function requirementProgress(id) {
  const profile = await loadProfile(id);
  const components = (await db.pool.query('SELECT * FROM requirement_components WHERE requirement_profile_id=$1 ORDER BY sort_order,name', [profile.requirement_profile_id])).rows;
  const manual = (await db.pool.query(`SELECT component_code,SUM(hours)::float total,
      SUM(hours) FILTER(WHERE work_date>=CURRENT_DATE-27)::float recent_28d
      FROM hours WHERE intern_profile_id=$1 AND component_code IS NOT NULL GROUP BY component_code`, [id])).rows;
  const manualMap = Object.fromEntries(manual.map(x => [x.component_code, { total: num(x.total), recent: num(x.recent_28d) }]));
  const encounter = (await db.pool.query(`SELECT
      COALESCE(SUM(duration_minutes) FILTER(WHERE attended),0)::float minutes,
      COUNT(*)::int booked,COUNT(*) FILTER(WHERE attended)::int attended,
      AVG(duration_minutes) FILTER(WHERE attended AND duration_minutes>0)::float avg_minutes
      FROM encounters WHERE intern_profile_id=$1`, [id])).rows[0];
  const recentEncounter = (await db.pool.query(`SELECT COALESCE(SUM(duration_minutes) FILTER(WHERE attended),0)::float minutes
      FROM encounters WHERE intern_profile_id=$1 AND encounter_date>=CURRENT_DATE-27`, [id])).rows[0];
  const activeCases = (await db.pool.query(`SELECT COUNT(*)::int n,
      COALESCE(SUM(1.0/NULLIF(planned_frequency_weeks,0)),0)::float weekly_bookings
      FROM cases WHERE intern_profile_id=$1 AND status IN('Booked','Intake','Active','Exit review')`, [id])).rows[0];
  const deliverables = (await db.pool.query(`SELECT component_id,status,note FROM deliverable_progress WHERE intern_profile_id=$1`, [id])).rows;
  const deliverableMap = Object.fromEntries(deliverables.map(x => [x.component_id, x]));
  const opening = (await db.pool.query(`SELECT component_id,hours::float hours,note FROM requirement_opening_balances WHERE intern_profile_id=$1`, [id])).rows;
  const openingMap = Object.fromEntries(opening.map(x => [x.component_id, x]));

  const start = profile.placement_start ? new Date(profile.placement_start) : null;
  const end = profile.placement_end ? new Date(profile.placement_end) : null;
  const now = new Date();
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
  const estimatedClinicalTargetDate = estimatedClinicalWeeksToTarget == null ? null : new Date(now.getTime() + estimatedClinicalWeeksToTarget * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
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

async function dashboard(ctx) {
  if (ctx.role === 'management') return programme(ctx);
  if (ctx.role === 'intern') {
    const [cases, supervision, requirements] = await Promise.all([
      db.pool.query("SELECT COUNT(*)::int n FROM cases WHERE intern_profile_id=$1 AND status<>'Exited'", [ctx.profile.id]),
      db.pool.query("SELECT COUNT(*)::int n FROM supervision_items WHERE intern_profile_id=$1 AND status='Open'", [ctx.profile.id]),
      requirementProgress(ctx.profile.id)
    ]);
    return { profile: ctx.profile, requirements, metrics: { active_cases: cases.rows[0].n, open_supervision: supervision.rows[0].n } };
  }
  requireRole(ctx, ['programme_lead', 'supervisor']);
  const filter = ctx.role === 'supervisor' ? [' AND supervisor_identity_user_id=$1', [ctx.user.id]] : ['', []];
  let interns = (await db.pool.query(`SELECT p.*,
      COALESCE((SELECT COUNT(*) FROM cases x WHERE x.intern_profile_id=p.id AND x.status<>'Exited'),0)::int active_cases,
      COALESCE((SELECT COUNT(*) FROM supervision_items s WHERE s.intern_profile_id=p.id AND s.status='Open'),0)::int open_supervision
      FROM profiles p WHERE role='intern' AND active=true ${filter[0]} ORDER BY display_name`, filter[1])).rows;
  interns = await Promise.all(interns.map(async p => {
    const req = await requirementProgress(p.id);
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

async function interns(ctx, body, method) {
  requireRole(ctx, ['programme_lead', 'supervisor']);
  if (method === 'GET') {
    const filter = ctx.role === 'supervisor' ? [' AND supervisor_identity_user_id=$1', [ctx.user.id]] : ['', []];
    let rows = (await db.pool.query(`SELECT p.*,
      COALESCE((SELECT COUNT(*) FROM cases x WHERE x.intern_profile_id=p.id AND x.status<>'Exited'),0)::int active_cases,
      COALESCE((SELECT COUNT(*) FROM supervision_items s WHERE s.intern_profile_id=p.id AND s.status='Open'),0)::int open_supervision
      FROM profiles p WHERE role='intern' ${filter[0]} ORDER BY active DESC,display_name`, filter[1])).rows;
    rows = await Promise.all(rows.map(async p => ({ ...p, requirement_summary: (await requirementProgress(p.id)).summary })));
    return rows;
  }
  requireRole(ctx, ['programme_lead']);
  const email = cleanEmail(body.email);
  const name = String(body.display_name || '').trim();
  if (!email || !name) throw new HttpError(400, 'Name and email are required');
  const institution = body.institution || 'Other';
  const code = institution === 'SACAP' ? 'sacap-bpsych' : institution === 'Cornerstone Institute' ? 'cornerstone-bpsych' : 'generic-720';
  const rp = (await db.pool.query('SELECT id,overall_programme_hours FROM requirement_profiles WHERE code=$1', [code])).rows[0];
  const row = (await db.pool.query(`INSERT INTO profiles(email,display_name,role,institution,placement_start,placement_end,required_hours,requirement_profile_id,supervisor_identity_user_id,default_session_minutes)
    VALUES($1,$2,'intern',$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name,institution=EXCLUDED.institution,placement_start=EXCLUDED.placement_start,
    placement_end=EXCLUDED.placement_end,required_hours=EXCLUDED.required_hours,requirement_profile_id=EXCLUDED.requirement_profile_id,
    supervisor_identity_user_id=EXCLUDED.supervisor_identity_user_id,default_session_minutes=EXCLUDED.default_session_minutes,active=true RETURNING *`,
    [email, name, institution, body.placement_start || null, body.placement_end || null, num(rp?.overall_programme_hours || 720), rp?.id || null, ctx.user.id, num(body.default_session_minutes || 60)])).rows[0];
  await audit(ctx, 'create_or_update', 'intern', row.id, { institution }, row.id);
  return row;
}

async function requirements(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id);
  if (method === 'GET') return requirementProgress(id);
  if (method === 'PATCH') {
    const component = (await db.pool.query(`SELECT c.* FROM requirement_components c JOIN profiles p ON p.requirement_profile_id=c.requirement_profile_id WHERE c.id=$1 AND p.id=$2`, [Number(body.component_id), id])).rows[0];
    if (!component) throw new HttpError(400, 'Requirement component not found');
    if (body.action === 'opening_balance') {
      requireRole(ctx, ['programme_lead', 'supervisor']);
      const value = num(body.hours);
      if (value < 0 || value > 2000) throw new HttpError(400, 'Invalid opening balance');
      const row = (await db.pool.query(`INSERT INTO requirement_opening_balances(intern_profile_id,component_id,hours,note,updated_by_identity_user_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(intern_profile_id,component_id) DO UPDATE SET hours=EXCLUDED.hours,note=EXCLUDED.note,updated_by_identity_user_id=EXCLUDED.updated_by_identity_user_id,updated_at=NOW() RETURNING *`,
        [id, component.id, value, body.note || 'Opening balance from existing institutional logbook', ctx.user.id])).rows[0];
      await audit(ctx, 'update', 'opening_balance', row.id, { component: component.code, hours: value }, id);
      return row;
    }
    if (component.calculation_mode !== 'deliverable') throw new HttpError(400, 'Deliverable not found');
    const status = ['Not started', 'In progress', 'Complete'].includes(body.status) ? body.status : 'Not started';
    const row = (await db.pool.query(`INSERT INTO deliverable_progress(intern_profile_id,component_id,status,note,updated_by_identity_user_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(intern_profile_id,component_id) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,updated_by_identity_user_id=EXCLUDED.updated_by_identity_user_id,updated_at=NOW() RETURNING *`,
      [id, component.id, status, body.note || null, ctx.user.id])).rows[0];
    await audit(ctx, 'update', 'deliverable', row.id, { status }, id);
    return row;
  }
  throw new HttpError(405, 'Method not allowed');
}

async function cases(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  if (method === 'GET') {
    if (id) { await assertInternAccess(ctx, id); return (await db.pool.query('SELECT x.*,p.display_name intern_name FROM cases x JOIN profiles p ON p.id=x.intern_profile_id WHERE intern_profile_id=$1 ORDER BY updated_at DESC', [id])).rows; }
    requireRole(ctx, ['programme_lead', 'supervisor']);
    if (ctx.role === 'supervisor') return (await db.pool.query(`SELECT x.*,p.display_name intern_name FROM cases x JOIN profiles p ON p.id=x.intern_profile_id WHERE p.supervisor_identity_user_id=$1 ORDER BY x.updated_at DESC`, [ctx.user.id])).rows;
    return (await db.pool.query('SELECT x.*,p.display_name intern_name FROM cases x JOIN profiles p ON p.id=x.intern_profile_id ORDER BY x.updated_at DESC')).rows;
  }
  if (method === 'POST') {
    requireRole(ctx, ['programme_lead', 'supervisor']);
    await assertInternAccess(ctx, id);
    const caseCode = limited(body.case_code, 50, 'Case code', true)?.toUpperCase();
    const site = limited(body.site, 120, 'Site', true);
    const category = limited(body.presenting_category, 120, 'Presenting category');
    const status = body.status || 'Allocated';
    const frequency = Number(body.planned_frequency_weeks || 1);
    if (!CASE_STATUSES.has(status)) throw new HttpError(400, 'Invalid case status');
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > 52) throw new HttpError(400, 'Invalid planned frequency');
    const row = (await db.pool.query(`INSERT INTO cases(case_code,intern_profile_id,site,presenting_category,status,planned_frequency_weeks,created_by_identity_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [caseCode, id, site, category, status, frequency, ctx.user.id])).rows[0];
    await audit(ctx, 'create', 'case', row.id, null, id);
    return row;
  }
  if (method === 'PATCH') {
    const row = (await db.pool.query('SELECT * FROM cases WHERE id=$1', [Number(body.id)])).rows[0];
    if (!row) throw new HttpError(404, 'Case not found');
    await assertInternAccess(ctx, row.intern_profile_id);
    const status = body.status || row.status;
    if (!CASE_STATUSES.has(status)) throw new HttpError(400, 'Invalid case status');
    const requestedFrequency = body.planned_frequency_weeks == null ? null : Number(body.planned_frequency_weeks);
    if (requestedFrequency != null && (ctx.role === 'intern' || !Number.isInteger(requestedFrequency) || requestedFrequency < 1 || requestedFrequency > 52)) throw new HttpError(403, 'Only a supervisor can change planned frequency');
    const updated = (await db.pool.query(`UPDATE cases SET status=$1,supervision_status=COALESCE($2,supervision_status),
      planned_frequency_weeks=COALESCE($3,planned_frequency_weeks),
      first_contact_at=CASE WHEN $1 IN('Contact attempted','Booked','Intake','Active','Exit review','Exited') THEN COALESCE(first_contact_at,NOW()) ELSE first_contact_at END,
      booked_at=CASE WHEN $1 IN('Booked','Intake','Active','Exit review','Exited') THEN COALESCE(booked_at,NOW()) ELSE booked_at END,
      intake_at=CASE WHEN $1 IN('Intake','Active','Exit review','Exited') THEN COALESCE(intake_at,NOW()) ELSE intake_at END,
      exited_at=CASE WHEN $1='Exited' THEN COALESCE(exited_at,NOW()) ELSE exited_at END,updated_at=NOW() WHERE id=$4 RETURNING *`,
      [status, limited(body.supervision_status, 60, 'Supervision status'), requestedFrequency, row.id])).rows[0];
    await audit(ctx, 'update', 'case', row.id, { status, planned_frequency_weeks: updated.planned_frequency_weeks }, row.intern_profile_id);
    return updated;
  }
  throw new HttpError(405, 'Method not allowed');
}

async function encounters(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id);
  if (method === 'GET') return (await db.pool.query('SELECT e.*,x.case_code FROM encounters e JOIN cases x ON x.id=e.case_id WHERE e.intern_profile_id=$1 ORDER BY encounter_date DESC,created_at DESC', [id])).rows;
  requireMethod(method, ['POST']);
  const theCase = (await db.pool.query('SELECT * FROM cases WHERE id=$1', [Number(body.case_id)])).rows[0];
  if (!theCase || theCase.intern_profile_id !== id) throw new HttpError(400, 'Case does not belong to this intern');
  const booked = String(body.booked) !== 'false';
  const attended = String(body.attended) !== 'false';
  const profile = await loadProfile(id);
  const duration = attended ? Math.max(1, num(body.duration_minutes || profile.default_session_minutes || 60)) : 0;
  if (duration > 480) throw new HttpError(400, 'Duration cannot exceed 480 minutes');
  if (!SESSION_TYPES.has(body.session_type)) throw new HttpError(400, 'Invalid session type');
  const gender = body.patient_gender || 'Unknown';
  if (!GENDERS.has(gender)) throw new HttpError(400, 'Invalid gender value');
  const row = (await db.pool.query(`INSERT INTO encounters(case_id,intern_profile_id,encounter_date,booked,attended,session_type,patient_gender,site,duration_minutes,created_by_identity_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [theCase.id, id, dateValue(body.encounter_date, 'Encounter date'), booked, attended, body.session_type, gender, theCase.site, duration, ctx.user.id])).rows[0];
  if (attended) await db.pool.query("UPDATE cases SET sessions=(SELECT COUNT(*) FROM encounters WHERE case_id=$1 AND attended=true),status=CASE WHEN status IN('Allocated','Contact attempted','Booked','Intake') THEN 'Active' ELSE status END,updated_at=NOW() WHERE id=$1", [theCase.id]);
  await audit(ctx, 'create', 'encounter', row.id, { attended, duration_minutes: duration }, id);
  return row;
}

async function hours(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id);
  if (method === 'GET') {
    const entries = (await db.pool.query(`SELECT h.*,c.name component_name,c.manual_label,c.calculation_mode
      FROM hours h LEFT JOIN requirement_components c ON c.code=h.component_code AND c.requirement_profile_id=(SELECT requirement_profile_id FROM profiles WHERE id=$1)
      WHERE h.intern_profile_id=$1 ORDER BY work_date DESC,h.created_at DESC LIMIT 300`, [id])).rows;
    const components = (await db.pool.query(`SELECT c.* FROM requirement_components c JOIN profiles p ON p.requirement_profile_id=c.requirement_profile_id
      WHERE p.id=$1 AND c.calculation_mode IN('manual','manual_plus_individual_encounters') ORDER BY c.sort_order`, [id])).rows;
    return { entries, components };
  }
  requireMethod(method, ['POST']);
  const value = num(body.hours);
  if (!(value > 0 && value <= 24)) throw new HttpError(400, 'Hours must be greater than 0 and no more than 24');
  const component = (await db.pool.query(`SELECT c.* FROM requirement_components c JOIN profiles p ON p.requirement_profile_id=c.requirement_profile_id
    WHERE p.id=$1 AND c.code=$2`, [id, body.component_code])).rows[0];
  if (!component || !['manual', 'manual_plus_individual_encounters'].includes(component.calculation_mode)) throw new HttpError(400, 'Choose a valid activity category');
  const row = (await db.pool.query('INSERT INTO hours(intern_profile_id,work_date,category,component_code,hours,note,created_by_identity_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [id, dateValue(body.work_date, 'Work date'), component.name, component.code, value, limited(body.note, 1000, 'Note'), ctx.user.id])).rows[0];
  await audit(ctx, 'create', 'hours', row.id, { component_code: component.code, hours: value }, id);
  return row;
}

async function supervision(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  if (method === 'PATCH') {
    requireRole(ctx, ['programme_lead', 'supervisor']);
    const row = (await db.pool.query('SELECT * FROM supervision_items WHERE id=$1', [Number(body.id)])).rows[0];
    if (!row) throw new HttpError(404, 'Supervision item not found');
    await assertInternAccess(ctx, row.intern_profile_id);
    const status = body.status || row.status;
    if (!SUPERVISION_STATUSES.has(status)) throw new HttpError(400, 'Invalid supervision status');
    return (await db.pool.query('UPDATE supervision_items SET supervisor_note=$1,status=$2,updated_at=NOW() WHERE id=$3 RETURNING *', [body.supervisor_note == null ? row.supervisor_note : limited(body.supervisor_note, 3000, 'Supervisor response'), status, row.id])).rows[0];
  }
  await assertInternAccess(ctx, id);
  if (method === 'GET') return (await db.pool.query('SELECT s.*,x.case_code FROM supervision_items s LEFT JOIN cases x ON x.id=s.case_id WHERE s.intern_profile_id=$1 ORDER BY CASE WHEN s.status=\'Open\' THEN 0 ELSE 1 END,created_at DESC', [id])).rows;
  requireMethod(method, ['POST']);
  const priority = body.priority || 'Routine';
  if (!SUPERVISION_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid supervision priority');
  const caseId = body.case_id ? Number(body.case_id) : null;
  if (caseId) {
    const linkedCase = (await db.pool.query('SELECT 1 FROM cases WHERE id=$1 AND intern_profile_id=$2', [caseId, id])).rows[0];
    if (!linkedCase) throw new HttpError(400, 'Case does not belong to this intern');
  }
  const row = (await db.pool.query(`INSERT INTO supervision_items(intern_profile_id,case_id,topic,question,priority,action_taken,created_by_identity_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, caseId, limited(body.topic, 200, 'Topic', true), limited(body.question, 3000, 'Question', true), priority, limited(body.action_taken, 3000, 'Action taken'), ctx.user.id])).rows[0];
  await audit(ctx, 'create', 'supervision', row.id, { priority: row.priority }, id);
  return row;
}

async function competencies(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id);
  if (method === 'GET') return (await db.pool.query(`SELECT d.*,p.intern_rating,p.supervisor_rating,p.evidence,p.supervisor_comment
    FROM competency_definitions d LEFT JOIN competency_progress p ON p.competency_id=d.id AND p.intern_profile_id=$1 ORDER BY sort_order`, [id])).rows;
  requireMethod(method, ['POST']);
  const definition = (await db.pool.query('SELECT 1 FROM competency_definitions WHERE id=$1', [Number(body.competency_id)])).rows[0];
  if (!definition) throw new HttpError(400, 'Competency not found');
  const old = (await db.pool.query('SELECT * FROM competency_progress WHERE intern_profile_id=$1 AND competency_id=$2', [id, body.competency_id])).rows[0] || {};
  const internRating = ctx.role === 'intern' ? (body.intern_rating ?? old.intern_rating) : old.intern_rating;
  const supervisorRating = ctx.role === 'intern' ? old.supervisor_rating : (body.supervisor_rating ?? old.supervisor_rating);
  const evidence = ctx.role === 'intern' ? (body.evidence ?? old.evidence) : old.evidence;
  const comment = ctx.role === 'intern' ? old.supervisor_comment : (body.supervisor_comment ?? old.supervisor_comment);
  for (const rating of [internRating, supervisorRating]) if (rating != null && (!Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)) throw new HttpError(400, 'Ratings must be between 1 and 5');
  return (await db.pool.query(`INSERT INTO competency_progress(intern_profile_id,competency_id,intern_rating,supervisor_rating,evidence,supervisor_comment,updated_by_identity_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(intern_profile_id,competency_id) DO UPDATE SET intern_rating=EXCLUDED.intern_rating,
    supervisor_rating=EXCLUDED.supervisor_rating,evidence=EXCLUDED.evidence,supervisor_comment=EXCLUDED.supervisor_comment,
    updated_by_identity_user_id=EXCLUDED.updated_by_identity_user_id,updated_at=NOW() RETURNING *`,
    [id, body.competency_id, internRating, supervisorRating, limited(evidence, 3000, 'Evidence'), limited(comment, 3000, 'Supervisor comment'), ctx.user.id])).rows[0];
}

async function rangeRequirementHours(id, start, end) {
  const profile = await loadProfile(id);
  const components = (await db.pool.query('SELECT * FROM requirement_components WHERE requirement_profile_id=$1 ORDER BY sort_order', [profile.requirement_profile_id])).rows;
  const manual = (await db.pool.query(`SELECT component_code,SUM(hours)::float total FROM hours WHERE intern_profile_id=$1 AND work_date>=$2 AND work_date<$3 GROUP BY component_code`, [id, start, end])).rows;
  const manualMap = Object.fromEntries(manual.map(x => [x.component_code, num(x.total)]));
  const encounterHours = num((await db.pool.query('SELECT COALESCE(SUM(duration_minutes) FILTER(WHERE attended),0)::float minutes FROM encounters WHERE intern_profile_id=$1 AND encounter_date>=$2 AND encounter_date<$3', [id, start, end])).rows[0].minutes) / 60;
  return components.filter(c => c.target_hours != null).map(c => {
    let value = num(manualMap[c.code]);
    if (c.calculation_mode === 'individual_encounters') value = encounterHours;
    if (c.calculation_mode === 'manual_plus_individual_encounters') value += encounterHours;
    return { code: c.code, name: c.name, total: round(value, 1) };
  }).filter(x => x.total > 0);
}

async function reports(ctx, url, body, method) {
  const id = Number(url.searchParams.get('intern_id') || (ctx.role === 'intern' ? ctx.profile.id : body.intern_profile_id || 0));
  await assertInternAccess(ctx, id);
  const month = (url.searchParams.get('month') || body.month || `${new Date().toISOString().slice(0, 7)}-01`).slice(0, 7) + '-01';
  const end = monthEnd(month);
  if (method === 'GET') {
    const [reportRow, stats, activity] = await Promise.all([
      db.pool.query('SELECT * FROM monthly_reports WHERE intern_profile_id=$1 AND month=$2', [id, month]),
      db.pool.query(`SELECT COUNT(*)::int booked,COUNT(*) FILTER(WHERE attended)::int attended,
        COUNT(*) FILTER(WHERE attended AND patient_gender='Female')::int female,
        COUNT(*) FILTER(WHERE attended AND patient_gender='Male')::int male,
        COUNT(*) FILTER(WHERE attended AND session_type='First')::int first_sessions,
        COUNT(*) FILTER(WHERE attended AND session_type='Follow-up')::int follow_up_sessions,
        COALESCE(SUM(duration_minutes) FILTER(WHERE attended),0)::float counselling_minutes
        FROM encounters WHERE intern_profile_id=$1 AND encounter_date>=$2 AND encounter_date<$3`, [id, month, end]),
      rangeRequirementHours(id, month, end)
    ]);
    return { report: reportRow.rows[0] || { status: 'Draft' }, hours: activity, stats: stats.rows[0] };
  }
  requireMethod(method, ['POST']);
  const status = ctx.role === 'intern' ? 'Submitted' : 'Reviewed';
  return (await db.pool.query(`INSERT INTO monthly_reports(intern_profile_id,month,status,intern_comment,supervisor_comment,submitted_at,reviewed_at)
    VALUES($1,$2,$3,$4,$5,CASE WHEN $3='Submitted' THEN NOW() END,CASE WHEN $3='Reviewed' THEN NOW() END)
    ON CONFLICT(intern_profile_id,month) DO UPDATE SET status=EXCLUDED.status,
    intern_comment=COALESCE(EXCLUDED.intern_comment,monthly_reports.intern_comment),supervisor_comment=COALESCE(EXCLUDED.supervisor_comment,monthly_reports.supervisor_comment),
    submitted_at=CASE WHEN EXCLUDED.status='Submitted' THEN NOW() ELSE monthly_reports.submitted_at END,
    reviewed_at=CASE WHEN EXCLUDED.status='Reviewed' THEN NOW() ELSE monthly_reports.reviewed_at END,updated_at=NOW() RETURNING *`,
    [id, month, status, limited(body.intern_comment, 5000, 'Intern comment'), limited(body.supervisor_comment, 5000, 'Supervisor comment')])).rows[0];
}

const REFERRAL_STATUSES = new Set(['Allocated', 'Contact attempted', 'Contact made', 'Booked', 'Intake completed', 'Active', 'Awaiting feedback', 'Closed – completed', 'Closed – no contact', 'Reallocated']);
const REFERRAL_PRIORITIES = new Set(['Routine', 'Priority', 'Urgent']);
async function referrals(ctx, url, body, method) {
  const requestedId = Number(url.searchParams.get('intern_id') || body.intern_profile_id || 0);
  const id = ctx.role === 'intern' ? ctx.profile.id : requestedId;
  if (method === 'GET') {
    if (id) {
      await assertInternAccess(ctx, id);
      return (await db.pool.query(`SELECT r.*,p.display_name intern_name FROM referrals r JOIN profiles p ON p.id=r.intern_profile_id
        WHERE r.intern_profile_id=$1 ORDER BY COALESCE(r.next_action_date,r.referral_date) DESC,r.created_at DESC`, [id])).rows;
    }
    requireRole(ctx, ['programme_lead', 'supervisor']);
    if (ctx.role === 'supervisor') return (await db.pool.query(`SELECT r.*,p.display_name intern_name FROM referrals r JOIN profiles p ON p.id=r.intern_profile_id
      WHERE p.supervisor_identity_user_id=$1 ORDER BY COALESCE(r.next_action_date,r.referral_date) DESC,r.created_at DESC`, [ctx.user.id])).rows;
    return (await db.pool.query(`SELECT r.*,p.display_name intern_name FROM referrals r JOIN profiles p ON p.id=r.intern_profile_id
      ORDER BY COALESCE(r.next_action_date,r.referral_date) DESC,r.created_at DESC`)).rows;
  }
  requireMethod(method, ['POST', 'PATCH']);
  if (method === 'POST') {
    await assertInternAccess(ctx, id);
    const status = body.status || 'Allocated';
    const priority = body.priority || 'Routine';
    if (!REFERRAL_STATUSES.has(status) || !REFERRAL_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid referral status or priority');
    const row = (await db.pool.query(`INSERT INTO referrals(intern_profile_id,referral_code,referral_date,referral_source,site,presenting_category,priority,status,contact_attempts,next_action_date,last_update,created_by_identity_user_id,updated_by_identity_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`, [id, limited(body.referral_code, 50, 'Referral code', true)?.toUpperCase(), dateValue(body.referral_date, 'Referral date'), limited(body.referral_source, 100, 'Referral source'), limited(body.site, 120, 'Site'), limited(body.presenting_category, 120, 'Presenting category'), priority, status, Math.max(0, Math.min(100, Number(body.contact_attempts || 0))), body.next_action_date ? dateValue(body.next_action_date, 'Next action date') : null, limited(body.last_update, 1000, 'Operational update'), ctx.user.id])).rows[0];
    await audit(ctx, 'create', 'referral', row.id, { status }, id);
    return row;
  }
  const current = (await db.pool.query('SELECT * FROM referrals WHERE id=$1', [Number(body.id)])).rows[0];
  if (!current) throw new HttpError(404, 'Referral not found');
  await assertInternAccess(ctx, current.intern_profile_id);
  const status = body.status || current.status;
  const priority = body.priority || current.priority;
  if (!REFERRAL_STATUSES.has(status) || !REFERRAL_PRIORITIES.has(priority)) throw new HttpError(400, 'Invalid referral status or priority');
  const attempts = body.contact_attempts == null ? current.contact_attempts : Number(body.contact_attempts);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 100) throw new HttpError(400, 'Invalid contact attempts');
  const row = (await db.pool.query(`UPDATE referrals SET priority=$1,status=$2,contact_attempts=$3,next_action_date=$4,last_update=$5,
    updated_by_identity_user_id=$6,updated_at=NOW(),closed_at=CASE WHEN $2 LIKE 'Closed%' THEN COALESCE(closed_at,NOW()) ELSE NULL END WHERE id=$7 RETURNING *`,
    [priority, status, attempts, body.next_action_date ? dateValue(body.next_action_date, 'Next action date') : null, limited(body.last_update, 1000, 'Operational update'), ctx.user.id, current.id])).rows[0];
  await audit(ctx, 'update', 'referral', row.id, { status }, current.intern_profile_id);
  return row;
}


async function pilotContext(ctx, url) {
  const id=Number(url.searchParams.get('intern_id') || (ctx.role==='intern' ? ctx.profile.id : 0));
  await assertInternAccess(ctx,id);
  const [schedule,planned]=await Promise.all([
    db.pool.query(`SELECT * FROM weekly_schedule_items WHERE intern_profile_id=$1 AND active=true ORDER BY weekday,start_time NULLS LAST`,[id]),
    db.pool.query(`SELECT * FROM planned_activities WHERE intern_profile_id=$1 AND status<>'Cancelled' ORDER BY activity_date NULLS LAST,id`,[id])
  ]);
  return {schedule:schedule.rows,planned:planned.rows};
}
async function feedback(ctx,url,body,method){
  const id=Number(url.searchParams.get('intern_id') || (ctx.role==='intern'?ctx.profile.id:body.intern_profile_id||0));
  await assertInternAccess(ctx,id);
  if(method==='GET') return (await db.pool.query(`SELECT * FROM pilot_feedback WHERE intern_profile_id=$1 ORDER BY created_at DESC LIMIT 200`,[id])).rows;
  if(method==='POST'){
    const message=String(body.message||'').trim(); if(!message) throw new HttpError(400,'Feedback is required');
    const rating=body.rating?Math.max(1,Math.min(5,Number(body.rating))):null;
    const row=(await db.pool.query(`INSERT INTO pilot_feedback(intern_profile_id,feedback_type,rating,message,context_view) VALUES($1,$2,$3,$4,$5) RETURNING *`,[id,body.feedback_type||'General',rating,message,body.context_view||null])).rows[0];
    await audit(ctx,'create','pilot_feedback',row.id,{type:row.feedback_type},id); return row;
  }
  throw new HttpError(405,'Method not allowed');
}

async function programme(ctx) {
  requireRole(ctx, ['programme_lead', 'management']);
  const [internRows, caseRows, supervisionRows, reportsRows, sitesRows, encounterRows, waitRows] = await Promise.all([
    db.pool.query("SELECT id,institution FROM profiles WHERE role='intern' AND active=true"),
    db.pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status<>'Exited')::int active FROM cases"),
    db.pool.query("SELECT COUNT(*)::int n FROM supervision_items WHERE status='Open'"),
    db.pool.query("SELECT COUNT(*) FILTER(WHERE status='Reviewed')::int reviewed FROM monthly_reports WHERE month=date_trunc('month',CURRENT_DATE)::date"),
    db.pool.query('SELECT site,COUNT(*)::int cases FROM cases GROUP BY site ORDER BY cases DESC'),
    db.pool.query('SELECT COUNT(*)::int booked,COUNT(*) FILTER(WHERE attended)::int attended FROM encounters'),
    db.pool.query('SELECT percentile_cont(0.5) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM(intake_at-allocated_at))/86400.0)::float med FROM cases WHERE intake_at IS NOT NULL')
  ]);
  const progress = await Promise.all(internRows.rows.map(x => requirementProgress(x.id)));
  const totalHours = progress.reduce((s, x) => s + num(x.summary.total_completed), 0);
  const atRisk = progress.filter(x => x.summary.at_risk_components > 0).length;
  const booked = num(encounterRows.rows[0].booked), attended = num(encounterRows.rows[0].attended);
  const institutions = Object.entries(internRows.rows.reduce((a, x) => { a[x.institution || 'Other'] = (a[x.institution || 'Other'] || 0) + 1; return a; }, {})).map(([institution, count]) => ({ institution, count }));
  return {
    metrics: {
      interns: internRows.rows.length,
      cases: caseRows.rows[0].total,
      active_cases: caseRows.rows[0].active,
      hours: round(totalHours, 1),
      at_risk_interns: atRisk,
      open_supervision: supervisionRows.rows[0].n,
      reviewed_reports: reportsRows.rows[0].reviewed,
      booked,
      attended,
      attendance_rate: booked ? Math.round(attended / booked * 100) : null,
      median_days_to_intake: waitRows.rows[0].med
    },
    sites: sitesRows.rows,
    institutions
  };
}

export default async request => {
  try {
    requireSameOrigin(request);
    const ctx = await context();
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
    let body = {};
    if (!['GET', 'HEAD'].includes(request.method)) { try { body = await request.json(); } catch {} }

    if (path === 'bootstrap') return json({ profile: ctx.profile, role: ctx.role, dashboard: await dashboard(ctx) });
    if (path === 'dashboard') return json(await dashboard(ctx));
    if (path === 'interns') return json(await interns(ctx, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'requirements') return json(await requirements(ctx, url, body, request.method));
    if (path === 'cases') return json(await cases(ctx, url, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'encounters') return json(await encounters(ctx, url, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'hours') return json(await hours(ctx, url, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'supervision') return json(await supervision(ctx, url, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'competencies') return json(await competencies(ctx, url, body, request.method));
    if (path === 'reports') return json(await reports(ctx, url, body, request.method));
    if (path === 'referrals') return json(await referrals(ctx, url, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'pilot-context') return json(await pilotContext(ctx, url));
    if (path === 'feedback') return json(await feedback(ctx, url, body, request.method), request.method === 'POST' ? 201 : 200);
    if (path === 'programme') return json(await programme(ctx));
    throw new HttpError(404, 'Not found');
  } catch (error) {
    console.error(error);
    return json({ error: error.message || 'Unexpected error' }, error.status || 500);
  }
};

export const config = { path: '/api/*' };
