const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const fmt = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pc = (a, b) => b ? Math.min(100, Math.round(Number(a || 0) / Number(b) * 100)) : 0;
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const statusClass = s => { const v=String(s||'').toLowerCase(); if(['complete','on track','reviewed','closed'].includes(v)||v.startsWith('closed')) return 'green'; if(v.includes('risk')||v==='required'||v==='target at risk'||v==='action needed'||v==='urgent') return 'red'; if(['watch','monitor','dates needed','due','important','priority','awaiting feedback','deactivated'].includes(v)) return 'amber'; return ''; };
const responsibilityLabel = r => ({ site: 'Placement site', shared: 'Shared', campus: 'Campus / institution', 'information-only': 'Information only' }[r] || r || '—');

// Single persistent form-submit dispatcher. Modals used to register a fresh
// document-level {once:true} submit listener every time they opened, which
// could be left dangling (if the modal was closed without submitting) or
// simply missing at the moment of submit, causing the browser to fall back
// to a native form submission (a full page reload) instead of saving via the
// API. Routing every submit through one permanent handler, keyed by form id,
// removes that failure mode entirely.
const FORM_HANDLERS = {};
function registerForm(id, handler) { FORM_HANDLERS[id] = handler; }
// Prompt 4: "protection against accidental double submission" + "disabled
// and loading states during requests" — applied once, centrally, to every
// registered form instead of each save* function managing its own button
// state. Buttons are re-enabled in `finally` so this works whether the
// handler closes the modal on success (buttons are simply discarded) or
// leaves it open to show an error (buttons come back usable).
document.addEventListener('submit', (e) => {
  const fn = FORM_HANDLERS[e.target && e.target.id];
  if (!fn) return;
  e.preventDefault();
  const form = e.target;
  const buttons = $$('button', form);
  if (buttons.some(b => b.disabled)) return;
  buttons.forEach(b => { b.dataset.origText = b.textContent; b.disabled = true; });
  const submitBtn = buttons[buttons.length - 1];
  if (submitBtn) submitBtn.textContent = 'Saving…';
  Promise.resolve(fn(e)).finally(() => buttons.forEach(b => { b.disabled = false; if (b.dataset.origText != null) b.textContent = b.dataset.origText; }));
});
registerForm('fIntern', e => saveIntern(e));
registerForm('fReferral', e => saveReferral(e));
registerForm('fOpening', e => saveOpeningBalance(e));
registerForm('fCase', e => saveCase(e));
registerForm('fActivity', e => saveActivity(e));
registerForm('fSup', e => saveSup(e));
registerForm('fSupReview', e => saveSupReview(e));
registerForm('fComp', e => saveComp(e));
registerForm('fHours', e => saveHours(e));
registerForm('fHoursEdit', e => saveHoursCorrection(e));
registerForm('fSchedule', e => saveSchedule(e));
registerForm('fFeedback', async e => { const b = Object.fromEntries(new FormData(e.target)); b.context_view = S.view; try { await api('feedback', { method: 'POST', body: JSON.stringify(b) }); toast('Feedback saved'); go('feedback'); } catch (x) { toast(x.message); } });

let S = { identity: null, session: null, view: 'dashboard', intern: null, preview: false, data: null, handbookSection: 0, assistantSeed: '', reportsMonth: null };

// Per-role nav labels (unchanged wording from before Prompt 6) — now grouped
// under NAV_GROUPS instead of rendered as one flat list, per Prompt 6's
// "reorganise navigation into clearer groups" requirement. A view only
// appears in the sidebar for a role if it has a label here, so role
// permissions are exactly as strict as before this refactor.
const NAV_LABELS = {
  programme_lead: { dashboard: 'Dashboard', interns: 'Interns', referrals: 'Referral tracker', progress: 'Requirements & pace', cases: 'Case workflow', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Reports', assistant: 'Practicum Assistant', programme: 'Programme evidence', handbook: 'Handbook' },
  supervisor: { dashboard: 'Dashboard', interns: 'Assigned interns', referrals: 'Referrals', progress: 'Requirements & pace', cases: 'Cases', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Reports', assistant: 'Practicum Assistant', handbook: 'Handbook' },
  intern: { dashboard: 'My placement', referrals: 'My referrals', progress: 'My requirements', cases: 'My cases', supervision: 'Supervision prep', competencies: 'My competencies', hours: 'Activity log', reports: 'My report', assistant: 'Practicum Assistant', feedback: 'Pilot feedback', handbook: 'Handbook' },
  management: { dashboard: 'Programme overview', programme: 'Programme evidence', handbook: 'Handbook' }
};
// Group order and membership per Prompt 6. A group is only rendered for a
// role if at least one of its views has a label for that role.
const NAV_GROUPS = [
  ['Operations', ['referrals', 'cases', 'hours']],
  ['Progress', ['progress', 'supervision', 'competencies']],
  ['Insights', ['dashboard', 'reports', 'programme']],
  ['Support', ['assistant', 'feedback', 'handbook']],
  ['Administration', ['interns']]
];
function navFlat(role) { return Object.keys(NAV_LABELS[role] || {}); }
const titles = { dashboard: 'Dashboard', interns: 'Interns', referrals: 'Referral tracker', progress: 'Requirements & pace', cases: 'Case workflow', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Monthly reports', assistant: 'Practicum Assistant', feedback: 'Pilot feedback', programme: 'Programme evidence', handbook: 'Practicum handbook' };

let toastTimer = null;
// Prompt 4: "an undo or soft-delete approach where practical" — for
// referral/supervision/pilot_feedback deletes (the entities restoreAudit()
// can actually re-insert verbatim), the success toast carries an Undo
// button that calls it, instead of the delete being the final word.
function toast(text, action = null) {
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.innerHTML = action ? `<span>${esc(text)}</span> <button type="button" class="toast-undo">${esc(action.label)}</button>` : esc(text);
  if (action) $('.toast-undo', el).onclick = () => { clearTimeout(toastTimer); el.classList.remove('show'); action.onClick(); };
  el.classList.add('show');
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 8000 : 2200);
}
function modal(title, html) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.add('open'); }
function closeModal() { $('#modal').classList.remove('open'); }
// Programme-lead-only admin delete. The server independently enforces
// programme_lead on every DELETE endpoint (role is derived from
// PROGRAMME_LEAD_EMAILS, not anything the client sends), so this confirm
// step is purely UX — interns/supervisors never even see these buttons,
// and could not use them if they did.
//
// Prompt 4: every confirmation now names the specific record (passed in via
// `message`, built by the caller from data already on screen — no extra
// fetch) rather than a generic "this referral"/"this case", and can capture
// an operator-supplied reason for the audit trail. `onConfirm` receives that
// reason (or undefined if no reason field was requested).
function confirmModal(title, message, onConfirm, opts = {}) {
  const reasonHtml = opts.reason ? `<div class="field" style="margin-top:10px"><label>${esc(opts.reason.label || 'Reason')}${opts.reason.required ? '' : ' (optional)'}<textarea id="confirmReason" rows="2" maxlength="500"></textarea></label></div>` : '';
  modal(title, `<p>${message}</p>${reasonHtml}<div class="full" style="display:flex;gap:10px;margin-top:14px"><button id="confirmYes" class="btn ${opts.danger === false ? 'primary' : 'danger-btn'}">${esc(opts.confirmLabel || 'Delete')}</button><button id="confirmNo" class="btn">Cancel</button></div>`);
  $('#confirmYes').onclick = async () => {
    const reason = opts.reason ? $('#confirmReason').value.trim() : undefined;
    if (opts.reason?.required && !reason) { $('#confirmReason').focus(); toast(`${opts.reason.label || 'A reason'} is required.`); return; }
    $('#confirmYes').disabled = true; $('#confirmNo').disabled = true; $('#confirmYes').textContent = 'Working…';
    await onConfirm(reason);
  };
  $('#confirmNo').onclick = closeModal;
}
// `opts.restorePath` names an endpoint (only 'audit-restore' today) that can
// undo this exact deletion; when the DELETE response carries an `audit_id`,
// the success toast offers Undo instead of just confirming the delete.
function adminDelete(path, id, label, after, opts = {}) {
  const title = opts.title || `${opts.confirmLabel || 'Delete'} this ${label}?`;
  const message = opts.message || `This permanently deletes this ${esc(label)} and cannot be undone.`;
  confirmModal(title, message, async (reason) => {
    try {
      const result = await api(`${path}?id=${id}`, { method: 'DELETE', body: JSON.stringify({ reason: reason || '' }) });
      closeModal();
      const doneLabel = opts.doneLabel || (label.charAt(0).toUpperCase() + label.slice(1) + ' deleted');
      if (opts.restorePath && result.audit_id) {
        toast(doneLabel, { label: 'Undo', onClick: async () => {
          try { await api(opts.restorePath, { method: 'POST', body: JSON.stringify({ audit_id: result.audit_id }) }); toast('Restored'); go(S.view); }
          catch (x) { toast(x.message); }
        } });
      } else toast(doneLabel);
      after();
    } catch (x) { closeModal(); toast(x.message); }
  }, { reason: opts.reason, confirmLabel: opts.confirmLabel, danger: opts.danger });
}
const roleName = r => ({ programme_lead: 'Programme Lead', supervisor: 'Supervisor', intern: 'Intern', management: 'Management' }[r] || r);
const metric = (label, value, note = '') => `<div class="card metric"><label>${label}</label><strong>${value}</strong><div class="muted">${note}</div></div>`;
const table = (headers, rows, empty = 'No records yet.') => `<div class="tablewrap"><table><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">${empty}</td></tr>`}</tbody></table></div>`;
const tag = s => `<span class="tag ${statusClass(s)}">${esc(s)}</span>`;
const progressBar = (done, target) => `<div class="progress"><span style="width:${pc(done, target)}%"></span></div>`;
function monthLabel(m) { const [y, mm] = String(m).slice(0, 7).split('-'); return new Date(Number(y), Number(mm) - 1, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' }); }
// Prompt 7: "export to an appropriate format such as CSV" — built client-side
// from the exact rows the page renders, so an export can never drift from
// what's on screen. csvCell only quotes when a value actually needs it.
function csvCell(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(rows) { return rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
function downloadCsv(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function api(path, options = {}) {
  if (S.preview) return demoApi(path, options);
  const { data: { session } } = await S.supabase.auth.getSession();
  if (!session) { location.reload(); throw Error('Your session has expired. Please sign in again.'); }
  const response = await fetch('/api/' + path, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.access_token}` },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(body.error || 'Request failed');
  return body;
}

function shell() {
  const { profile, role } = S.session;
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#me').innerHTML = `<b>${esc(profile.display_name)}</b><br>${roleName(role)}`;
  $('#role').textContent = roleName(role);
  const labels = NAV_LABELS[role] || {};
  $('#nav').innerHTML = NAV_GROUPS.map(([groupLabel, views]) => {
    const items = views.filter(v => labels[v]);
    if (!items.length) return '';
    return `<div class="navgroup" role="group" aria-label="${esc(groupLabel)}"><h4>${esc(groupLabel)}</h4>${items.map(v => `<button class="navbtn" data-view="${v}">${esc(labels[v])}</button>`).join('')}</div>`;
  }).join('');
  $$('.navbtn').forEach(b => b.onclick = () => go(b.dataset.view));
  const requested = new URLSearchParams(location.search).get('view');
  go(requested && navFlat(role).includes(requested) ? requested : 'dashboard', { fromHistory: true });
}
// Registered once at module load (not inside shell(), which can re-run
// across preview-role switches) so back/forward never accumulates duplicate
// listeners and firing go() more than once per press.
window.addEventListener('popstate', () => { if (S.session) go(new URLSearchParams(location.search).get('view') || 'dashboard', { fromHistory: true }); });

// Small skeleton placeholder shown while a view's data loads, instead of a
// bare "Loading…" card that flashes on every navigation (Prompt 6: replace
// repeated full-page loading messages with a stable, contained indicator).
function skeleton(rows = 3) {
  return `<div class="skeleton-block" aria-busy="true" aria-live="polite"><span class="sr-only">Loading…</span>${'<div class="skel-line"></div>'.repeat(rows)}</div>`;
}

async function go(view, opts = {}) {
  const role = S.session?.role;
  if (role && !navFlat(role).includes(view)) { toast('That section is not available for your role.'); view = 'dashboard'; }
  S.view = view;
  $$('.navbtn').forEach(b => {
    const isActive = b.dataset.view === view;
    b.classList.toggle('active', isActive);
    if (isActive) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#title').textContent = titles[view]; $('aside').classList.remove('open');
  if (!opts.fromHistory) { const url = new URL(location.href); if (view === 'dashboard') url.searchParams.delete('view'); else url.searchParams.set('view', view); history.pushState(null, '', url); }
  $('#content').innerHTML = skeleton();
  try {
    if (view === 'dashboard') await dashboard();
    else if (view === 'interns') await interns();
    else if (view === 'referrals') await referrals();
    else if (view === 'progress') await requirementsView();
    else if (view === 'cases') await cases();
    else if (view === 'supervision') await supervision();
    else if (view === 'competencies') await competencies();
    else if (view === 'hours') await hours();
    else if (view === 'reports') await reports();
    else if (view === 'assistant') await assistant();
    else if (view === 'feedback') await feedbackView();
    else if (view === 'programme') await programme();
    else handbook();
  } catch (e) { $('#content').innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; }
}

function activeId() { return S.session.role === 'intern' ? S.session.profile.id : S.intern?.id || 0; }
function needIntern(prefix = '') {
  if (activeId()) return true;
  $('#content').innerHTML = prefix + '<div class="notice info">Select an intern first from the Interns screen.</div>';
  return false;
}
// Single source of truth for "which intern is programme_lead/supervisor
// currently looking at", so every screen that sets or reads it stays in
// sync and the choice survives a page refresh (sessionStorage, scoped to
// the signed-in profile so switching accounts can't leak a stale pick).
function internStorageKey() { return `hub_intern_${S.session?.profile?.id ?? 'anon'}`; }
function setActiveIntern(x) {
  S.intern = x || null;
  try { x ? sessionStorage.setItem(internStorageKey(), JSON.stringify(x)) : sessionStorage.removeItem(internStorageKey()); } catch {}
}
function clearActiveIntern() { setActiveIntern(null); }
function restoreActiveIntern() {
  if (!['programme_lead', 'supervisor'].includes(S.session?.role)) return;
  try { const raw = sessionStorage.getItem(internStorageKey()); if (raw) S.intern = JSON.parse(raw); } catch {}
}
function internAttention(x) {
  const s = x?.requirement_summary || {};
  return s.at_risk_components ? 'Target at risk' : s.watch_components ? 'Watch' : 'On track';
}
// Persistent intern context bar: lets programme_lead/supervisor jump between
// interns from any of the per-intern views (instead of only via a row click
// on the Dashboard/Interns tables), and doubles as the "who am I looking at"
// identity strip. `allowAll` screens (cross-intern feeds) leave the choice
// on "All interns" until the user explicitly picks one; screens that need a
// specific intern auto-select the first one so the selector shown and the
// data loaded can never disagree (previously the browser could default the
// <select> to the first option while S.intern stayed unset, showing an
// intern in the dropdown while the page still said "Select an intern first").
async function internSwitcherHtml(opts = {}) {
  if (!['programme_lead', 'supervisor'].includes(S.session.role)) return '';
  const list = await api('interns');
  S._internList = list;
  if (!opts.allowAll && !activeId() && list.length) setActiveIntern(list[0]);
  const activeIdVal = activeId();
  const current = list.find(x => x.id == activeIdVal) || null;
  const allOpt = opts.allowAll ? `<option value="" ${!activeIdVal ? 'selected' : ''}>All interns</option>` : '';
  const opts_ = allOpt + list.map(x => `<option value="${x.id}" ${x.id == activeIdVal ? 'selected' : ''}>${esc(x.display_name)}</option>`).join('');
  const identity = current
    ? `<div class="grow"><b>${esc(current.display_name)}</b><br><small class="muted">${esc(current.institution || 'Institution not set')} · ${tag(internAttention(current))}</small></div>`
    : `<div class="grow"><b>All interns</b><br><small class="muted">No single intern selected</small></div>`;
  return `<div class="card intern-context" style="margin-bottom:14px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${identity}<label style="display:flex;align-items:center;gap:8px"><span class="muted" style="font-size:12px">Viewing</span><select id="internSwitch" style="min-width:180px">${list.length ? opts_ : '<option value="">No interns yet</option>'}</select></label></div></div>`;
}
function bindInternSwitcher() {
  const sel = $('#internSwitch');
  if (!sel) return;
  sel.onchange = () => {
    if (!sel.value) { clearActiveIntern(); go(S.view); return; }
    const found = (S._internList || []).find(i => i.id == sel.value);
    if (found) { setActiveIntern(found); go(S.view); }
  };
}
function bindGo() { $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go)); }

function requirementSummaryCard(req) {
  const s = req.summary;
  const attention = Number(s.at_risk_components||0) + Number(s.watch_components||0) + Number(s.dates_needed_components||0);
  const note = `${s.at_risk_components||0} at risk · ${s.watch_components||0} watch${s.dates_needed_components ? ` · ${s.dates_needed_components} need placement dates` : ''}`;
  return `<div class="grid metrics">
    ${metric('Formal hours', `${fmt(s.total_completed)} / ${fmt(s.total_target)}`, `${s.overall_percent ?? 0}% of programme hours`)}
    ${metric('Weeks remaining', s.weeks_remaining == null ? '—' : fmt(s.weeks_remaining), s.weeks_remaining == null ? 'Add placement end date to calculate targets' : '')}
    ${metric('Attendance', s.attendance_rate == null ? '—' : s.attendance_rate + '%', s.attendance_rate == null ? 'Will calculate from Hub bookings/attendance' : (s.session_minutes_source === 'actual average' ? `Avg ${fmt(s.average_session_minutes)} min/session` : 'More data will refine this'))}
    ${metric('Requirements needing attention', attention, note)}
  </div>`;
}

function clinicalPaceCard(req) {
  const s = req.summary;
  if (!s.clinical_component) return `<div class="card"><b>Clinical pace</b><p class="muted">No clinical counselling component is configured.</p></div>`;
  const paceStatus = s.clinical_hours_needed_per_week == null ? 'Monitor' : (s.caseload_status.includes('sufficient') ? 'On track' : s.caseload_status.includes('needed') ? 'Target at risk' : 'Monitor');
  return `<div class="card pace-card"><div class="section tight"><div><h3>Clinical pace</h3><p>${esc(s.clinical_component)}</p></div>${tag(paceStatus)}</div>
    <div class="mini-grid">
      <div><small>Recent counselling pace</small><b>${s.recent_clinical_weekly_pace == null ? '—' : fmt(s.recent_clinical_weekly_pace) + ' h/wk'}</b></div>
      <div><small>Needed counselling pace</small><b>${s.clinical_hours_needed_per_week == null ? '—' : fmt(s.clinical_hours_needed_per_week) + ' h/wk'}</b></div>
      <div><small>Equivalent sessions remaining</small><b>${s.counselling_sessions_remaining == null ? '—' : fmt(s.counselling_sessions_remaining)}</b></div>
      <div><small>Booking target</small><b>${s.bookings_needed_per_week == null ? '—' : fmt(s.bookings_needed_per_week) + '/wk'}</b></div>
      <div><small>At current pace</small><b>${s.estimated_clinical_target_date ? esc(s.estimated_clinical_target_date) : '—'}</b></div>
      <div><small>Current active cases</small><b>${s.active_cases == null ? '—' : fmt(s.active_cases)}</b></div>
    </div>
    <p class="muted">${s.weeks_remaining == null ? 'Add the official placement end date to calculate the exact weekly target.' : esc(s.caseload_status)}${s.additional_bookings_needed ? ` · approximately ${fmt(s.additional_bookings_needed)} additional bookings/week may be needed.` : ''}</p>
    <small class="muted">Historical logbook activity can establish a recent pace even before the placement end date is entered. Booking targets require actual booked-versus-attended data from the Hub.</small>
  </div>`;
}


function weeklyScheduleCard(items=[], isAdmin=false, internId=null){
  const days=['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const rows=items.map(x=>`<div class="row"><div class="grow"><b>${days[x.weekday]} · ${esc(x.title)}</b><br><small class="muted">${x.start_time?esc(String(x.start_time).slice(0,5)):''}${x.end_time?'–'+esc(String(x.end_time).slice(0,5)):''}${x.site?' · '+esc(x.site):''}${x.recurrence_note?' · '+esc(x.recurrence_note):''}</small></div>${x.activity_type?tag(x.activity_type):''}${isAdmin?`<button class="btn small danger-btn" data-del-schedule="${x.id}">Delete</button>`:''}</div>`).join('');
  return `<div class="card"><div class="section tight"><div><h3>This week</h3><p>${isAdmin?'Their real placement rhythm.':'Your real placement rhythm.'}</p></div>${isAdmin?`<button class="btn" id="editSchedule" data-intern-id="${internId}">Edit schedule</button>`:''}</div><div class="list">${rows||'No weekly schedule configured.'}</div></div>`;
}
function scheduleModal(internId){
  const days=['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const dayOpts=days.slice(1).map((d,i)=>`<option value="${i+1}">${d}</option>`).join('');
  modal('Add placement day', `<form id="fSchedule" class="formgrid"><input type="hidden" name="intern_profile_id" value="${internId}"><div class="field"><label>Day<select name="weekday" required>${dayOpts}</select></label></div><div class="field"><label>Site / placement<input name="site" placeholder="e.g. Stellenbosch Hospital" required></label></div><div class="field"><label>Title<input name="title" value="Placement day" required></label></div><div class="field"><label>Activity type<input name="activity_type" placeholder="e.g. Clinical, Campus"></label></div><div class="field"><label>Start time<input name="start_time" type="time"></label></div><div class="field"><label>End time<input name="end_time" type="time"></label></div><div class="full field"><label>Note<input name="recurrence_note" placeholder="e.g. Alternates weekly with Night Shelter"></label></div><div class="full"><button class="btn primary">Add day</button></div></form>`);
}
async function saveSchedule(e){ if(e.target.id!=='fSchedule') return; e.preventDefault(); try{ const fd=Object.fromEntries(new FormData(e.target)); await api(`pilot-context?intern_id=${fd.intern_profile_id}`, {method:'POST', body:JSON.stringify(fd)}); closeModal(); toast('Placement day added'); go('dashboard'); }catch(x){ toast(x.message); } }
function plannedActivitiesCard(items=[]){
  const rows=items.map(x=>`<div class="row"><div class="grow"><b>${esc(x.title)}</b><br><small class="muted">${x.activity_date?esc(x.activity_date):'Date to confirm'}${x.site?' · '+esc(x.site):''}${x.note?' · '+esc(x.note):''}</small></div><div style="text-align:right">${tag(x.status||'Planned')}<br><small class="muted">${x.planned_hours?fmt(x.planned_hours)+' h event':''}${x.preparation_hours?`${x.planned_hours?' + ':''}${fmt(x.preparation_hours)} h prep`:''}</small></div></div>`).join('');
  return `<div class="card"><div class="section tight"><div><h3>Planned community pipeline</h3><p>Visible for planning; not counted as completed until logged.</p></div></div><div class="list">${rows||'No planned activities yet.'}</div></div>`;
}
async function dashboard() {
  const d = await api('dashboard'), role = S.session.role;
  if (role === 'management') { await programme(); return; }
  if (role === 'intern') {
    const req = d.requirements;
    const pilot = await api(`pilot-context?intern_id=${activeId()}`);
    $('#content').innerHTML = `<div class="hero"><small>${esc(req.profile.requirement_profile_name || req.profile.institution || 'Placement')}</small><h1>Welcome, ${esc(S.session.profile.display_name || '')}.</h1><p>Your handbook, weekly plan, live requirements, supervision preparation and help when you are stuck — in one place.</p><div class="actions"><button class="btn" data-go="handbook">Open handbook</button><button class="btn" data-go="assistant">I’m stuck / ask for help</button><button class="btn" data-go="progress">Check my targets</button><button class="btn" data-go="feedback">Give pilot feedback</button></div></div>
      ${requirementSummaryCard(req)}
      <div class="grid two" style="margin-top:14px">${weeklyScheduleCard(pilot.schedule)}${plannedActivitiesCard(pilot.planned)}</div><div class="grid two" style="margin-top:14px">${clinicalPaceCard(req)}<div class="card"><h3>Current workload</h3><div class="mini-grid"><div><small>Active cases</small><b>${d.metrics.active_cases}</b></div><div><small>Open supervision items</small><b>${d.metrics.open_supervision}</b></div><div><small>Outstanding deliverables</small><b>${req.summary.outstanding_deliverables}</b></div><div><small>Expected attended sessions</small><b>${fmt(req.summary.expected_attended_sessions)}/wk</b></div></div><div class="actions dark"><button class="btn" data-go="supervision">Prepare supervision</button><button class="btn" data-go="handbook">Open handbook</button></div></div></div>`;
    bindGo(); return;
  }

  const m = d.metrics;
  const rows = (d.interns || []).map(x => {
    const s = x.requirements;
    const attention = s.at_risk_components ? 'Target at risk' : s.watch_components ? 'Watch' : 'On track';
    return `<tr class="click" data-id="${x.id}"><td><b>${esc(x.display_name)}</b><br><span class="muted">${esc(x.institution || 'Institution not set')}</span></td><td>${fmt(s.total_completed)} / ${fmt(s.total_target)}</td><td>${s.weeks_remaining == null ? '—' : fmt(s.weeks_remaining)}</td><td>${s.clinical_hours_needed_per_week == null ? '—' : fmt(s.clinical_hours_needed_per_week) + ' h/wk'}</td><td>${s.active_cases}</td><td>${tag(attention)}</td><td>${x.open_supervision}</td></tr>`;
  }).join('');
  $('#content').innerHTML = `<div class="hero"><h1>Supervise the programme before problems become end-of-placement crises.</h1><p>The dashboard now separates institutional requirements, calculates weekly pace, and flags when the current clinical allocation may be insufficient.</p><div class="actions"><button class="btn" data-go="interns">Manage interns</button><button class="btn" data-go="assistant">Open Practicum Assistant</button></div></div>
    ${queueCard(d.queue || [], d.interns || [])}
    <div class="grid metrics">${metric('Active interns', m.interns)}${metric('Interns with target risk', m.at_risk)}${metric('Active cases', m.active_cases)}${metric('Open supervision', m.open_supervision)}</div>
    <div class="section"><div><h3>Placement pace</h3><p>Click an intern to open their requirement profile.</p></div></div>${table(['Intern', 'Formal hours', 'Weeks left', 'Clinical pace needed', 'Cases', 'Requirements', 'Supervision'], rows)}`;
  $$('[data-id]').forEach(row => row.onclick = () => { setActiveIntern(d.interns.find(i => i.id == row.dataset.id)); go('progress'); });
  bindQueue(d.queue || [], d.interns || []);
  bindGo();
}

// Prompt 6: an actionable queue of items that need attention — each one
// names what is wrong and links straight to the record, rather than a bare
// metric with no next action. Built server-side in dashboard() from real
// setup gaps, overdue referrals, unreviewed reports and open supervision
// items (see buildQueue in functions/api/_handlers.js) — nothing here is
// invented client-side.
function queueCard(items, interns) {
  if (!items.length) return `<div class="card" style="margin-top:14px"><h3>Needs attention</h3><p class="queue-empty">Nothing outstanding right now.</p></div>`;
  const rows = items.map((it, i) => `<div class="queue-item sev-${esc(it.severity || '')}" data-queue-index="${i}" role="button" tabindex="0"><div class="queue-text"><b>${esc(it.title)}</b><span>${esc(it.reason)}</span></div><span class="btn small" aria-hidden="true">Review</span></div>`).join('');
  return `<div class="card" style="margin-top:14px"><h3>Needs attention (${items.length})</h3><div class="queue">${rows}</div></div>`;
}
function bindQueue(items, interns) {
  $$('[data-queue-index]').forEach(el => {
    const openItem = () => {
      const it = items[Number(el.dataset.queueIndex)];
      if (!it) return;
      if (it.intern_id) { const person = interns.find(i => i.id === it.intern_id); if (person) setActiveIntern(person); }
      go(it.view || 'dashboard');
    };
    el.onclick = openItem;
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(); } };
  });
}

async function interns() {
  const data = await api('interns');
  const isAdmin = S.session.role === 'programme_lead';
  const rows = data.map(x => {
    const s = x.requirement_summary || {};
    const attention = s.at_risk_components ? 'Target at risk' : s.watch_components ? 'Watch' : 'On track';
    return `<tr class="click" data-id="${x.id}"><td><b>${esc(x.display_name)}</b>${x.active === false ? ' ' + tag('Deactivated') : ''}<br>${esc(x.email)}</td><td>${esc(x.institution || '—')}</td><td>${fmt(s.total_completed)} / ${fmt(s.total_target || 720)}</td><td>${s.weeks_remaining == null ? '—' : fmt(s.weeks_remaining)}</td><td>${tag(attention)}</td><td>${x.active_cases}</td><td><span class="tag ${x.identity_user_id ? 'green' : 'amber'}">${x.identity_user_id ? 'Login linked' : 'No login linked'}</span></td>${isAdmin ? `<td>${x.active === false ? `<button class="btn small" data-reactivate-intern="${x.id}" data-name="${esc(x.display_name)}">Reactivate</button>` : `<button class="btn small danger-btn" data-del-intern="${x.id}" data-del-name="${esc(x.display_name)}">Deactivate</button>`}</td>` : ''}</tr>`;
  }).join('');
  $('#content').innerHTML = `<div class="section"><div><h3>Intern placements</h3><p>Institution determines the verified requirement profile automatically.</p></div>${S.session.role === 'programme_lead' ? '<button id="addIntern" class="btn primary">Add intern</button>' : ''}</div>
    ${table(['Intern', 'Institution', 'Progress', 'Weeks left', 'Pace', 'Cases', 'Account', ...(isAdmin ? ['Admin'] : [])], rows)}
    <div class="notice info" style="margin-top:12px"><b>Account setup:</b> Adding a new intern automatically sends them a Supabase sign-in invitation by email. SACAP and Cornerstone use different formal hour categories, and the Hub loads the selected profile automatically.</div>`;
  $$('[data-id]').forEach(x => x.onclick = () => { setActiveIntern(data.find(i => i.id == x.dataset.id)); go('progress'); });
  $('#addIntern')?.addEventListener('click', () => { modal('Add intern', `<form id="fIntern" class="formgrid"><div class="field"><label>Name<input name="display_name" required></label></div><div class="field"><label>Email<input name="email" type="email" required></label></div><div class="field"><label>Institution<select name="institution"><option>SACAP</option><option>Cornerstone Institute</option><option>Other</option></select></label></div><div class="field"><label>Default counselling session length (min)<input name="default_session_minutes" type="number" min="15" max="240" value="60"></label></div><div class="field"><label>Placement start<input name="placement_start" type="date"></label></div><div class="field"><label>Placement end<input name="placement_end" type="date"></label></div><div class="full"><button class="btn primary">Create placement</button></div></form>`); });
  $$('[data-del-intern]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    adminDelete('interns', b.dataset.delIntern, `placement for ${b.dataset.delName}`, () => go('interns'), {
      confirmLabel: 'Deactivate',
      title: `Deactivate the placement for ${esc(b.dataset.delName)}?`,
      message: `${esc(b.dataset.delName)} will no longer be able to sign in or appear in active lists. Their cases, hours, supervision and report history are kept and stay visible to programme staff — you can reactivate this placement from this screen at any time.`,
      doneLabel: `${b.dataset.delName}’s placement deactivated`,
      reason: { required: true, label: 'Reason for deactivating' }
    });
  }));
  $$('[data-reactivate-intern]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    confirmModal(`Reactivate the placement for ${esc(b.dataset.name)}?`, `${esc(b.dataset.name)} will be able to sign in again and reappear in active lists.`, async () => {
      try { await api('interns', { method: 'PATCH', body: JSON.stringify({ id: b.dataset.reactivateIntern, action: 'reactivate' }) }); closeModal(); toast(`${b.dataset.name}’s placement reactivated`); go('interns'); }
      catch (x) { closeModal(); toast(x.message); }
    }, { confirmLabel: 'Reactivate', danger: false });
  }));
}
async function saveIntern(e) { if (e.target.id !== 'fIntern') return; e.preventDefault(); try { const created = await api('interns', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); setActiveIntern(created); closeModal(); toast(created.invite?.sent ? 'Placement created · invite email sent' : created.invite && !created.invite.sent ? `Placement created, but the invite email failed: ${created.invite.reason || 'unknown error'}` : 'Placement updated'); go('interns'); } catch (x) { toast(x.message); } }

const REFERRAL_STATUSES = ['Allocated','Contact attempted','Contact made','Booked','Intake completed','Active','Awaiting feedback','Closed – completed','Closed – no contact','Reallocated'];
const SITES = ['Stellenbosch Hospital','Stellenbosch Hospital OPD','Cloetesville CDC','Groendal Clinic','Khayamandi Clinic','Klapmuts Clinic','Idas Valley Clinic','Don & Pat Clinic','Jamestown Clinic','Night Shelter','SACAP campus','Cornerstone campus'];
const siteOptions = (selected = '') => `<option value="">Select a site…</option>` + SITES.map(s => `<option ${s === selected ? 'selected' : ''}>${s}</option>`).join('') + `<option value="__other__" ${selected && !SITES.includes(selected) ? 'selected' : ''}>Other (type below)</option>`;
const siteOtherField = (selected = '') => `<div class="field site-other${selected && !SITES.includes(selected) ? '' : ' hidden'}"><label>Other site name<input name="site_other" maxlength="120" value="${esc(selected && !SITES.includes(selected) ? selected : '')}"></label></div>`;
function bindSiteToggle(form){const sel=form.querySelector('select[name="site"]');if(!sel)return;const other=form.querySelector('.site-other');const sync=()=>other?.classList.toggle('hidden',sel.value!=='__other__');sel.addEventListener('change',sync);sync();}
function resolveSite(item){if(item.site==='__other__'){item.site=(item.site_other||'').trim();}delete item.site_other;return item;}
const PRESENTING_CATEGORIES = ['Anxiety','Depression / low mood','Trauma / PTSD','Grief / bereavement','Substance use','Relationship / family','Child / adolescent behavioural','Psychosis / severe mental illness','Risk / suicidality','Adjustment / stress-related'];
const presentingCategoryOptions = (selected = '') => `<option value="">Select a category…</option>` + PRESENTING_CATEGORIES.map(c => `<option ${c === selected ? 'selected' : ''}>${c}</option>`).join('') + `<option value="__other__" ${selected && !PRESENTING_CATEGORIES.includes(selected) ? 'selected' : ''}>Other (type below)</option>`;
const presentingCategoryOtherField = (selected = '') => `<div class="field pc-other${selected && !PRESENTING_CATEGORIES.includes(selected) ? '' : ' hidden'}"><label>Other presenting category<input name="presenting_category_other" maxlength="120" value="${esc(selected && !PRESENTING_CATEGORIES.includes(selected) ? selected : '')}"></label></div>`;
function bindPresentingCategoryToggle(form){const sel=form.querySelector('select[name="presenting_category"]');if(!sel)return;const other=form.querySelector('.pc-other');const sync=()=>other?.classList.toggle('hidden',sel.value!=='__other__');sel.addEventListener('change',sync);sync();}
function resolvePresentingCategory(item){if(item.presenting_category==='__other__'){item.presenting_category=(item.presenting_category_other||'').trim();}delete item.presenting_category_other;return item;}
const REFERRAL_UPDATE_CATEGORIES = ['Attempted contact – no response','Contact made – booking pending','Appointment booked','Attended – intake completed','No-show','Re-referred / closed','Awaiting supervisor feedback','Other – see note'];
const referralUpdateCategoryOptions = (selected = '') => `<option value="">Select an update…</option>` + REFERRAL_UPDATE_CATEGORIES.map(c => `<option ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
async function referrals() {
  const own = S.session.role === 'intern', query = own ? 'referrals' : (S.intern?.id ? `referrals?intern_id=${S.intern.id}` : 'referrals');
  const [data, internsData] = await Promise.all([api(query), own ? Promise.resolve([]) : api('interns')]);
  const open = data.filter(x => !String(x.status).startsWith('Closed')).length;
  const overdue = data.filter(x => x.next_action_date && x.next_action_date < today() && !String(x.status).startsWith('Closed')).length;
  const isAdmin = S.session.role === 'programme_lead';
  const rows = data.map(x => `<tr><td><b>${esc(x.referral_code)}</b></td>${own?'':`<td>${esc(x.intern_name)}</td>`}<td>${esc(x.referral_date)}</td><td>${esc(x.referral_source||'—')}</td><td>${esc(x.site||'—')}</td><td>${esc(x.presenting_category||'—')}</td><td>${tag(x.priority)}</td><td>${tag(x.status)}</td><td>${x.contact_attempts}</td><td>${x.next_action_date?esc(x.next_action_date):'—'}</td><td>${x.update_category?tag(x.update_category):'—'}${x.last_update?`<br><small class="muted">${esc(x.last_update)}</small>`:''}</td><td><button class="btn small" data-referral-update="${x.id}">Update</button>${isAdmin?` <button class="btn small danger-btn" data-del-referral="${x.id}" data-code="${esc(x.referral_code)}">Delete</button>`:''}</td></tr>`).join('');
  $('#content').innerHTML = `<div class="hero"><small>De-identified workflow</small><h1>${own?'Track the referrals allocated to you.':'See what happened after each referral was allocated.'}</h1><p>Record contact progress, booking, intake and closure so referrals do not disappear from view.</p><div class="actions"><button id="addReferral" class="btn">Add referral</button></div></div>
    <div class="grid metrics">${metric('Open referrals',open)}${metric('Overdue next actions',overdue)}${metric('Total tracked',data.length)}${metric('Awaiting feedback',data.filter(x=>x.status==='Awaiting feedback').length)}</div>
    <div class="section"><div><h3>${own?'My referral list':S.intern?esc(S.intern.display_name)+' · referrals':'All intern referrals'}</h3><p>Status and a short operational update are visible to the intern and supervisor.</p></div></div>
    ${table(['Code',...(own?[]:['Intern']),'Allocated','Source','Site','Category','Priority','Status','Attempts','Next action','Latest update',''],rows,'No referrals have been added yet.')}
    <div class="notice info" style="margin-top:12px">Do not enter patient names, ID numbers, phone numbers, addresses or clinical narrative. Keep clinical documentation in the approved patient record.</div>`;
  $('#addReferral').onclick=()=>referralModal(null,internsData);
  $$('[data-referral-update]').forEach(b=>b.onclick=()=>referralModal(data.find(x=>x.id==b.dataset.referralUpdate),internsData));
  $$('[data-del-referral]').forEach(b=>b.onclick=()=>adminDelete('referrals', b.dataset.delReferral, `referral ${b.dataset.code}`, () => go('referrals'), {
    message: `This permanently deletes referral ${esc(b.dataset.code)} unless undone. It can be restored from the confirmation toast right after deleting.`,
    reason: { required: false, label: 'Reason (optional)' },
    restorePath: 'audit-restore'
  }));
}
function referralModal(item, internsData) {
  const isEdit=!!item, own=S.session.role==='intern';
  const internOptions=internsData.map(x=>`<option value="${x.id}" ${item?.intern_profile_id==x.id?'selected':''}>${esc(x.display_name)}</option>`).join('');
  modal(isEdit?'Update referral':'Add referral',`<form id="fReferral" class="formgrid">${isEdit?`<input type="hidden" name="id" value="${item.id}">`:''}
    ${!own&&!isEdit?`<div class="field"><label>Intern<select name="intern_profile_id" required><option value="">Select intern</option>${internOptions}</select></label></div>`:''}
    ${!isEdit?`<div class="field"><label>De-identified referral code<input name="referral_code" placeholder="e.g. EG-024" maxlength="50" required></label></div><div class="field"><label>Date allocated<input name="referral_date" type="date" value="${today()}" required></label></div><div class="field"><label>Referral source<select name="referral_source"><option>CAReS</option><option>Tuesday allocation</option><option>Social worker</option><option>Inpatient team</option><option>Clinic</option><option>Other</option></select></label></div><div class="field"><label>Site<select name="site">${siteOptions()}</select></label></div>${siteOtherField()}<div class="field"><label>Presenting category<select name="presenting_category">${presentingCategoryOptions()}</select></label></div>${presentingCategoryOtherField()}`:''}
    <div class="field"><label>Priority<select name="priority">${['Routine','Priority','Urgent'].map(x=>`<option ${item?.priority===x?'selected':''}>${x}</option>`).join('')}</select></label></div>
    <div class="field"><label>Status<select name="status">${REFERRAL_STATUSES.map(x=>`<option ${item?.status===x?'selected':''}>${x}</option>`).join('')}</select></label></div>
    <div class="field"><label>Contact attempts<input name="contact_attempts" type="number" min="0" max="100" value="${item?.contact_attempts||0}"></label></div><div class="field"><label>Next action date<input name="next_action_date" type="date" value="${item?.next_action_date||''}"></label></div>
    <div class="full field"><label>Operational update<select name="update_category">${referralUpdateCategoryOptions(item?.update_category||'')}</select></label></div>
    <div class="full"><label>Additional detail (optional)<textarea name="last_update" maxlength="1000" placeholder="e.g. Appointment booked for 22 September">${esc(item?.last_update||'')}</textarea></label></div><div class="full"><button class="btn primary">${isEdit?'Save update':'Add referral'}</button></div></form>`);
    bindSiteToggle($('#fReferral'));
    bindPresentingCategoryToggle($('#fReferral'));
}
async function saveReferral(e){if(e.target.id!=='fReferral')return;e.preventDefault();const item=resolvePresentingCategory(resolveSite(Object.fromEntries(new FormData(e.target))));try{await api('referrals',{method:item.id?'PATCH':'POST',body:JSON.stringify(item)});closeModal();toast(item.id?'Referral updated':'Referral added');go('referrals');}catch(x){toast(x.message);}}

async function requirementsView() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), req = await api(`requirements?intern_id=${id}`), s = req.summary;
  const canSetOpening = S.session.role !== 'intern' && S.session.role !== 'management';
  const isAdmin = S.session.role === 'programme_lead';
  const pilot = S.session.role !== 'management' ? await api(`pilot-context?intern_id=${id}`) : null;
  const rows = req.components.filter(x => x.calculation_mode !== 'deliverable').map(x => `<tr><td><b>${esc(x.name)}</b><br><span class="muted">${responsibilityLabel(x.responsibility)}</span></td><td>${fmt(x.completed)} / ${fmt(x.target_hours)}${x.opening_balance ? `<br><small class="muted">Opening balance: ${fmt(x.opening_balance)} h</small>` : ''}</td><td>${progressBar(x.completed, x.target_hours)}<small>${pc(x.completed, x.target_hours)}%</small></td><td>${fmt(x.remaining)}</td><td>${x.needed_per_week == null ? '—' : fmt(x.needed_per_week) + ' h/wk'}</td><td>${x.projected_completion == null ? '—' : fmt(x.projected_completion)}</td><td>${tag(x.status)}</td>${canSetOpening ? `<td><button class="btn small" data-opening="${x.id}">Opening balance</button></td>` : ''}</tr>`).join('');
  const deliverables = req.components.filter(x => x.calculation_mode === 'deliverable');
  $('#content').innerHTML = switcherHtml + `<div class="hero"><small>${esc(req.profile.requirement_profile_name || '')}</small><h1>${S.session.role === 'intern' ? 'Your requirement profile' : esc(req.profile.display_name) + ' · requirement profile'}</h1><p>The 720-hour programme is broken into the categories required by the intern’s institution. Campus/institution components remain visible without making the placement site responsible for producing them.</p><div class="actions"><button class="btn" data-go="hours">Log non-session activity</button><button class="btn" data-go="cases">Record counselling activity</button><button class="btn" data-go="assistant">Ask about my progress</button></div></div>
    ${requirementSummaryCard(req)}
    ${s.source_audit ? `<div class="notice amber" style="margin-top:14px"><b>Imported logbook audit:</b> The institutional sheet displays <b>${fmt(s.source_audit.sheet_displayed_total)} h</b>, while <b>${fmt(s.source_audit.evidence_backed_total)} h</b> is currently supported by student-signed rows. <b>${fmt(s.source_audit.unconfirmed_prefilled_hours)} h</b> appears in pre-filled rows without the student signature and has not been counted as completed in this pilot. ${s.source_audit.data_quality_note ? esc(s.source_audit.data_quality_note) : ''}</div>` : ''}
    ${pilot ? `<div style="margin-top:14px">${weeklyScheduleCard(pilot.schedule, isAdmin, id)}</div>` : ''}
    <div class="grid two" style="margin-top:14px">${clinicalPaceCard(req)}<div class="card"><h3>How the target works</h3><p>Remaining hours ÷ remaining placement weeks gives the weekly pace required. Counselling is translated into equivalent attended sessions and a booking target adjusted for the intern’s actual attendance rate.</p><p class="muted">Individual counselling activity is derived from attended case sessions and their duration. This avoids logging the same clinical time twice.</p>${canSetOpening ? '<p class="muted">For interns already mid-placement, use <b>Opening balance</b> once to carry across hours already completed in their institutional logbook. New Hub activity is then added from that point forward.</p>' : ''}</div></div>
    <div class="section"><div><h3>Formal requirements</h3><p>Verified SACAP / Cornerstone categories.</p></div></div>${table(['Requirement', 'Completed', 'Progress', 'Remaining', 'Needed / week', 'Projected', 'Status', ...(canSetOpening ? ['Existing hours'] : [])], rows)}
    ${deliverables.length ? `<div class="section"><div><h3>Required deliverables</h3><p>Tracked as completion tasks rather than invented hour values.</p></div></div><div class="card list">${deliverables.map(d => `<div class="row"><div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${responsibilityLabel(d.responsibility)}</small></div><select data-deliverable="${d.id}"><option ${d.deliverable_status === 'Not started' ? 'selected' : ''}>Not started</option><option ${d.deliverable_status === 'In progress' ? 'selected' : ''}>In progress</option><option ${d.deliverable_status === 'Complete' ? 'selected' : ''}>Complete</option></select></div>`).join('')}</div>` : ''}
    <div class="notice info" style="margin-top:14px"><b>Verified requirement profile:</b> ${esc(req.profile.requirement_profile_name || 'Generic')}. Hour targets are based on the supplied 2026 source material. Site/shared/campus responsibility labels are operational programme classifications and can be adjusted if the institutions specify a different split.</div>`;
  bindGo();
  bindInternSwitcher();
  $$('[data-deliverable]').forEach(sel => sel.onchange = async () => { await api('requirements', { method: 'PATCH', body: JSON.stringify({ intern_profile_id: id, component_id: +sel.dataset.deliverable, status: sel.value }) }); toast('Deliverable updated'); });
  $$('[data-opening]').forEach(btn => btn.onclick = () => openingBalanceModal(req.components.find(x => x.id == btn.dataset.opening), id));
  $('#editSchedule')?.addEventListener('click', () => scheduleModal(id));
  $$('[data-del-schedule]').forEach(b => b.onclick = () => adminDelete('pilot-context', b.dataset.delSchedule, 'placement day', () => go('progress')));
}
function openingBalanceModal(component, id) {
  modal('Existing hours · ' + component.name, `<form id="fOpening"><input type="hidden" name="intern_profile_id" value="${id}"><input type="hidden" name="component_id" value="${component.id}"><input type="hidden" name="action" value="opening_balance"><div class="field"><label>Hours already completed before Hub tracking<input name="hours" type="number" min="0" max="2000" step="0.25" value="${component.opening_balance || 0}" required></label></div><div class="field"><label>Source / note<textarea name="note">${esc(component.opening_balance_note || 'Opening balance from existing institutional logbook')}</textarea></label></div><div class="notice info">Use this once when bringing an existing intern into the Hub. It contributes to total progress but is not counted as activity in the current month.</div><button class="btn primary">Save opening balance</button></form>`);
  }
async function saveOpeningBalance(e) {
  if (e.target.id !== 'fOpening') return;
  e.preventDefault();
  try {
    await api('requirements', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    closeModal(); toast('Opening balance saved'); go('progress');
  } catch (x) { toast(x.message); }
}

async function cases() {
  const switcherHtml = await internSwitcherHtml({ allowAll: true });
  const id = activeId(), query = id ? `cases?intern_id=${id}` : 'cases', data = await api(query);
  const canPlan = ['programme_lead', 'supervisor'].includes(S.session.role);
  const isAdmin = S.session.role === 'programme_lead';
  const rows = data.map(x => `<tr><td><b>${esc(x.case_code)}</b></td><td>${esc(x.site)}</td>${id ? '' : `<td>${esc(x.intern_name)}</td>`}<td>${esc(x.presenting_category || '—')}</td><td>${x.sessions}</td><td>${canPlan ? `<select data-frequency="${x.id}"><option value="1" ${Number(x.planned_frequency_weeks) === 1 ? 'selected' : ''}>Weekly</option><option value="2" ${Number(x.planned_frequency_weeks) === 2 ? 'selected' : ''}>Fortnightly</option><option value="4" ${Number(x.planned_frequency_weeks) === 4 ? 'selected' : ''}>Monthly</option></select>` : ({1:'Weekly',2:'Fortnightly',4:'Monthly'}[Number(x.planned_frequency_weeks)] || `Every ${fmt(x.planned_frequency_weeks)} weeks`)}</td><td>${tag(x.supervision_status)}</td><td><select data-status="${x.id}">${['Allocated', 'Contact attempted', 'Booked', 'Intake', 'Active', 'Exit review', 'Exited'].map(s => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td><button class="btn" data-act="${x.id}">Record session</button></td>${isAdmin ? `<td><button class="btn small danger-btn" data-del-case="${x.id}" data-code="${esc(x.case_code)}" data-sessions="${x.sessions}">Delete</button></td>` : ''}</tr>`).join('');
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>${S.session.role === 'intern' ? 'My cases' : id ? esc(S.intern.display_name) + ' · cases' : 'All cases'}</h3><p>De-identified workflow. Frequency feeds the caseload adequacy calculation.</p></div>${['programme_lead', 'supervisor'].includes(S.session.role) && id ? '<button id="addCase" class="btn primary">Allocate case</button>' : ''}</div>
    ${table(['Case code', 'Site', ...(id ? [] : ['Intern']), 'Category', 'Sessions', 'Planned frequency', 'Supervision', 'Status', 'Activity', ...(isAdmin ? ['Admin'] : [])], rows)}
    <div class="notice info" style="margin-top:12px">Individual counselling hours are calculated from attended session duration. Do not enter patient names, ID numbers, phone numbers, addresses or narrative clinical notes.</div>`;
  bindInternSwitcher();
  $$('[data-status]').forEach(sel => sel.onchange = async () => { await api('cases', { method: 'PATCH', body: JSON.stringify({ id: +sel.dataset.status, status: sel.value }) }); toast('Status updated'); });
  $$('[data-frequency]').forEach(sel => sel.onchange = async () => { await api('cases', { method: 'PATCH', body: JSON.stringify({ id: +sel.dataset.frequency, planned_frequency_weeks: +sel.value }) }); toast('Frequency updated'); });
  $$('[data-act]').forEach(b => b.onclick = () => activityModal(data.find(x => x.id == b.dataset.act)));
  $$('[data-del-case]').forEach(b => b.onclick = () => {
    const sessions = Number(b.dataset.sessions || 0);
    adminDelete('cases', b.dataset.delCase, `case ${b.dataset.code}`, () => go('cases'), {
      message: `This permanently deletes case ${esc(b.dataset.code)}${sessions ? ` and its ${sessions} recorded session${sessions === 1 ? '' : 's'}` : ''}. This cannot be undone.`,
      reason: { required: true, label: 'Reason for deleting' }
    });
  });
  $('#addCase')?.addEventListener('click', () => { modal('Allocate de-identified case', `<form id="fCase" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Case code<input name="case_code" placeholder="KHC-026" required></label></div><div class="field"><label>Site<select name="site" required>${siteOptions()}</select></label></div>${siteOtherField()}<div class="field"><label>Presenting category<select name="presenting_category">${presentingCategoryOptions()}</select></label></div>${presentingCategoryOtherField()}<div class="field"><label>Planned frequency<select name="planned_frequency_weeks"><option value="1">Weekly</option><option value="2">Fortnightly</option><option value="4">Monthly</option></select></label></div><div class="full"><button class="btn primary">Allocate</button></div></form>`); bindSiteToggle($('#fCase')); bindPresentingCategoryToggle($('#fCase')); });
}
async function saveCase(e) { if (e.target.id !== 'fCase') return; e.preventDefault(); try { await api('cases', { method: 'POST', body: JSON.stringify(resolvePresentingCategory(resolveSite(Object.fromEntries(new FormData(e.target))))) }); closeModal(); toast('Case allocated'); go('cases'); } catch (x) { toast(x.message); } }
function activityModal(c) { modal('Record counselling activity · ' + c.case_code, `<form id="fActivity" class="formgrid"><input type="hidden" name="intern_profile_id" value="${c.intern_profile_id}"><input type="hidden" name="case_id" value="${c.id}"><div class="field"><label>Date<input name="encounter_date" type="date" value="${today()}" required></label></div><div class="field"><label>Session<select name="session_type"><option>Intake</option><option>Follow-up</option><option>Termination</option></select></label></div><div class="field"><label>Booked<select name="booked"><option value="true">Yes</option><option value="false">No</option></select></label></div><div class="field"><label>Attended<select name="attended"><option value="true">Yes</option><option value="false">No</option></select></label></div><div class="field"><label>Duration if attended (minutes)<input name="duration_minutes" type="number" min="1" max="480" value="60"></label></div><div class="field"><label>Gender for monthly statistics<select name="patient_gender"><option>Female</option><option>Male</option><option>Other</option><option>Unknown</option></select></label></div><div class="full"><button class="btn primary">Save activity</button></div></form>`); }
async function saveActivity(e) { if (e.target.id !== 'fActivity') return; e.preventDefault(); try { await api('encounters', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Session recorded'); go('cases'); } catch (x) { toast(x.message); } }

// §4 gap fix: when a programme_lead/supervisor hasn't picked an intern from
// the switcher, show the cross-intern feed instead of just "select an
// intern first" — there was previously no bird's-eye view of open
// supervision items across the whole programme at all.
async function supervisionAllView(switcherHtml) {
  const data = await api('supervision-feed');
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>All interns · supervision</h3><p>Open and recently reviewed supervision items across every intern you can see.</p></div></div><div class="card list">${data.map(x => `<div class="row"><div class="grow"><b>${esc(x.intern_name)}</b> · <b>${esc(x.topic)}</b> ${x.case_code ? `<span class="tag">${esc(x.case_code)}</span>` : ''}<br><span>${esc(x.question)}</span>${x.supervisor_note ? `<br><small><b>Supervisor:</b> ${esc(x.supervisor_note)}</small>` : ''}</div>${tag(x.priority)} ${tag(x.status)}</div>`).join('') || 'No supervision items yet.'}</div>`;
  bindInternSwitcher();
}
async function supervision() {
  const switcherHtml = await internSwitcherHtml({ allowAll: true });
  if (!activeId()) {
    if (['programme_lead', 'supervisor'].includes(S.session.role)) return supervisionAllView(switcherHtml);
    if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  }
  const id = activeId(), data = await api(`supervision?intern_id=${id}`), isIntern = S.session.role === 'intern', isAdmin = S.session.role === 'programme_lead';
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>${isIntern ? 'Prepare for supervision' : esc(S.intern?.display_name || '') + ' · supervision'}</h3><p>Turn uncertainty into a specific supervision question before the session.</p></div><button id="addSup" class="btn primary">Add supervision item</button></div><div class="card list">${data.map(x => `<div class="row"><div class="grow"><b>${esc(x.topic)}</b> ${x.case_code ? `<span class="tag">${esc(x.case_code)}</span>` : ''}<br><span>${esc(x.question)}</span>${x.action_taken ? `<br><small class="muted">Already tried: ${esc(x.action_taken)}</small>` : ''}${x.supervisor_note ? `<br><small><b>Supervisor:</b> ${esc(x.supervisor_note)}</small>` : ''}</div>${tag(x.priority)} ${tag(x.status)}${!isIntern && x.status === 'Open' ? `<button class="btn" data-review="${x.id}">Review</button>` : ''}${isAdmin ? `<button class="btn small danger-btn" data-del-sup="${x.id}" data-topic="${esc(x.topic)}">Delete</button>` : ''}</div>`).join('') || 'No supervision items.'}</div>`;
  bindInternSwitcher();
  $('#addSup').onclick = () => supervisionModal(id);
  $$('[data-review]').forEach(b => b.onclick = () => { const x = data.find(i => i.id == b.dataset.review); modal('Review supervision item', `<form id="fSupReview"><input type="hidden" name="id" value="${x.id}"><div class="field"><label>Supervisor response<textarea name="supervisor_note">${esc(x.supervisor_note || '')}</textarea></label></div><div class="field"><label>Status<select name="status"><option>Open</option><option selected>Reviewed</option><option>Closed</option></select></label></div><button class="btn primary">Save</button></form>`); });
  $$('[data-del-sup]').forEach(b => b.onclick = () => adminDelete('supervision', b.dataset.delSup, `supervision item “${b.dataset.topic}”`, () => go('supervision'), {
    message: `This permanently deletes the supervision item “${esc(b.dataset.topic)}” unless undone. It can be restored from the confirmation toast right after deleting.`,
    reason: { required: false, label: 'Reason (optional)' },
    restorePath: 'audit-restore'
  }));
}
function supervisionModal(id, preset = {}) { modal('Add to supervision', `<form id="fSup" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Topic<input name="topic" value="${esc(preset.topic || '')}" required></label></div><div class="field"><label>Priority<select name="priority"><option>Routine</option><option>Important</option><option>Risk / urgent</option></select></label></div><div class="full field"><label>What exactly are you unsure about?<textarea name="question" required>${esc(preset.question || '')}</textarea></label></div><div class="full field"><label>What have you already considered / tried?<textarea name="action_taken">${esc(preset.action_taken || '')}</textarea></label></div><div class="full"><button class="btn primary">Add to supervision</button></div></form>`); }
async function saveSup(e) { if (e.target.id !== 'fSup') return; e.preventDefault(); try { await api('supervision', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Added to supervision'); if (S.view === 'supervision') go('supervision'); } catch (x) { toast(x.message); } }
async function saveSupReview(e) { if (e.target.id !== 'fSupReview') return; e.preventDefault(); try { await api('supervision', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Supervision updated'); go('supervision'); } catch (x) { toast(x.message); } }

async function competencies() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), data = await api(`competencies?intern_id=${id}`), isIntern = S.session.role === 'intern';
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>${isIntern ? 'My competency development' : 'Competency development'}</h3><p>Ratings are supported by evidence and supervisor feedback.</p></div></div><div class="grid three">${data.map(x => `<div class="card competency"><b>${esc(x.name)}</b><p class="muted">${esc(x.description)}</p><div class="rating"><span>Intern</span><b>${x.intern_rating || '—'} / 5</b><span>Supervisor</span><b>${x.supervisor_rating || '—'} / 5</b></div>${x.evidence ? `<p><small><b>Evidence:</b> ${esc(x.evidence)}</small></p>` : ''}${x.supervisor_comment ? `<p><small><b>Feedback:</b> ${esc(x.supervisor_comment)}</small></p>` : ''}<button class="btn" data-comp="${x.id}">${isIntern ? 'Update reflection' : 'Assess / feedback'}</button></div>`).join('')}</div>`;
  bindInternSwitcher();
  $$('[data-comp]').forEach(b => b.onclick = () => competencyModal(data.find(x => x.id == b.dataset.comp), id, isIntern));
}
function competencyModal(x, id, isIntern) { modal(x.name, `<form id="fComp"><input type="hidden" name="intern_profile_id" value="${id}"><input type="hidden" name="competency_id" value="${x.id}">${isIntern ? `<div class="field"><label>Self-rating (1–5)<input name="intern_rating" type="number" min="1" max="5" value="${x.intern_rating || ''}"></label></div><div class="field"><label>Evidence / example<textarea name="evidence">${esc(x.evidence || '')}</textarea></label></div>` : `<div class="field"><label>Supervisor rating (1–5)<input name="supervisor_rating" type="number" min="1" max="5" value="${x.supervisor_rating || ''}"></label></div><div class="field"><label>Feedback / development focus<textarea name="supervisor_comment">${esc(x.supervisor_comment || '')}</textarea></label></div>`}<button class="btn primary">Save</button></form>`); }
async function saveComp(e) { if (e.target.id !== 'fComp') return; e.preventDefault(); try { await api('competencies', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Competency updated'); go('competencies'); } catch (x) { toast(x.message); } }

// §4 gap fix: combined activity feed across all interns, same rationale as
// supervisionAllView above.
async function hoursAllView(switcherHtml) {
  const data = await api('hours-feed');
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>All interns · activity log</h3><p>Recently logged non-counselling activity across every intern you can see.</p></div></div><div class="card list">${data.map(x => `<div class="row"><div class="grow"><b>${esc(x.intern_name)}</b> · ${esc(x.component_name || x.category)}<br><small class="muted">${esc(x.work_date)}${x.note ? ' · ' + esc(x.note) : ''}</small></div><b>${fmt(x.hours)} h</b></div>`).join('') || 'No activity logged yet.'}</div>`;
  bindInternSwitcher();
}
async function hours() {
  const switcherHtml = await internSwitcherHtml({ allowAll: true });
  if (!activeId() && ['programme_lead', 'supervisor'].includes(S.session.role)) return hoursAllView(switcherHtml);
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), [data, req] = await Promise.all([api(`hours?intern_id=${id}`), api(`requirements?intern_id=${id}`)]);
  const opts = data.components.map(c => `<option value="${esc(c.code)}">${esc(c.manual_label || c.name)}</option>`).join('');
  const isAdmin = S.session.role === 'programme_lead';
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>Activity log</h3><p>Log non-individual counselling activities directly against the institution’s formal categories.</p></div><button id="logHours" class="btn primary">Log activity hours</button></div>
    <div class="grid two"><div class="notice info"><b>Individual counselling is automatic.</b><br>Attended case sessions and their duration feed the counselling requirement. Do not log those hours again here.</div><div class="card"><b>${esc(req.profile.requirement_profile_name || '')}</b><p class="muted">${fmt(req.summary.total_completed)} of ${fmt(req.summary.total_target)} formal hours currently recorded.</p>${progressBar(req.summary.total_completed, req.summary.total_target)}</div></div>
    <div class="section"><h3>Recent activity</h3></div><div class="card list">${data.entries.map(x => `<div class="row"><div class="grow"><b>${esc(x.component_name || x.category)}</b><br><small class="muted">${esc(x.work_date)}${x.note ? ' · ' + esc(x.note) : ''}</small></div><b>${fmt(x.hours)} h</b>${isAdmin ? `<button class="btn small" data-edit-hours="${x.id}">Edit</button> <button class="btn small danger-btn" data-del-hours="${x.id}">Delete</button>` : ''}</div>`).join('') || 'No manually logged activity yet.'}</div>`;
  bindInternSwitcher();
  $('#logHours').onclick = () => modal('Log practicum activity', `<form id="fHours" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="full field"><label>Formal requirement<select name="component_code" required>${opts}</select></label></div><div class="field"><label>Date<input name="work_date" type="date" value="${today()}" required></label></div><div class="field"><label>Hours<input name="hours" type="number" min="0.25" max="24" step="0.25" required></label></div><div class="full field"><label>Brief description<textarea name="note" placeholder="No patient-identifying information"></textarea></label></div><div class="full"><button class="btn primary">Save hours</button></div></form>`);
  // Prompt 4: "a correction workflow for logged hours rather than silent
  // destructive deletion" — Edit updates the entry in place (with a
  // mandatory reason, audited as a before/after pair) instead of requiring
  // programme_lead to delete and re-create it.
  $$('[data-edit-hours]').forEach(b => b.onclick = () => {
    const x = data.entries.find(e => e.id == b.dataset.editHours);
    modal('Correct activity entry', `<form id="fHoursEdit" class="formgrid"><input type="hidden" name="id" value="${x.id}"><div class="full field"><label>Formal requirement<select name="component_code" required>${data.components.map(c => `<option value="${esc(c.code)}" ${c.code === x.component_code ? 'selected' : ''}>${esc(c.manual_label || c.name)}</option>`).join('')}</select></label></div><div class="field"><label>Date<input name="work_date" type="date" value="${esc(x.work_date)}" required></label></div><div class="field"><label>Hours<input name="hours" type="number" min="0.25" max="24" step="0.25" value="${x.hours}" required></label></div><div class="full field"><label>Brief description<textarea name="note" placeholder="No patient-identifying information">${esc(x.note || '')}</textarea></label></div><div class="full field"><label>Reason for this correction<textarea name="reason" required placeholder="e.g. wrong category selected, date entered incorrectly"></textarea></label></div><div class="full"><button class="btn primary">Save correction</button></div></form>`);
  });
  $$('[data-del-hours]').forEach(b => b.onclick = () => adminDelete('hours', b.dataset.delHours, 'activity entry', () => go('hours'), {
    message: 'This permanently deletes this logged activity entry. This cannot be undone — for a wrong category, date or hours value, use Edit instead.',
    reason: { required: true, label: 'Reason for deleting' }
  }));
}
async function saveHours(e) { if (e.target.id !== 'fHours') return; e.preventDefault(); try { await api('hours', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Activity saved'); go('hours'); } catch (x) { toast(x.message); } }
async function saveHoursCorrection(e) { if (e.target.id !== 'fHoursEdit') return; e.preventDefault(); try { await api('hours', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Activity entry corrected'); go('hours'); } catch (x) { toast(x.message); } }

// Prompt 7: builds the CSV export from exactly the rows/fields the page
// renders (never a separate recomputation), so an exported total can always
// be reconciled against what's on screen and, from there, against the
// source records the server derived it from.
function buildReportCsv(internName, selectedMonth, s, hoursRows, corrections) {
  const rows = [
    ['Monthly report', `${internName || 'Intern'} — ${monthLabel(selectedMonth)}`],
    [],
    ['Metric', 'Value', 'Definition'],
    ['Booked', s.booked || 0, 'Sessions scheduled this month'],
    ['Attended', s.attended || 0, 'Of those, recorded as attended'],
    ['Pending (booked, not yet attended)', Math.max(0, (s.booked || 0) - (s.attended || 0)), 'No attendance outcome recorded yet'],
    ['Female', s.female || 0, 'Attended sessions, patient sex/gender recorded as Female'],
    ['Male', s.male || 0, 'Attended sessions, patient sex/gender recorded as Male'],
    ['Other', s.other_gender || 0, 'Attended sessions, patient sex/gender recorded as Other'],
    ['Not recorded', s.not_recorded_gender || 0, 'Attended sessions where sex/gender was not captured'],
    ['Intake sessions', s.intake_sessions || 0, ''],
    ['Follow-up sessions', s.follow_up_sessions || 0, ''],
    ['Termination sessions', s.termination_sessions || 0, ''],
    ['Counselling minutes (attended)', s.counselling_minutes || 0, ''],
    [],
    ['Formal requirement', 'Total hours', 'From attended sessions', 'Logged manually']
  ];
  hoursRows.forEach(x => rows.push([x.name, x.total, x.encounter_hours || 0, x.manual_hours || 0]));
  rows.push([]);
  rows.push(['Corrections this period', corrections.length]);
  corrections.forEach(c => rows.push([`Entry #${c.entity_id}`, c.reason || '', c.created_at || '']));
  return toCsv(rows);
}
async function reports() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), isIntern = S.session.role === 'intern';
  const institution = isIntern ? S.session.profile.institution : S.intern?.institution;
  const internName = isIntern ? S.session.profile.display_name : S.intern?.display_name;
  // Prompt 7: "explicit intern and reporting-period selectors" — the intern
  // switcher above already covers the intern; S.reportsMonth (defaulting to
  // the current month) covers the period, and the <input type=month> below
  // lets it be changed without ever mixing months in one request.
  const selectedMonth = S.reportsMonth || month();
  const data = await api(`reports?intern_id=${id}&month=${selectedMonth}-01`), s = data.stats || {};
  const refreshedAt = data.refreshed_at ? new Date(data.refreshed_at).toLocaleString() : new Date().toLocaleString();
  const alreadyReviewed = data.report.status === 'Reviewed';
  const reviewLine = alreadyReviewed
    ? `Reviewed by ${esc(data.report.reviewed_by_name || 'unknown reviewer')}${data.report.reviewed_at ? ' on ' + esc(new Date(data.report.reviewed_at).toLocaleString()) : ''}`
    : data.report.status === 'Submitted' ? `Submitted${data.report.submitted_at ? ' on ' + esc(new Date(data.report.submitted_at).toLocaleString()) : ''} · awaiting review`
    : 'Not yet submitted';
  // Prompt 4: "report-review finalisation... makes the resulting state
  // unambiguous" — once a report is Reviewed, re-clicking updates only the
  // comment (the server no longer re-stamps reviewer/time, see 0007), so the
  // button says so instead of implying a second "Mark reviewed" action.
  const reviewBtnLabel = isIntern ? 'Submit report' : (alreadyReviewed ? 'Update comment' : 'Mark reviewed');
  const attendanceRate = s.booked ? Math.round((s.attended || 0) / s.booked * 100) : null;
  const pending = Math.max(0, (s.booked || 0) - (s.attended || 0));

  // Prompt 7: "data provenance showing whether hours came from attended
  // sessions, manually logged activity, imported opening balances or
  // another source" — range_requirement_hours (0008) now returns that
  // split, so it's shown per requirement instead of one opaque total.
  const hoursRows = (data.hours || []).map(x => {
    const parts = [];
    if (x.encounter_hours) parts.push(`${fmt(x.encounter_hours)} h from attended sessions`);
    if (x.manual_hours) parts.push(`${fmt(x.manual_hours)} h logged manually`);
    return `<div class="row"><div class="grow"><b>${esc(x.name)}</b>${parts.length ? `<br><small class="muted">${parts.join(' + ')}</small>` : ''}</div><b>${fmt(x.total)} h</b></div>`;
  }).join('') || 'No hours recorded this period.';

  // Prompt 7: "separation of verified, pending and corrected figures" —
  // attended sessions are verified (they happened and were recorded);
  // booked-not-yet-attended is pending; anything corrected after the fact
  // (Prompt 4's hours-correction audit trail) is called out by name rather
  // than folded silently back into the total.
  const corrections = data.corrections || [];
  const correctionsHtml = corrections.length
    ? corrections.map(c => `<div class="row"><div class="grow">Activity entry #${esc(c.entity_id)} was corrected</div><small class="muted">${esc(c.reason || 'No reason recorded')} · ${esc(new Date(c.created_at).toLocaleDateString())}</small></div>`).join('')
    : 'No corrections recorded this period — the figures above are as originally entered.';

  const trend = data.trend || [];
  const trendMonthsWithData = trend.filter(t => t.booked || t.attended || t.hours).length;
  const trendHtml = trendMonthsWithData >= 2
    ? `<div class="tablewrap"><table><thead><tr><th>Month</th><th>Booked</th><th>Attended</th><th>Hours logged</th></tr></thead><tbody>${trend.map(t => `<tr><td>${esc(monthLabel(t.month))}</td><td>${t.booked}</td><td>${t.attended}</td><td>${fmt(t.hours)} h</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">Not enough history yet for a trend — at least two months of activity are needed.</p>`;

  const reviewHistoryHtml = (data.review_history || []).length
    ? data.review_history.map(h => `<div class="row"><div class="grow">${h.action === 'review' ? 'Marked reviewed' : 'Submitted'}${h.reason ? ` — ${esc(h.reason)}` : ''}</div><small class="muted">${esc(new Date(h.created_at).toLocaleString())}</small></div>`).join('')
    : 'No review history yet.';

  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h3>${isIntern ? 'My monthly report' : 'Monthly report'} · ${esc(internName || '')}</h3><p>${esc(institution || 'Institution not set')} · ${esc(monthLabel(selectedMonth))}</p></div><span class="tag">${esc(data.report.status)}</span></div>
    <div class="card" style="margin-bottom:14px"><label style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="muted" style="font-size:11px;text-transform:uppercase;font-weight:800">Reporting period</span><input id="reportMonth" type="month" value="${esc(selectedMonth)}" max="${month()}"></label></div>
    <div class="notice info" style="margin-top:-4px;margin-bottom:14px">${reviewLine} · data refreshed ${esc(refreshedAt)}</div>
    <div class="grid metrics">${metric('Booked', s.booked || 0)}${metric('Attended', s.attended || 0)}${metric('Attendance rate', attendanceRate == null ? '—' : attendanceRate + '%', attendanceRate == null ? 'No sessions booked yet' : `${s.attended || 0} / ${s.booked || 0} booked`)}${metric('Pending', pending, 'booked, not yet attended')}</div>
    <div class="grid metrics" style="margin-top:14px">${metric('Female', s.female || 0)}${metric('Male', s.male || 0)}${metric('Other', s.other_gender || 0)}${metric('Not recorded', s.not_recorded_gender || 0)}</div>
    <div class="grid metrics" style="margin-top:14px">${metric('Intake', s.intake_sessions || 0)}${metric('Follow-ups', s.follow_up_sessions || 0)}${metric('Terminations', s.termination_sessions || 0)}${metric('Counselling time', fmt((s.counselling_minutes || 0) / 60) + ' h')}</div>
    <details class="card" style="margin-top:14px"><summary style="cursor:pointer;font-weight:800">What these numbers mean</summary><dl class="definitions">
      <dt>Booked / Attended / Pending</dt><dd>Booked = sessions scheduled this month. Attended = of those, recorded as having happened. Pending = booked with no attendance outcome recorded yet — not a failure, just not yet confirmed.</dd>
      <dt>Female / Male / Other / Not recorded</dt><dd>The patient's sex/gender for each attended session, as entered by the intern at the time. "Not recorded" means the field was left blank — it is not assumed to be any category. This is the Hub's own internal categorisation for service-planning visibility, not a government-mandated reporting schema.</dd>
      <dt>Intake / Follow-up / Termination</dt><dd>The session type recorded for each attended encounter.</dd>
      <dt>Formal requirement hours</dt><dd>Hours credited toward each formal category this month, split by source (attended sessions vs. manually logged activity) so the total is traceable back to what was actually recorded.</dd>
    </dl></details>
    <div class="section"><div><h3>Formal requirement hours this month</h3><p>Split by source. Any opening-balance hours were a one-time carry-over at placement start and are not part of this or any other single month.</p></div></div><div class="card list">${hoursRows}</div>
    <div class="grid two" style="margin-top:14px">
      <div><div class="section tight"><h3>Corrected this period</h3></div><div class="card list">${correctionsHtml}</div></div>
      <div><div class="section tight"><h3>Review history</h3></div><div class="card list">${reviewHistoryHtml}</div></div>
    </div>
    <div class="section"><h3>Trend (last 6 months)</h3></div><div class="card">${trendHtml}</div>
    <div class="section"><h3>${isIntern ? 'Submission' : 'Supervisor review'}</h3></div><div class="card field"><label>${isIntern ? 'Reflection / notable activity' : 'Supervisor comment'}<textarea id="comment">${esc(isIntern ? data.report.intern_comment || '' : data.report.supervisor_comment || '')}</textarea></label><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" class="no-print"><button id="sendReport" class="btn primary">${reviewBtnLabel}</button><button id="exportCsv" class="btn" type="button">Export CSV</button><button id="printReport" class="btn" type="button">Print / Save as PDF</button></div></div>`;
  bindInternSwitcher();
  $('#reportMonth').onchange = e => { S.reportsMonth = e.target.value; go('reports'); };
  $('#exportCsv').onclick = () => downloadCsv(`report-${(internName || 'intern').replace(/\s+/g, '_')}-${selectedMonth}.csv`, buildReportCsv(internName, selectedMonth, s, data.hours || [], corrections));
  $('#printReport').onclick = () => window.print();
  const submitReport = async () => {
    const btn = $('#sendReport'); if (btn.disabled) return; btn.disabled = true; const original = btn.textContent; btn.textContent = 'Saving…';
    try {
      const body = { intern_profile_id: id, month: selectedMonth + '-01' }; body[isIntern ? 'intern_comment' : 'supervisor_comment'] = $('#comment').value;
      const result = await api('reports', { method: 'POST', body: JSON.stringify(body) });
      toast(isIntern ? 'Report submitted' : (result.already_reviewed ? `Comment updated — already reviewed by ${result.reviewed_by_name || 'a reviewer'}` : 'Report marked reviewed'));
      go('reports');
    } catch (x) { toast(x.message); btn.disabled = false; btn.textContent = original; }
  };
  $('#sendReport').onclick = () => {
    if (!activeId()) { toast('No intern selected — cannot submit or review this report.'); return; }
    if (!isIntern && !alreadyReviewed) {
      confirmModal('Mark this report reviewed?', `This records you as the reviewer with today’s timestamp — that identity and time cannot be reassigned to someone else afterwards. ${esc(internName || 'This intern')}’s ${esc(monthLabel(selectedMonth))} report will be marked Reviewed.`, async () => { closeModal(); await submitReport(); }, { confirmLabel: 'Mark reviewed', danger: false });
    } else {
      submitReport();
    }
  };
}


async function feedbackView(){
  const switcherHtml = S.session.role==='intern' ? '' : await internSwitcherHtml();
  if(!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id=activeId();
  const data=await api(`feedback?intern_id=${id}`);
  const isIntern=S.session.role==='intern', isAdmin=S.session.role==='programme_lead';
  $('#content').innerHTML=switcherHtml+`<div class="hero"><small>Live pilot</small><h1>${isIntern?'Help shape the Practicum Hub.':'Pilot feedback'}</h1><p>${isIntern?'Tell us what is useful, what gets in your way, and what you expected to find but could not.':'Review what the intern is experiencing so the system improves during the pilot.'}</p></div>
    ${isIntern?`<div class="card" style="margin-top:14px"><form id="fFeedback" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Type<select name="feedback_type"><option>What worked</option><option>What was frustrating</option><option>I could not find something</option><option>Suggestion</option><option>General</option></select></label></div><div class="field"><label>How useful was the Hub today? (1–5)<input name="rating" type="number" min="1" max="5"></label></div><div class="full field"><label>Feedback<textarea name="message" required placeholder="Be specific — what were you trying to do?"></textarea></label></div><div class="full"><button class="btn primary">Send feedback</button></div></form></div>`:''}
    <div class="section"><div><h3>Feedback history</h3><p>Used during the Erin pilot to drive weekly iteration.</p></div></div><div class="card list">${data.map(x=>`<div class="row"><div class="grow"><b>${esc(x.feedback_type)}</b> ${x.rating?`<span class="tag">${x.rating}/5</span>`:''}<br><span>${esc(x.message)}</span><br><small class="muted">${esc(String(x.created_at||'').slice(0,10))}${x.context_view?' · '+esc(x.context_view):''}</small></div>${tag(x.status||'New')}${isAdmin?`<button class="btn small danger-btn" data-del-feedback="${x.id}" data-type="${esc(x.feedback_type)}">Delete</button>`:''}</div>`).join('')||'No feedback yet.'}</div>`;
  bindInternSwitcher();
  $$('[data-del-feedback]').forEach(b=>b.onclick=()=>adminDelete('feedback', b.dataset.delFeedback, `“${b.dataset.type}” feedback entry`, () => go('feedback'), {
    message: `This permanently deletes this ${esc(b.dataset.type)} feedback entry unless undone. It can be restored from the confirmation toast right after deleting.`,
    reason: { required: false, label: 'Reason (optional)' },
    restorePath: 'audit-restore'
  }));
}

const GUIDES = [
  { key: 'risk', title: 'I’m worried about risk', words: ['suicide', 'self harm', 'risk', 'violence', 'psychosis', 'abuse', 'emergency'], body: '<b>Use the escalation pathway rather than relying on the assistant.</b><br>Clarify immediate risk, stay within RC scope, involve senior clinical/medical staff promptly, and document factual decisions and who was contacted.' },
  { key: 'scope', title: 'I’m unsure if this is within scope', words: ['scope', 'diagnosis', 'treat', 'complex', 'psychologist', 'psychiatry', 'refer'], body: '<b>Start with function, risk and complexity.</b><br>Identify what the patient needs, what you can provide within short-term RC scope, what requires referral/MDT input, and take the uncertainty to supervision rather than stretching scope.' },
  { key: 'next', title: 'I don’t know what to do next', words: ['next', 'stuck', 'session', 'intervention', 'plan'], body: '<b>Return to the formulation and agreed goal.</b><br>Ask what has changed, what maintains the difficulty, what the patient wants from the session, and choose one achievable focus. If the formulation is unclear, make that the supervision question.' },
  { key: 'documentation', title: 'I’m struggling with documentation', words: ['note', 'documentation', 'mse', 'presenting problem', 'process note'], body: '<b>Separate observation, report and interpretation.</b><br>Keep Presenting Problem to complaint/duration/frequency/precipitants/consequences/context; complete the MSE; place interpretation in Clinical Impression; document risk explicitly; never invent missing facts.' },
  { key: 'supervision', title: 'I need supervision', words: ['supervision', 'unsure', 'discuss'], body: '<b>Turn the problem into a supervision question.</b><br>State the case context using only the case code, what concerns you, what you have already tried, and the specific decision or formulation you need help with.' },
  { key: 'hours', title: 'Am I on track with my hours?', words: ['hours', 'target', 'pace', 'sessions per week', 'caseload'], body: '<b>The Hub can calculate this from your requirement profile.</b><br>Use Requirements & pace to see remaining hours, needed hours/week, equivalent counselling sessions/week, booking target adjusted for attendance, and whether the current caseload appears sufficient.' }
];

function handbookMatches(query) {
  const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  return window.HANDBOOK.sections.map((s, i) => ({ s, i, score: words.reduce((n, w) => n + ((s.title + ' ' + s.search + ' ' + s.content.replace(/<[^>]+>/g, ' ')).toLowerCase().includes(w) ? 1 : 0), 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
}

async function assistant() {
  const id = activeId();
  $('#content').innerHTML = `<div class="hero assistant-hero"><small>Grounded practicum support</small><h1>What are you stuck with?</h1><p>This assistant uses the approved handbook and live placement data to help you think, find the right procedure, prepare for supervision and recognise when to escalate. It does not diagnose or replace supervision.</p></div>
    <div class="assistant-layout"><div><div class="section"><h3>Common challenges</h3></div><div class="help-grid">${GUIDES.map(g => `<button class="help-tile" data-guide="${g.key}"><b>${g.title}</b><span>Get a structured next step</span></button>`).join('')}</div></div>
    <div class="card"><h3>Ask the Practicum Hub</h3><p class="muted">Do not enter names, ID numbers, phone numbers, addresses or other identifying patient details.</p><textarea id="ask" rows="5" placeholder="Example: I’m not sure how to structure the next session, or am I on track with my counselling hours?">${esc(S.assistantSeed || '')}</textarea><button id="askBtn" class="btn primary">Get grounded guidance</button><div id="answer" class="assistant-answer"></div></div></div>`;
  S.assistantSeed = '';
  $$('[data-guide]').forEach(b => b.onclick = () => answerGuide(GUIDES.find(g => g.key === b.dataset.guide), id));
  $('#askBtn').onclick = () => answerQuestion($('#ask').value, id);
  if ($('#ask').value) $('#askBtn').click();
}
async function answerGuide(guide, id) {
  const answer = $('#answer');
  answer.innerHTML = `<div class="assistant-response"><h3>${esc(guide.title)}</h3><p>${guide.body}</p>${guide.key === 'risk' ? '<button class="btn danger-btn" id="openEmergency">Open emergency guide</button>' : ''}${guide.key === 'supervision' && id ? '<button class="btn" id="toSup">Add this to supervision</button>' : ''}${guide.key === 'hours' && id ? '<div id="hoursHelp">Loading your pace…</div>' : ''}</div>`;
  $('#openEmergency')?.addEventListener('click', () => $('#em').classList.add('open'));
  $('#toSup')?.addEventListener('click', () => supervisionModal(id, { topic: 'Clinical uncertainty', question: 'I need supervision with this issue.' }));
  if (guide.key === 'hours' && id) {
    const req = await api(`requirements?intern_id=${id}`), s = req.summary;
    $('#hoursHelp').innerHTML = `<hr><b>Your current pace</b><p>${fmt(s.total_completed)} / ${fmt(s.total_target)} formal hours · ${s.weeks_remaining == null ? 'placement end date needed' : fmt(s.weeks_remaining) + ' weeks remaining'}.</p><p>${s.clinical_hours_needed_per_week == null ? 'No counselling pace can be calculated yet.' : `You currently need about <b>${fmt(s.clinical_hours_needed_per_week)} counselling hours/week</b>, equivalent to about <b>${fmt(s.counselling_sessions_needed_per_week)} attended sessions/week</b>. At your attendance rate, the booking target is about <b>${fmt(s.bookings_needed_per_week)} bookings/week</b>.`}</p><p>${esc(s.caseload_status)}.</p>`;
  }
}
async function answerQuestion(query, id) {
  query = query.trim(); if (!query) return;
  const lower = query.toLowerCase();
  const guide = GUIDES.map(g => ({ g, score: g.words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score)[0];
  let html = guide?.score ? `<h3>${esc(guide.g.title)}</h3><p>${guide.g.body}</p>` : `<h3>Start by clarifying the challenge</h3><p>What are you observing, what does the patient report, what is the agreed goal, what have you already tried, and what specific decision are you unsure about? Use supervision for clinical uncertainty rather than forcing an answer.</p>`;
  if ((lower.includes('hour') || lower.includes('target') || lower.includes('pace') || lower.includes('caseload')) && id) {
    const req = await api(`requirements?intern_id=${id}`), s = req.summary;
    html += `<div class="notice info"><b>Live placement data:</b> ${fmt(s.total_completed)} / ${fmt(s.total_target)} hours. ${s.weeks_remaining == null ? 'Set the placement end date to calculate weekly targets.' : `${fmt(s.weeks_remaining)} weeks remain.`} ${s.clinical_hours_needed_per_week == null ? '' : `Clinical requirement: ${fmt(s.clinical_hours_needed_per_week)} h/week, ≈ ${fmt(s.counselling_sessions_needed_per_week)} attended sessions/week and ${fmt(s.bookings_needed_per_week)} bookings/week at the current attendance pattern.`}</div>`;
  }
  const matches = handbookMatches(query);
  if (matches.length) html += `<h4>Relevant handbook sections</h4><div class="list">${matches.map(x => `<button class="row assistant-link" data-hmatch="${x.i}"><div class="grow"><b>Section ${esc(x.s.num)} · ${esc(x.s.title)}</b></div><span>Open</span></button>`).join('')}</div>`;
  if (id) html += `<div class="assistant-actions"><button class="btn" id="askSupervision">Add question to supervision</button></div>`;
  $('#answer').innerHTML = `<div class="assistant-response">${html}<small class="muted">Grounded support only. For risk, emergencies or uncertainty beyond RC scope, escalate to the supervisor/clinical team.</small></div>`;
  $$('[data-hmatch]').forEach(b => b.onclick = () => { S.handbookSection = +b.dataset.hmatch; go('handbook'); });
  $('#askSupervision')?.addEventListener('click', () => supervisionModal(id, { topic: 'Practicum Assistant question', question: query }));
}

// Prompt 7: programme_metrics() mixes an all-time snapshot (interns, hours,
// cases) with one current-month figure (reviewed_reports) — rather than
// build a full historical period-selector for aggregate SQL this codebase
// deliberately keeps simple (see range_requirement_hours' own comments on
// not touching working pace math casually), each metric here says exactly
// which of those two it is, so nobody reads an all-time total as "this
// month" or vice versa.
async function programme() {
  const d = await api('programme'), m = d.metrics;
  const refreshedAt = d.refreshed_at ? new Date(d.refreshed_at).toLocaleString() : new Date().toLocaleString();
  $('#content').innerHTML = `<div class="hero"><h1>Evidence accumulates while the programme runs.</h1><p>Access, attendance, requirement completion and supervision demand become programme evidence without rebuilding the story retrospectively.</p></div>
    <div class="notice info" style="margin-top:14px">Snapshot refreshed ${esc(refreshedAt)}. Figures below are all-time totals unless marked "this month".</div>
    <div class="grid metrics" style="margin-top:14px">${metric('Active interns', m.interns, 'all-time, currently active placements')}${metric('Formal hours logged', fmt(m.hours), 'all-time')}${metric('Interns with target risk', m.at_risk_interns, 'as of now')}${metric('Attendance rate', m.attendance_rate == null ? '—' : m.attendance_rate + '%', `${m.attended || 0} / ${m.booked || 0} booked, all-time`)}</div>
    <div class="grid two" style="margin-top:14px"><div><div class="section"><h3>Service footprint</h3></div><div class="card list">${d.sites.map(x => `<div class="row"><div class="grow">${esc(x.site)}</div><b>${x.cases}</b></div>`).join('') || 'No case data yet.'}</div></div><div><div class="section"><h3>Institution mix</h3></div><div class="card list">${d.institutions.map(x => `<div class="row"><div class="grow">${esc(x.institution)}</div><b>${x.count}</b></div>`).join('')}</div></div></div>
    <div class="section"><h3>Training & governance</h3></div><div class="grid three">${metric('Open supervision', m.open_supervision, 'as of now')}${metric('Reports reviewed', m.reviewed_reports, 'this calendar month')}${metric('Median allocation → intake', m.median_days_to_intake == null ? '—' : Number(m.median_days_to_intake).toFixed(1) + ' d', 'all-time, where intake has occurred')}</div>
    <details class="card" style="margin-top:14px"><summary style="cursor:pointer;font-weight:800">What these numbers mean</summary><dl class="definitions">
      <dt>Attendance rate</dt><dd>Attended sessions ÷ booked sessions, all-time across every active intern. The denominator (booked) is always shown alongside it.</dd>
      <dt>Interns with target risk</dt><dd>Interns whose Requirements & Pace page currently flags at least one formal category as "Target at risk".</dd>
      <dt>Median allocation → intake</dt><dd>The middle value (not average) of days between a case being allocated and its intake session, across cases that have reached intake. Half of cases reach intake faster than this, half slower.</dd>
    </dl></details>
    <div class="notice info" style="margin-top:14px">Patient outcomes are deliberately not claimed yet. Add them only after agreeing a defensible, approved outcome measure.</div>
    <div class="actions" style="margin-top:14px"><button id="exportProgramme" class="btn">Export CSV</button><button id="printProgramme" class="btn">Print / Save as PDF</button></div>`;
  $('#exportProgramme').onclick = () => downloadCsv(`programme-evidence-${today()}.csv`, toCsv([
    ['Programme evidence snapshot', refreshedAt],
    [],
    ['Metric', 'Value', 'Period'],
    ['Active interns', m.interns, 'all-time'],
    ['Formal hours logged', m.hours, 'all-time'],
    ['Interns with target risk', m.at_risk_interns, 'as of now'],
    ['Attendance rate (%)', m.attendance_rate ?? '', 'all-time'],
    ['Attended', m.attended || 0, 'all-time'],
    ['Booked', m.booked || 0, 'all-time'],
    ['Open supervision', m.open_supervision, 'as of now'],
    ['Reports reviewed', m.reviewed_reports, 'this calendar month'],
    ['Median allocation to intake (days)', m.median_days_to_intake ?? '', 'all-time'],
    [],
    ['Site', 'Cases'], ...d.sites.map(x => [x.site, x.cases]),
    [],
    ['Institution', 'Interns'], ...d.institutions.map(x => [x.institution, x.count])
  ]));
  $('#printProgramme').onclick = () => window.print();
}

function handbook() {
  const H = window.HANDBOOK;
  $('#content').innerHTML = `<div class="handbook"><div class="hindex"><div style="padding:10px"><input id="hsearch" placeholder="Search handbook…"></div><div id="hlist" class="hlist"></div></div><article class="harticle"><div class="hhead"><small id="hnum"></small><h2 id="htitle"></h2><button id="askSection" class="btn ghost">Ask about this section</button></div><div id="hbody" class="hbody"></div></article></div>`;
  const draw = (q = '') => {
    $('#hlist').innerHTML = '';
    H.catOrder.forEach(c => {
      const matches = H.sections.map((s, i) => ({ s, i })).filter(x => x.s.cat === c && (x.s.title + ' ' + x.s.search + ' ' + x.s.content.replace(/<[^>]+>/g, ' ')).toLowerCase().includes(q.toLowerCase()));
      if (!matches.length) return;
      $('#hlist').insertAdjacentHTML('beforeend', `<div class="hcat">${H.catNames[c]}</div>` + matches.map(x => `<div class="hitem ${x.i === S.handbookSection ? 'active' : ''}" data-h="${x.i}">${x.s.num}. ${x.s.title}</div>`).join(''));
    });
    $$('[data-h]').forEach(x => x.onclick = () => { S.handbookSection = +x.dataset.h; select(); draw($('#hsearch').value); });
  };
  const select = () => { const s = H.sections[S.handbookSection]; $('#hnum').textContent = 'Section ' + s.num; $('#htitle').textContent = s.title; $('#hbody').innerHTML = s.content; $('#askSection').onclick = () => { S.assistantSeed = `I need help applying the handbook section “${s.title}”.`; go('assistant'); }; };
  $('#hsearch').oninput = e => draw(e.target.value); select(); draw();
}

function demoRequirement(id) {
  const defs = [
    ['counselling','Counselling of children, adolescents & adults',202,99,10.5,'site','manual_plus_individual_encounters','combined_counselling'],
    ['preparation-documentation','Preparation & documentation of client engagement',86,91,8.5,'site','manual','preparation_documentation'],
    ['psychoeducation-community','Psycho-education / community / public health / advocacy',180,67,4.5,'shared','manual','community'],
    ['training-supervision','Training & supervision',72,50,2.4,'shared','manual','supervision'],
    ['ethical-professional','Ethical & professional conduct',36,34,0.5,'campus','manual','academic'],
    ['psychometric-assessment','Basic psychological assessment',72,70,8.3,'site','manual','psychometrics'],
    ['other-professional','Other professional activities',72,59.5,0.5,'shared','manual','other']
  ];
  const comps=defs.map((x,i)=>{
    const rem=Math.max(0,x[2]-x[3]);
    const status=x[3]>=x[2]?'Complete':(x[0]==='ethical-professional'?'Monitor':'Dates needed');
    return{id:100+i,code:x[0],name:x[1],target_hours:x[2],completed:x[3],remaining:roundDemo(rem),recent_weekly_pace:x[4],responsibility:x[5],calculation_mode:x[6],component_type:x[7],needed_per_week:null,projected_completion:null,status};
  });
  return { profile:{id:11,display_name:'Erin George',institution:'SACAP',requirement_profile_name:'SACAP B Psych Practicum',placement_start:'2026-05-18',placement_end:'2026-11-12'}, components:comps, summary:{
    total_completed:470.5,total_target:720,overall_percent:65,weeks_remaining:8.1,elapsed_weeks:17.3,
    attendance_rate:null,average_session_minutes:60,session_minutes_source:'configured default',clinical_component:'Counselling of children, adolescents & adults',
    clinical_hours_needed_per_week:12.7,counselling_sessions_remaining:103,bookings_remaining:null,counselling_sessions_needed_per_week:12.7,bookings_needed_per_week:null,
    recent_clinical_weekly_pace:10.5,estimated_clinical_weeks_to_target:9.8,estimated_clinical_target_date:'2026-11-23',
    active_cases:0,planned_bookings_from_caseload:0,expected_attended_sessions:0,caseload_status:'Active caseload has not yet been imported from the university logbook',additional_bookings_needed:null,
    at_risk_components:1,watch_components:0,dates_needed_components:0,outstanding_deliverables:0,
    source_audit:{sheet_displayed_total:502.5,evidence_backed_total:470.5,unconfirmed_prefilled_hours:32,data_quality_note:'Two date-quality issues were also detected: one 2025 date in the preparation sheet and one “02 June 0206” text date in Other Professional Activities.'}
  } };
}
const roundDemo = n => Math.round(n * 10) / 10;
function demo() { return {
  interns:[{id:11,email:'erin.pilot@example.test',display_name:'Erin George',institution:'SACAP',active_cases:0,open_supervision:0,active:true,identity_user_id:'erin-pilot',placement_start:'2026-05-18',placement_end:'2026-11-12'}],
  cases:[], sup:{11:[]}, feedback:{11:[]}, schedule:{11:[{weekday:1,start_time:'08:00',end_time:'10:00',title:'Supervision with Vivian',site:'Stellenbosch Hospital',activity_type:'Supervision',recurrence_note:'Every Monday'},{weekday:1,start_time:'10:30',title:'Patient sessions',site:'Stellenbosch Hospital',activity_type:'Clinical',recurrence_note:'3–4 bookings'},{weekday:2,start_time:'08:30',title:'Clinic day',site:'Don & Pat or Jamestown Clinic',activity_type:'Clinical + community',recurrence_note:'Patients throughout the day + one psychoeducation/community talk'},{weekday:3,start_time:'08:30',title:'Alternating clinical day',site:'Stellenbosch Hospital / Night Shelter',activity_type:'Clinical',recurrence_note:'Alternates weekly'},{weekday:4,start_time:'08:30',title:'Clinic day',site:'Idas Valley Clinic',activity_type:'Clinical',recurrence_note:'SACAP supervision at 12:00, then patients'},{weekday:5,title:'Campus day',site:'SACAP campus',activity_type:'Campus',recurrence_note:'Every Friday'}]}, planned:{11:[{activity_date:'2026-10-01',title:'Make Mental Health Everybody’s Business campaign',component_code:'psychoeducation-community',site:'Subdistrict campaign',planned_hours:null,preparation_hours:null,status:'Planned',note:'Design posters and “Did you know?” mental-health snippets; preparation begins from 1 October'},{activity_date:'2026-10-09',title:'Preschool mental-health activity',component_code:'psychoeducation-community',site:'Preschool',planned_hours:5,preparation_hours:null,status:'Planned',note:'Programme design and preparation hours to be logged when known'},{activity_date:'2026-10-23',title:'Care at the Retreat event',component_code:'psychoeducation-community',site:'Retreat',planned_hours:6,preparation_hours:18,status:'Planned',note:'Needs analysis, programme preparation and event delivery'},{activity_date:null,title:'Ebenezer activity',component_code:'psychoeducation-community',site:'Ebenezer',planned_hours:null,preparation_hours:4,status:'Planned',note:'Date and event hours to confirm'}]},
  hours:{11:[
    {work_date:'2026-09-16',component_name:'Psycho-education / community / public health / advocacy',component_code:'psychoeducation-community',hours:2,note:'Imported historical activity'},
    {work_date:'2026-09-16',component_name:'Counselling of children, adolescents & adults',component_code:'counselling',hours:1,note:'Imported historical counselling'},
    {work_date:'2026-09-15',component_name:'Other professional activities',component_code:'other-professional',hours:2,note:'Imported historical activity'},
    {work_date:'2026-09-15',component_name:'Counselling of children, adolescents & adults',component_code:'counselling',hours:2,note:'Imported historical counselling'},
    {work_date:'2026-09-14',component_name:'Training & supervision',component_code:'training-supervision',hours:1.5,note:'Imported historical activity'}
  ]}, comp:{}, report:{}, enc:[]
}; }
async function demoApi(path, options = {}) {
  const d=S.data,[route,qs='']=path.split('?'),q=new URLSearchParams(qs),method=options.method||'GET',body=options.body?JSON.parse(options.body):{},id=+(q.get('intern_id')||(S.session.role==='intern'?11:S.intern?.id||0));
  d.referrals ||= [];
  if(route==='dashboard'){if(S.session.role==='intern')return{metrics:{active_cases:0,open_supervision:0},requirements:demoRequirement(11)};if(S.session.role==='management')return demoProgramme(d);const interns=d.interns.map(x=>({...x,requirements:demoRequirement(x.id).summary,requirement_profile_name:demoRequirement(x.id).profile.requirement_profile_name}));const atRisk=interns.reduce((n,p)=>n+(p.requirements.at_risk_components>0?1:0),0);return{interns,metrics:{interns:1,active_cases:0,open_supervision:0,at_risk}};}
  if(route==='interns')return d.interns.map(x=>({...x,requirement_summary:demoRequirement(x.id).summary}));
  if(route==='pilot-context')return {schedule:d.schedule[id]||[],planned:d.planned[id]||[]};
  if(route==='feedback'){if(method==='GET')return d.feedback[id]||[];(d.feedback[id]||=[]).unshift({...body,id:Date.now(),status:'New',created_at:new Date().toISOString()});return body;}
  if(route==='requirements'){if(method==='PATCH')return body;return demoRequirement(id||11);}
  if(route==='cases'){if(method==='GET')return id?d.cases.filter(x=>x.intern_profile_id===id):d.cases;let x=d.cases.find(x=>x.id===+body.id);if(method==='PATCH'){Object.assign(x,body);return x}if(method==='POST'){const n={...body,id:Date.now(),intern_profile_id:+body.intern_profile_id,sessions:0,supervision_status:'Not yet',status:'Allocated'};d.cases.push(n);return n;}}
  if(route==='referrals'){if(method==='GET')return d.referrals;let x=d.referrals.find(x=>x.id===+body.id);if(method==='PATCH'){Object.assign(x,body);return x}const n={...body,id:Date.now(),intern_profile_id:id||+body.intern_profile_id||11,intern_name:'Erin George',contact_attempts:+body.contact_attempts||0};d.referrals.push(n);return n;}
  if(route==='encounters'){d.enc.push({...body,booked:String(body.booked)!=='false',attended:String(body.attended)!=='false'});return body;}
  if(route==='supervision'){if(method==='GET')return d.sup[id]||[];if(method==='POST'){(d.sup[id]||=[]).push({...body,id:Date.now(),status:'Open'});return body}return body;}
  if(route==='supervision-feed')return Object.entries(d.sup).flatMap(([iid,items])=>items.map(x=>({...x,intern_name:(d.interns.find(i=>i.id==iid)||{}).display_name||'Intern'})));
  if(route==='hours-feed')return Object.entries(d.hours).flatMap(([iid,items])=>items.map(x=>({...x,intern_name:(d.interns.find(i=>i.id==iid)||{}).display_name||'Intern'})));
  if(route==='competencies'){const defs=['Intake interviewing','Mental State Examination','Risk assessment','Case formulation','Short-term counselling','Documentation','Referral & MDT work','Professional conduct','Group / community work'];if(method==='GET')return defs.map((name,i)=>({id:i+1,name,description:'Developmental competency',...(d.comp[id]?.[i+1]||{})}));d.comp[id]||={};d.comp[id][body.competency_id]={...(d.comp[id][body.competency_id]||{}),...body};return body;}
  if(route==='hours'){if(method==='GET'){const req=demoRequirement(id);return{entries:d.hours[id]||[],components:req.components.filter(x=>['manual','manual_plus_individual_encounters'].includes(x.calculation_mode))};}(d.hours[id]||=[]).unshift({...body,hours:+body.hours,component_name:demoRequirement(id).components.find(x=>x.code===body.component_code)?.name||body.component_code});return body;}
  if(route==='reports'){
    if(method==='GET')return{
      report:d.report[id]||{status:'Draft'},
      hours:[{code:'counselling',name:'Counselling of children, adolescents & adults',total:11.5,encounter_hours:10.5,manual_hours:1}],
      stats:{booked:12,attended:10,female:6,male:3,other_gender:1,not_recorded_gender:0,intake_sessions:2,follow_up_sessions:7,termination_sessions:1,counselling_minutes:630},
      corrections:[],
      trend:[{month:'2026-07-01',booked:9,attended:8,hours:9.5},{month:'2026-08-01',booked:11,attended:9,hours:10.8},{month:'2026-09-01',booked:12,attended:10,hours:11.5}],
      review_history:d.report[id]?.status==='Reviewed'?[{action:'review',reason:null,created_at:new Date().toISOString(),detail:'{}'}]:[],
      refreshed_at:new Date().toISOString()
    };
    const already=d.report[id]?.status==='Reviewed';
    d.report[id]={...d.report[id],...body,status:S.session.role==='intern'?'Submitted':'Reviewed',reviewed_by_name:S.session.role==='intern'?d.report[id]?.reviewed_by_name:S.session.profile.display_name,reviewed_at:S.session.role==='intern'?d.report[id]?.reviewed_at:new Date().toISOString()};
    return {...d.report[id],already_reviewed:already};
  }
  if(route==='programme')return demoProgramme(d);
  throw Error('Preview route not implemented');
}
function demoProgramme(d){const atRiskInterns=demoRequirement(11).summary.at_risk_components>0?1:0;return{metrics:{interns:1,cases:0,active_cases:0,hours:470.5,at_risk_interns:atRiskInterns,open_supervision:0,reviewed_reports:0,booked:12,attended:10,attendance_rate:83,median_days_to_intake:4.5},sites:[{site:'Stellenbosch Hospital',cases:3}],institutions:[{institution:'SACAP',count:1}],refreshed_at:new Date().toISOString()};}
async function preview(role){S.preview=true;S.data=demo();const profile=role==='intern'?{id:11,display_name:'Erin George'}:{id:1,display_name:role==='management'?'Programme Viewer':'Vivian Leibrandt'};S.session={profile,role};restoreActiveIntern();shell();}
let pendingAuthType=null;
function authError(message){$('#authErr').classList.remove('hidden');$('#authErr').textContent=message;}
function showPasswordSetup(type){pendingAuthType=type;$('#login').classList.add('hidden');$('#setPassword').classList.remove('hidden');$('#setPasswordMessage').innerHTML=type==='recovery'?'<b>Choose a new password</b><br>Enter and confirm your new password.':'<b>Finish setting up your account</b><br>Create a password to accept your invitation.';}
async function finishLogin(){const b=await api('bootstrap');S.session={profile:b.profile,role:b.role};restoreActiveIntern();shell();}

// Auth: Supabase Auth (supabase-js) replaces @netlify/identity. Invite and
// password-recovery links both land back on this page with tokens in the
// URL hash; supabase-js's detectSessionInUrl consumes that hash on client
// creation and establishes a (temporary, for invite/recovery) session
// automatically, then fires onAuthStateChange with the matching event.
async function init(){
  const qp=new URLSearchParams(location.search),pr=window.__AUTO_PREVIEW__||qp.get('preview'),allowed=location.hostname==='localhost'||location.hostname==='127.0.0.1'||pr!==null;
  if(allowed){$('#preview').classList.remove('hidden');$$('[data-preview]').forEach(b=>b.onclick=()=>preview(b.dataset.preview));}
  if(['programme_lead','intern','management'].includes(pr))return preview(pr);
  try{
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    if(!window.__SUPABASE_URL__ || window.__SUPABASE_URL__.includes('YOUR-PROJECT-REF')) throw Error('Supabase is not configured yet (see public/config.js).');
    S.supabase=createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON_KEY__);
    const hashType=new URLSearchParams(location.hash.replace(/^#/,'')).get('type');
    S.supabase.auth.onAuthStateChange((event, session)=>{
      if(event==='PASSWORD_RECOVERY') return showPasswordSetup('recovery');
      if(event==='SIGNED_IN' && hashType==='invite' && pendingAuthType!==null) return; // already showing set-password form
      if(event==='SIGNED_IN' && hashType==='invite') return showPasswordSetup('invite');
    });
    const { data: { session } } = await S.supabase.auth.getSession();
    if(session && !hashType) return finishLogin();
  }catch(e){ if(!allowed) authError(e.message||'Sign-in could not be completed.'); }
}

$('#login').onsubmit=async e=>{e.preventDefault();try{const {error}=await S.supabase.auth.signInWithPassword({email:$('#email').value,password:$('#password').value});if(error)throw error;await finishLogin();}catch(x){authError(x.message);}};
$('#setPassword').onsubmit=async e=>{e.preventDefault();const password=$('#newPassword').value;if(password!==$('#confirmPassword').value)return authError('The passwords do not match.');try{const {error}=await S.supabase.auth.updateUser({password});if(error)throw error;history.replaceState(null,'',location.pathname);location.replace('/');}catch(x){authError(x.message);}};
$('#logout').onclick=()=>S.preview?location.reload():(S.supabase.auth.signOut().then(()=>location.reload()));
$('#menu').onclick=()=>$('aside').classList.toggle('open');
$('#modalClose').onclick=closeModal; $('#modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
$('#emergency').onclick=()=>$('#em').classList.add('open'); $('#emClose').onclick=()=>$('#em').classList.remove('open');
$('#quickHelp').onclick=()=>{S.assistantSeed='';go('assistant');};
init();
