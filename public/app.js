const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const fmt = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pc = (a, b) => b ? Math.min(100, Math.round(Number(a || 0) / Number(b) * 100)) : 0;
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const statusClass = s => { const v=String(s||'').toLowerCase(); if(['complete','on track','reviewed','closed'].includes(v)||v.startsWith('closed')) return 'green'; if(v.includes('risk')||v==='required'||v==='target at risk'||v==='action needed'||v==='urgent') return 'red'; if(['watch','monitor','dates needed','due','important','priority','awaiting feedback'].includes(v)) return 'amber'; return ''; };
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
document.addEventListener('submit', (e) => {
  const fn = FORM_HANDLERS[e.target && e.target.id];
  if (fn) { e.preventDefault(); fn(e); }
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
registerForm('fFeedback', async e => { const b = Object.fromEntries(new FormData(e.target)); b.context_view = S.view; try { await api('feedback', { method: 'POST', body: JSON.stringify(b) }); toast('Feedback saved'); go('feedback'); } catch (x) { toast(x.message); } });

let S = { identity: null, session: null, view: 'dashboard', intern: null, preview: false, data: null, handbookSection: 0, assistantSeed: '' };

const NAV = {
  programme_lead: [['dashboard', 'Dashboard'], ['interns', 'Interns'], ['referrals', 'Referral tracker'], ['progress', 'Requirements & pace'], ['cases', 'Case workflow'], ['supervision', 'Supervision'], ['competencies', 'Competencies'], ['hours', 'Activity log'], ['reports', 'Reports'], ['assistant', 'Practicum Assistant'], ['programme', 'Programme evidence'], ['handbook', 'Handbook']],
  supervisor: [['dashboard', 'Dashboard'], ['interns', 'Assigned interns'], ['referrals', 'Referrals'], ['progress', 'Requirements & pace'], ['cases', 'Cases'], ['supervision', 'Supervision'], ['competencies', 'Competencies'], ['hours', 'Activity log'], ['reports', 'Reports'], ['assistant', 'Practicum Assistant'], ['handbook', 'Handbook']],
  intern: [['dashboard', 'My placement'], ['referrals', 'My referrals'], ['progress', 'My requirements'], ['cases', 'My cases'], ['supervision', 'Supervision prep'], ['competencies', 'My competencies'], ['hours', 'Activity log'], ['reports', 'My report'], ['assistant', 'Practicum Assistant'], ['feedback', 'Pilot feedback'], ['handbook', 'Handbook']],
  management: [['dashboard', 'Programme overview'], ['programme', 'Programme evidence'], ['handbook', 'Handbook']]
};
const titles = { dashboard: 'Dashboard', interns: 'Interns', referrals: 'Referral tracker', progress: 'Requirements & pace', cases: 'Case workflow', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Monthly reports', assistant: 'Practicum Assistant', feedback: 'Pilot feedback', programme: 'Programme evidence', handbook: 'Practicum handbook' };

function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 2200); }
function modal(title, html) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.add('open'); }
function closeModal() { $('#modal').classList.remove('open'); }
const roleName = r => ({ programme_lead: 'Programme Lead', supervisor: 'Supervisor', intern: 'Intern', management: 'Management' }[r] || r);
const metric = (label, value, note = '') => `<div class="card metric"><label>${label}</label><strong>${value}</strong><div class="muted">${note}</div></div>`;
const table = (headers, rows, empty = 'No records yet.') => `<div class="tablewrap"><table><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">${empty}</td></tr>`}</tbody></table></div>`;
const tag = s => `<span class="tag ${statusClass(s)}">${esc(s)}</span>`;
const progressBar = (done, target) => `<div class="progress"><span style="width:${pc(done, target)}%"></span></div>`;

async function api(path, options = {}) {
  if (S.preview) return demoApi(path, options);
  const response = await fetch('/api/' + path, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(body.error || 'Request failed');
  return body;
}

function shell() {
  const { profile, role } = S.session;
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#me').innerHTML = `<b>${esc(profile.display_name)}</b><br>${roleName(role)}`;
  $('#role').textContent = roleName(role);
  $('#nav').innerHTML = NAV[role].map(([v, l]) => `<button class="navbtn" data-view="${v}">${l}</button>`).join('');
  $$('.navbtn').forEach(b => b.onclick = () => go(b.dataset.view));
  go('dashboard');
}

async function go(view) {
  S.view = view;
  $$('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#title').textContent = titles[view]; $('aside').classList.remove('open');
  $('#content').innerHTML = '<div class="card">Loading…</div>';
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
function needIntern() {
  if (activeId()) return true;
  $('#content').innerHTML = '<div class="notice info">Select an intern first from the Interns screen.</div>';
  return false;
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


function weeklyScheduleCard(items=[]){
  const days=['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const rows=items.map(x=>`<div class="row"><div class="grow"><b>${days[x.weekday]} · ${esc(x.title)}</b><br><small class="muted">${x.start_time?esc(String(x.start_time).slice(0,5)):''}${x.end_time?'–'+esc(String(x.end_time).slice(0,5)):''}${x.site?' · '+esc(x.site):''}${x.recurrence_note?' · '+esc(x.recurrence_note):''}</small></div>${x.activity_type?tag(x.activity_type):''}</div>`).join('');
  return `<div class="card"><div class="section tight"><div><h3>This week</h3><p>Your real placement rhythm.</p></div></div><div class="list">${rows||'No weekly schedule configured.'}</div></div>`;
}
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
    $('#content').innerHTML = `<div class="hero"><small>${esc(req.profile.requirement_profile_name || req.profile.institution || 'Placement')}</small><h1>Your practicum companion.</h1><p>Your handbook, weekly plan, live requirements, supervision preparation and help when you are stuck — in one place.</p><div class="actions"><button class="btn" data-go="handbook">Open handbook</button><button class="btn" data-go="assistant">I’m stuck / ask for help</button><button class="btn" data-go="progress">Check my targets</button><button class="btn" data-go="feedback">Give pilot feedback</button></div></div>
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
    <div class="grid metrics">${metric('Active interns', m.interns)}${metric('Interns with target risk', m.at_risk)}${metric('Active cases', m.active_cases)}${metric('Open supervision', m.open_supervision)}</div>
    <div class="section"><div><h3>Placement pace</h3><p>Click an intern to open their requirement profile.</p></div></div>${table(['Intern', 'Formal hours', 'Weeks left', 'Clinical pace needed', 'Cases', 'Requirements', 'Supervision'], rows)}`;
  $$('[data-id]').forEach(row => row.onclick = () => { S.intern = d.interns.find(i => i.id == row.dataset.id); go('progress'); });
  bindGo();
}

async function interns() {
  const data = await api('interns');
  const rows = data.map(x => {
    const s = x.requirement_summary || {};
    const attention = s.at_risk_components ? 'Target at risk' : s.watch_components ? 'Watch' : 'On track';
    return `<tr class="click" data-id="${x.id}"><td><b>${esc(x.display_name)}</b><br>${esc(x.email)}</td><td>${esc(x.institution || '—')}</td><td>${fmt(s.total_completed)} / ${fmt(s.total_target || 720)}</td><td>${s.weeks_remaining == null ? '—' : fmt(s.weeks_remaining)}</td><td>${tag(attention)}</td><td>${x.active_cases}</td><td><span class="tag ${x.identity_user_id ? 'green' : 'amber'}">${x.identity_user_id ? 'Login linked' : 'No login linked'}</span></td></tr>`;
  }).join('');
  $('#content').innerHTML = `<div class="section"><div><h3>Intern placements</h3><p>Institution determines the verified requirement profile automatically.</p></div>${S.session.role === 'programme_lead' ? '<button id="addIntern" class="btn primary">Add intern</button>' : ''}</div>
    ${table(['Intern', 'Institution', 'Progress', 'Weeks left', 'Pace', 'Cases', 'Account'], rows)}
    <div class="notice info" style="margin-top:12px"><b>Account setup:</b> Adding an intern creates their placement profile only; it does not send an invitation. Invite the person separately from Netlify Identity after the controlled intern-access test has passed. SACAP and Cornerstone use different formal hour categories, and the Hub loads the selected profile automatically.</div>`;
  $$('[data-id]').forEach(x => x.onclick = () => { S.intern = data.find(i => i.id == x.dataset.id); go('progress'); });
  $('#addIntern')?.addEventListener('click', () => { modal('Add intern', `<form id="fIntern" class="formgrid"><div class="field"><label>Name<input name="display_name" required></label></div><div class="field"><label>Email<input name="email" type="email" required></label></div><div class="field"><label>Institution<select name="institution"><option>SACAP</option><option>Cornerstone Institute</option><option>Other</option></select></label></div><div class="field"><label>Default counselling session length (min)<input name="default_session_minutes" type="number" min="15" max="240" value="60"></label></div><div class="field"><label>Placement start<input name="placement_start" type="date"></label></div><div class="field"><label>Placement end<input name="placement_end" type="date"></label></div><div class="full"><button class="btn primary">Create placement</button></div></form>`); });
}
async function saveIntern(e) { if (e.target.id !== 'fIntern') return; e.preventDefault(); try { S.intern = await api('interns', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Placement created'); go('interns'); } catch (x) { toast(x.message); } }

const REFERRAL_STATUSES = ['Allocated','Contact attempted','Contact made','Booked','Intake completed','Active','Awaiting feedback','Closed – completed','Closed – no contact','Reallocated'];
const SITES = ['Stellenbosch Hospital','Stellenbosch Hospital OPD','Cloetesville CDC','Groendal Clinic','Khayamandi Clinic','Klapmuts Clinic','Idas Valley Clinic','Don & Pat Clinic','Jamestown Clinic','Night Shelter','SACAP campus','Cornerstone campus'];
const siteOptions = (selected = '') => `<option value="">Select a site…</option>` + SITES.map(s => `<option ${s === selected ? 'selected' : ''}>${s}</option>`).join('') + `<option value="__other__" ${selected && !SITES.includes(selected) ? 'selected' : ''}>Other (type below)</option>`;
const siteOtherField = (selected = '') => `<div class="field site-other${selected && !SITES.includes(selected) ? '' : ' hidden'}"><label>Other site name<input name="site_other" maxlength="120" value="${esc(selected && !SITES.includes(selected) ? selected : '')}"></label></div>`;
function bindSiteToggle(form){const sel=form.querySelector('select[name="site"]');if(!sel)return;const other=form.querySelector('.site-other');const sync=()=>other?.classList.toggle('hidden',sel.value!=='__other__');sel.addEventListener('change',sync);sync();}
function resolveSite(item){if(item.site==='__other__'){item.site=(item.site_other||'').trim();}delete item.site_other;return item;}
async function referrals() {
  const own = S.session.role === 'intern', query = own ? 'referrals' : (S.intern?.id ? `referrals?intern_id=${S.intern.id}` : 'referrals');
  const [data, internsData] = await Promise.all([api(query), own ? Promise.resolve([]) : api('interns')]);
  const open = data.filter(x => !String(x.status).startsWith('Closed')).length;
  const overdue = data.filter(x => x.next_action_date && x.next_action_date < today() && !String(x.status).startsWith('Closed')).length;
  const rows = data.map(x => `<tr><td><b>${esc(x.referral_code)}</b></td>${own?'':`<td>${esc(x.intern_name)}</td>`}<td>${esc(x.referral_date)}</td><td>${esc(x.referral_source||'—')}</td><td>${esc(x.site||'—')}</td><td>${tag(x.priority)}</td><td>${tag(x.status)}</td><td>${x.contact_attempts}</td><td>${x.next_action_date?esc(x.next_action_date):'—'}</td><td>${esc(x.last_update||'—')}</td><td><button class="btn small" data-referral-update="${x.id}">Update</button></td></tr>`).join('');
  $('#content').innerHTML = `<div class="hero"><small>De-identified workflow</small><h1>${own?'Track the referrals allocated to you.':'See what happened after each referral was allocated.'}</h1><p>Record contact progress, booking, intake and closure so referrals do not disappear from view.</p><div class="actions"><button id="addReferral" class="btn">Add referral</button></div></div>
    <div class="grid metrics">${metric('Open referrals',open)}${metric('Overdue next actions',overdue)}${metric('Total tracked',data.length)}${metric('Awaiting feedback',data.filter(x=>x.status==='Awaiting feedback').length)}</div>
    <div class="section"><div><h3>${own?'My referral list':S.intern?esc(S.intern.display_name)+' · referrals':'All intern referrals'}</h3><p>Status and a short operational update are visible to the intern and supervisor.</p></div></div>
    ${table(['Code',...(own?[]:['Intern']),'Allocated','Source','Site','Priority','Status','Attempts','Next action','Latest update',''],rows,'No referrals have been added yet.')}
    <div class="notice info" style="margin-top:12px">Do not enter patient names, ID numbers, phone numbers, addresses or clinical narrative. Keep clinical documentation in the approved patient record.</div>`;
  $('#addReferral').onclick=()=>referralModal(null,internsData);
  $$('[data-referral-update]').forEach(b=>b.onclick=()=>referralModal(data.find(x=>x.id==b.dataset.referralUpdate),internsData));
}
function referralModal(item, internsData) {
  const isEdit=!!item, own=S.session.role==='intern';
  const internOptions=internsData.map(x=>`<option value="${x.id}" ${item?.intern_profile_id==x.id?'selected':''}>${esc(x.display_name)}</option>`).join('');
  modal(isEdit?'Update referral':'Add referral',`<form id="fReferral" class="formgrid">${isEdit?`<input type="hidden" name="id" value="${item.id}">`:''}
    ${!own&&!isEdit?`<div class="field"><label>Intern<select name="intern_profile_id" required><option value="">Select intern</option>${internOptions}</select></label></div>`:''}
    ${!isEdit?`<div class="field"><label>De-identified referral code<input name="referral_code" placeholder="e.g. EG-024" maxlength="50" required></label></div><div class="field"><label>Date allocated<input name="referral_date" type="date" value="${today()}" required></label></div><div class="field"><label>Referral source<select name="referral_source"><option>CAReS</option><option>Tuesday allocation</option><option>Social worker</option><option>Inpatient team</option><option>Clinic</option><option>Other</option></select></label></div><div class="field"><label>Site<select name="site">${siteOptions()}</select></label></div>${siteOtherField()}<div class="field"><label>Presenting category<input name="presenting_category" maxlength="120" placeholder="Broad category only"></label></div>`:''}
    <div class="field"><label>Priority<select name="priority">${['Routine','Priority','Urgent'].map(x=>`<option ${item?.priority===x?'selected':''}>${x}</option>`).join('')}</select></label></div>
    <div class="field"><label>Status<select name="status">${REFERRAL_STATUSES.map(x=>`<option ${item?.status===x?'selected':''}>${x}</option>`).join('')}</select></label></div>
    <div class="field"><label>Contact attempts<input name="contact_attempts" type="number" min="0" max="100" value="${item?.contact_attempts||0}"></label></div><div class="field"><label>Next action date<input name="next_action_date" type="date" value="${item?.next_action_date||''}"></label></div>
    <div class="full"><label>Short operational update<textarea name="last_update" maxlength="1000" placeholder="e.g. Called twice; appointment booked for 22 September">${esc(item?.last_update||'')}</textarea></label></div><div class="full"><button class="btn primary">${isEdit?'Save update':'Add referral'}</button></div></form>`);
    bindSiteToggle($('#fReferral'));
}
async function saveReferral(e){if(e.target.id!=='fReferral')return;e.preventDefault();const item=resolveSite(Object.fromEntries(new FormData(e.target)));try{await api('referrals',{method:item.id?'PATCH':'POST',body:JSON.stringify(item)});closeModal();toast(item.id?'Referral updated':'Referral added');go('referrals');}catch(x){toast(x.message);}}

async function requirementsView() {
  if (!needIntern()) return;
  const id = activeId(), req = await api(`requirements?intern_id=${id}`), s = req.summary;
  const canSetOpening = S.session.role !== 'intern' && S.session.role !== 'management';
  const rows = req.components.filter(x => x.calculation_mode !== 'deliverable').map(x => `<tr><td><b>${esc(x.name)}</b><br><span class="muted">${responsibilityLabel(x.responsibility)}</span></td><td>${fmt(x.completed)} / ${fmt(x.target_hours)}${x.opening_balance ? `<br><small class="muted">Opening balance: ${fmt(x.opening_balance)} h</small>` : ''}</td><td>${progressBar(x.completed, x.target_hours)}<small>${pc(x.completed, x.target_hours)}%</small></td><td>${fmt(x.remaining)}</td><td>${x.needed_per_week == null ? '—' : fmt(x.needed_per_week) + ' h/wk'}</td><td>${x.projected_completion == null ? '—' : fmt(x.projected_completion)}</td><td>${tag(x.status)}</td>${canSetOpening ? `<td><button class="btn small" data-opening="${x.id}">Opening balance</button></td>` : ''}</tr>`).join('');
  const deliverables = req.components.filter(x => x.calculation_mode === 'deliverable');
  $('#content').innerHTML = `<div class="hero"><small>${esc(req.profile.requirement_profile_name || '')}</small><h1>${S.session.role === 'intern' ? 'Your requirement profile' : esc(req.profile.display_name) + ' · requirement profile'}</h1><p>The 720-hour programme is broken into the categories required by the intern’s institution. Campus/institution components remain visible without making the placement site responsible for producing them.</p><div class="actions"><button class="btn" data-go="hours">Log non-session activity</button><button class="btn" data-go="cases">Record counselling activity</button><button class="btn" data-go="assistant">Ask about my progress</button></div></div>
    ${requirementSummaryCard(req)}
    ${s.source_audit ? `<div class="notice amber" style="margin-top:14px"><b>Imported logbook audit:</b> The institutional sheet displays <b>${fmt(s.source_audit.sheet_displayed_total)} h</b>, while <b>${fmt(s.source_audit.evidence_backed_total)} h</b> is currently supported by student-signed rows. <b>${fmt(s.source_audit.unconfirmed_prefilled_hours)} h</b> appears in pre-filled rows without the student signature and has not been counted as completed in this pilot. ${s.source_audit.data_quality_note ? esc(s.source_audit.data_quality_note) : ''}</div>` : ''}
    <div class="grid two" style="margin-top:14px">${clinicalPaceCard(req)}<div class="card"><h3>How the target works</h3><p>Remaining hours ÷ remaining placement weeks gives the weekly pace required. Counselling is translated into equivalent attended sessions and a booking target adjusted for the intern’s actual attendance rate.</p><p class="muted">Individual counselling activity is derived from attended case sessions and their duration. This avoids logging the same clinical time twice.</p>${canSetOpening ? '<p class="muted">For interns already mid-placement, use <b>Opening balance</b> once to carry across hours already completed in their institutional logbook. New Hub activity is then added from that point forward.</p>' : ''}</div></div>
    <div class="section"><div><h3>Formal requirements</h3><p>Verified SACAP / Cornerstone categories.</p></div></div>${table(['Requirement', 'Completed', 'Progress', 'Remaining', 'Needed / week', 'Projected', 'Status', ...(canSetOpening ? ['Existing hours'] : [])], rows)}
    ${deliverables.length ? `<div class="section"><div><h3>Required deliverables</h3><p>Tracked as completion tasks rather than invented hour values.</p></div></div><div class="card list">${deliverables.map(d => `<div class="row"><div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${responsibilityLabel(d.responsibility)}</small></div><select data-deliverable="${d.id}"><option ${d.deliverable_status === 'Not started' ? 'selected' : ''}>Not started</option><option ${d.deliverable_status === 'In progress' ? 'selected' : ''}>In progress</option><option ${d.deliverable_status === 'Complete' ? 'selected' : ''}>Complete</option></select></div>`).join('')}</div>` : ''}
    <div class="notice info" style="margin-top:14px"><b>Verified requirement profile:</b> ${esc(req.profile.requirement_profile_name || 'Generic')}. Hour targets are based on the supplied 2026 source material. Site/shared/campus responsibility labels are operational programme classifications and can be adjusted if the institutions specify a different split.</div>`;
  bindGo();
  $$('[data-deliverable]').forEach(sel => sel.onchange = async () => { await api('requirements', { method: 'PATCH', body: JSON.stringify({ intern_profile_id: id, component_id: +sel.dataset.deliverable, status: sel.value }) }); toast('Deliverable updated'); });
  $$('[data-opening]').forEach(btn => btn.onclick = () => openingBalanceModal(req.components.find(x => x.id == btn.dataset.opening), id));
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
  const id = activeId(), query = id ? `cases?intern_id=${id}` : 'cases', data = await api(query);
  const canPlan = ['programme_lead', 'supervisor'].includes(S.session.role);
  const rows = data.map(x => `<tr><td><b>${esc(x.case_code)}</b></td><td>${esc(x.site)}</td>${id ? '' : `<td>${esc(x.intern_name)}</td>`}<td>${esc(x.presenting_category || '—')}</td><td>${x.sessions}</td><td>${canPlan ? `<select data-frequency="${x.id}"><option value="1" ${Number(x.planned_frequency_weeks) === 1 ? 'selected' : ''}>Weekly</option><option value="2" ${Number(x.planned_frequency_weeks) === 2 ? 'selected' : ''}>Fortnightly</option><option value="4" ${Number(x.planned_frequency_weeks) === 4 ? 'selected' : ''}>Monthly</option></select>` : ({1:'Weekly',2:'Fortnightly',4:'Monthly'}[Number(x.planned_frequency_weeks)] || `Every ${fmt(x.planned_frequency_weeks)} weeks`)}</td><td>${tag(x.supervision_status)}</td><td><select data-status="${x.id}">${['Allocated', 'Contact attempted', 'Booked', 'Intake', 'Active', 'Exit review', 'Exited'].map(s => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td><button class="btn" data-act="${x.id}">Record session</button></td></tr>`).join('');
  $('#content').innerHTML = `<div class="section"><div><h3>${S.session.role === 'intern' ? 'My cases' : id ? esc(S.intern.display_name) + ' · cases' : 'All cases'}</h3><p>De-identified workflow. Frequency feeds the caseload adequacy calculation.</p></div>${['programme_lead', 'supervisor'].includes(S.session.role) && id ? '<button id="addCase" class="btn primary">Allocate case</button>' : ''}</div>
    ${table(['Case code', 'Site', ...(id ? [] : ['Intern']), 'Category', 'Sessions', 'Planned frequency', 'Supervision', 'Status', 'Activity'], rows)}
    <div class="notice info" style="margin-top:12px">Individual counselling hours are calculated from attended session duration. Do not enter patient names, ID numbers, phone numbers, addresses or narrative clinical notes.</div>`;
  $$('[data-status]').forEach(sel => sel.onchange = async () => { await api('cases', { method: 'PATCH', body: JSON.stringify({ id: +sel.dataset.status, status: sel.value }) }); toast('Status updated'); });
  $$('[data-frequency]').forEach(sel => sel.onchange = async () => { await api('cases', { method: 'PATCH', body: JSON.stringify({ id: +sel.dataset.frequency, planned_frequency_weeks: +sel.value }) }); toast('Frequency updated'); });
  $$('[data-act]').forEach(b => b.onclick = () => activityModal(data.find(x => x.id == b.dataset.act)));
  $('#addCase')?.addEventListener('click', () => { modal('Allocate de-identified case', `<form id="fCase" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Case code<input name="case_code" placeholder="KHC-026" required></label></div><div class="field"><label>Site<select name="site" required>${siteOptions()}</select></label></div>${siteOtherField()}<div class="field"><label>Presenting category<input name="presenting_category"></label></div><div class="field"><label>Planned frequency<select name="planned_frequency_weeks"><option value="1">Weekly</option><option value="2">Fortnightly</option><option value="4">Monthly</option></select></label></div><div class="full"><button class="btn primary">Allocate</button></div></form>`); bindSiteToggle($('#fCase')); });
}
async function saveCase(e) { if (e.target.id !== 'fCase') return; e.preventDefault(); try { await api('cases', { method: 'POST', body: JSON.stringify(resolveSite(Object.fromEntries(new FormData(e.target)))) }); closeModal(); toast('Case allocated'); go('cases'); } catch (x) { toast(x.message); } }
function activityModal(c) { modal('Record counselling activity · ' + c.case_code, `<form id="fActivity" class="formgrid"><input type="hidden" name="intern_profile_id" value="${c.intern_profile_id}"><input type="hidden" name="case_id" value="${c.id}"><div class="field"><label>Date<input name="encounter_date" type="date" value="${today()}" required></label></div><div class="field"><label>Session<select name="session_type"><option>First</option><option>Follow-up</option></select></label></div><div class="field"><label>Booked<select name="booked"><option value="true">Yes</option><option value="false">No</option></select></label></div><div class="field"><label>Attended<select name="attended"><option value="true">Yes</option><option value="false">No</option></select></label></div><div class="field"><label>Duration if attended (minutes)<input name="duration_minutes" type="number" min="1" max="480" value="60"></label></div><div class="field"><label>Gender for monthly statistics<select name="patient_gender"><option>Female</option><option>Male</option><option>Other</option><option>Unknown</option></select></label></div><div class="full"><button class="btn primary">Save activity</button></div></form>`); }
async function saveActivity(e) { if (e.target.id !== 'fActivity') return; e.preventDefault(); try { await api('encounters', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Session recorded'); go('cases'); } catch (x) { toast(x.message); } }

async function supervision() {
  if (!needIntern()) return;
  const id = activeId(), data = await api(`supervision?intern_id=${id}`), isIntern = S.session.role === 'intern';
  $('#content').innerHTML = `<div class="section"><div><h3>${isIntern ? 'Prepare for supervision' : esc(S.intern?.display_name || '') + ' · supervision'}</h3><p>Turn uncertainty into a specific supervision question before the session.</p></div><button id="addSup" class="btn primary">Add supervision item</button></div><div class="card list">${data.map(x => `<div class="row"><div class="grow"><b>${esc(x.topic)}</b> ${x.case_code ? `<span class="tag">${esc(x.case_code)}</span>` : ''}<br><span>${esc(x.question)}</span>${x.action_taken ? `<br><small class="muted">Already tried: ${esc(x.action_taken)}</small>` : ''}${x.supervisor_note ? `<br><small><b>Supervisor:</b> ${esc(x.supervisor_note)}</small>` : ''}</div>${tag(x.priority)} ${tag(x.status)}${!isIntern && x.status === 'Open' ? `<button class="btn" data-review="${x.id}">Review</button>` : ''}</div>`).join('') || 'No supervision items.'}</div>`;
  $('#addSup').onclick = () => supervisionModal(id);
  $$('[data-review]').forEach(b => b.onclick = () => { const x = data.find(i => i.id == b.dataset.review); modal('Review supervision item', `<form id="fSupReview"><input type="hidden" name="id" value="${x.id}"><div class="field"><label>Supervisor response<textarea name="supervisor_note">${esc(x.supervisor_note || '')}</textarea></label></div><div class="field"><label>Status<select name="status"><option>Open</option><option selected>Reviewed</option><option>Closed</option></select></label></div><button class="btn primary">Save</button></form>`); });
}
function supervisionModal(id, preset = {}) { modal('Add to supervision', `<form id="fSup" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Topic<input name="topic" value="${esc(preset.topic || '')}" required></label></div><div class="field"><label>Priority<select name="priority"><option>Routine</option><option>Important</option><option>Risk / urgent</option></select></label></div><div class="full field"><label>What exactly are you unsure about?<textarea name="question" required>${esc(preset.question || '')}</textarea></label></div><div class="full field"><label>What have you already considered / tried?<textarea name="action_taken">${esc(preset.action_taken || '')}</textarea></label></div><div class="full"><button class="btn primary">Add to supervision</button></div></form>`); }
async function saveSup(e) { if (e.target.id !== 'fSup') return; e.preventDefault(); try { await api('supervision', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Added to supervision'); if (S.view === 'supervision') go('supervision'); } catch (x) { toast(x.message); } }
async function saveSupReview(e) { if (e.target.id !== 'fSupReview') return; e.preventDefault(); try { await api('supervision', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Supervision updated'); go('supervision'); } catch (x) { toast(x.message); } }

async function competencies() {
  if (!needIntern()) return;
  const id = activeId(), data = await api(`competencies?intern_id=${id}`), isIntern = S.session.role === 'intern';
  $('#content').innerHTML = `<div class="section"><div><h3>${isIntern ? 'My competency development' : 'Competency development'}</h3><p>Ratings are supported by evidence and supervisor feedback.</p></div></div><div class="grid three">${data.map(x => `<div class="card competency"><b>${esc(x.name)}</b><p class="muted">${esc(x.description)}</p><div class="rating"><span>Intern</span><b>${x.intern_rating || '—'} / 5</b><span>Supervisor</span><b>${x.supervisor_rating || '—'} / 5</b></div>${x.evidence ? `<p><small><b>Evidence:</b> ${esc(x.evidence)}</small></p>` : ''}${x.supervisor_comment ? `<p><small><b>Feedback:</b> ${esc(x.supervisor_comment)}</small></p>` : ''}<button class="btn" data-comp="${x.id}">${isIntern ? 'Update reflection' : 'Assess / feedback'}</button></div>`).join('')}</div>`;
  $$('[data-comp]').forEach(b => b.onclick = () => competencyModal(data.find(x => x.id == b.dataset.comp), id, isIntern));
}
function competencyModal(x, id, isIntern) { modal(x.name, `<form id="fComp"><input type="hidden" name="intern_profile_id" value="${id}"><input type="hidden" name="competency_id" value="${x.id}">${isIntern ? `<div class="field"><label>Self-rating (1–5)<input name="intern_rating" type="number" min="1" max="5" value="${x.intern_rating || ''}"></label></div><div class="field"><label>Evidence / example<textarea name="evidence">${esc(x.evidence || '')}</textarea></label></div>` : `<div class="field"><label>Supervisor rating (1–5)<input name="supervisor_rating" type="number" min="1" max="5" value="${x.supervisor_rating || ''}"></label></div><div class="field"><label>Feedback / development focus<textarea name="supervisor_comment">${esc(x.supervisor_comment || '')}</textarea></label></div>`}<button class="btn primary">Save</button></form>`); }
async function saveComp(e) { if (e.target.id !== 'fComp') return; e.preventDefault(); try { await api('competencies', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Competency updated'); go('competencies'); } catch (x) { toast(x.message); } }

async function hours() {
  if (!needIntern()) return;
  const id = activeId(), [data, req] = await Promise.all([api(`hours?intern_id=${id}`), api(`requirements?intern_id=${id}`)]);
  const opts = data.components.map(c => `<option value="${esc(c.code)}">${esc(c.manual_label || c.name)}</option>`).join('');
  $('#content').innerHTML = `<div class="section"><div><h3>Activity log</h3><p>Log non-individual counselling activities directly against the institution’s formal categories.</p></div><button id="logHours" class="btn primary">Log activity hours</button></div>
    <div class="grid two"><div class="notice info"><b>Individual counselling is automatic.</b><br>Attended case sessions and their duration feed the counselling requirement. Do not log those hours again here.</div><div class="card"><b>${esc(req.profile.requirement_profile_name || '')}</b><p class="muted">${fmt(req.summary.total_completed)} of ${fmt(req.summary.total_target)} formal hours currently recorded.</p>${progressBar(req.summary.total_completed, req.summary.total_target)}</div></div>
    <div class="section"><h3>Recent activity</h3></div><div class="card list">${data.entries.map(x => `<div class="row"><div class="grow"><b>${esc(x.component_name || x.category)}</b><br><small class="muted">${esc(x.work_date)}${x.note ? ' · ' + esc(x.note) : ''}</small></div><b>${fmt(x.hours)} h</b></div>`).join('') || 'No manually logged activity yet.'}</div>`;
  $('#logHours').onclick = () => modal('Log practicum activity', `<form id="fHours" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="full field"><label>Formal requirement<select name="component_code" required>${opts}</select></label></div><div class="field"><label>Date<input name="work_date" type="date" value="${today()}" required></label></div><div class="field"><label>Hours<input name="hours" type="number" min="0.25" max="24" step="0.25" required></label></div><div class="full field"><label>Brief description<textarea name="note" placeholder="No patient-identifying information"></textarea></label></div><div class="full"><button class="btn primary">Save hours</button></div></form>`); 
}
async function saveHours(e) { if (e.target.id !== 'fHours') return; e.preventDefault(); try { await api('hours', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Activity saved'); go('hours'); } catch (x) { toast(x.message); } }

async function reports() {
  if (!needIntern()) return;
  const id = activeId(), data = await api(`reports?intern_id=${id}&month=${month()}-01`), s = data.stats || {}, isIntern = S.session.role === 'intern';
  $('#content').innerHTML = `<div class="section"><div><h3>${isIntern ? 'My monthly report' : 'Monthly report'}</h3><p>${month()} · statistics generated from routine activity.</p></div><span class="tag">${esc(data.report.status)}</span></div>
    <div class="grid metrics">${metric('Booked', s.booked || 0)}${metric('Attended', s.attended || 0)}${metric('Female', s.female || 0)}${metric('Male', s.male || 0)}</div>
    <div class="grid three" style="margin-top:14px">${metric('First sessions', s.first_sessions || 0)}${metric('Follow-ups', s.follow_up_sessions || 0)}${metric('Counselling time', fmt((s.counselling_minutes || 0) / 60) + ' h')}</div>
    <div class="section"><h3>Formal requirement hours this month</h3></div><div class="card list">${data.hours.map(x => `<div class="row"><div class="grow">${esc(x.name)}</div><b>${fmt(x.total)} h</b></div>`).join('') || 'No hours recorded.'}</div>
    <div class="section"><h3>${isIntern ? 'Submission' : 'Supervisor review'}</h3></div><div class="card field"><label>${isIntern ? 'Reflection / notable activity' : 'Supervisor comment'}<textarea id="comment">${esc(isIntern ? data.report.intern_comment || '' : data.report.supervisor_comment || '')}</textarea></label><button id="sendReport" class="btn primary">${isIntern ? 'Submit report' : 'Mark reviewed'}</button></div>`;
  $('#sendReport').onclick = async () => { const body = { intern_profile_id: id, month: month() + '-01' }; body[isIntern ? 'intern_comment' : 'supervisor_comment'] = $('#comment').value; await api('reports', { method: 'POST', body: JSON.stringify(body) }); toast(isIntern ? 'Submitted' : 'Reviewed'); go('reports'); };
}


async function feedbackView(){
  if(!needIntern()) return;
  const id=activeId();
  const data=await api(`feedback?intern_id=${id}`);
  const isIntern=S.session.role==='intern';
  $('#content').innerHTML=`<div class="hero"><small>Live pilot</small><h1>${isIntern?'Help shape the Practicum Hub.':'Pilot feedback'}</h1><p>${isIntern?'Tell us what is useful, what gets in your way, and what you expected to find but could not.':'Review what the intern is experiencing so the system improves during the pilot.'}</p></div>
    ${isIntern?`<div class="card" style="margin-top:14px"><form id="fFeedback" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Type<select name="feedback_type"><option>What worked</option><option>What was frustrating</option><option>I could not find something</option><option>Suggestion</option><option>General</option></select></label></div><div class="field"><label>How useful was the Hub today? (1–5)<input name="rating" type="number" min="1" max="5"></label></div><div class="full field"><label>Feedback<textarea name="message" required placeholder="Be specific — what were you trying to do?"></textarea></label></div><div class="full"><button class="btn primary">Send feedback</button></div></form></div>`:''}
    <div class="section"><div><h3>Feedback history</h3><p>Used during the Erin pilot to drive weekly iteration.</p></div></div><div class="card list">${data.map(x=>`<div class="row"><div class="grow"><b>${esc(x.feedback_type)}</b> ${x.rating?`<span class="tag">${x.rating}/5</span>`:''}<br><span>${esc(x.message)}</span><br><small class="muted">${esc(String(x.created_at||'').slice(0,10))}${x.context_view?' · '+esc(x.context_view):''}</small></div>${tag(x.status||'New')}</div>`).join('')||'No feedback yet.'}</div>`;
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

async function programme() {
  const d = await api('programme'), m = d.metrics;
  $('#content').innerHTML = `<div class="hero"><h1>Evidence accumulates while the programme runs.</h1><p>Access, attendance, requirement completion and supervision demand become programme evidence without rebuilding the story retrospectively.</p></div>
    <div class="grid metrics">${metric('Active interns', m.interns)}${metric('Formal hours logged', fmt(m.hours))}${metric('Interns with target risk', m.at_risk_interns)}${metric('Attendance rate', m.attendance_rate == null ? '—' : m.attendance_rate + '%', `${m.attended || 0} / ${m.booked || 0}`)}</div>
    <div class="grid two" style="margin-top:14px"><div><div class="section"><h3>Service footprint</h3></div><div class="card list">${d.sites.map(x => `<div class="row"><div class="grow">${esc(x.site)}</div><b>${x.cases}</b></div>`).join('') || 'No case data yet.'}</div></div><div><div class="section"><h3>Institution mix</h3></div><div class="card list">${d.institutions.map(x => `<div class="row"><div class="grow">${esc(x.institution)}</div><b>${x.count}</b></div>`).join('')}</div></div></div>
    <div class="section"><h3>Training & governance</h3></div><div class="grid three">${metric('Open supervision', m.open_supervision)}${metric('Reports reviewed', m.reviewed_reports, 'current month')}${metric('Median allocation → intake', m.median_days_to_intake == null ? '—' : Number(m.median_days_to_intake).toFixed(1) + ' d')}</div>
    <div class="notice info" style="margin-top:14px">Patient outcomes are deliberately not claimed yet. Add them only after agreeing a defensible outcome measure.</div>`;
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
  if(route==='competencies'){const defs=['Intake interviewing','Mental State Examination','Risk assessment','Case formulation','Short-term counselling','Documentation','Referral & MDT work','Professional conduct','Group / community work'];if(method==='GET')return defs.map((name,i)=>({id:i+1,name,description:'Developmental competency',...(d.comp[id]?.[i+1]||{})}));d.comp[id]||={};d.comp[id][body.competency_id]={...(d.comp[id][body.competency_id]||{}),...body};return body;}
  if(route==='hours'){if(method==='GET'){const req=demoRequirement(id);return{entries:d.hours[id]||[],components:req.components.filter(x=>['manual','manual_plus_individual_encounters'].includes(x.calculation_mode))};}(d.hours[id]||=[]).unshift({...body,hours:+body.hours,component_name:demoRequirement(id).components.find(x=>x.code===body.component_code)?.name||body.component_code});return body;}
  if(route==='reports'){if(method==='GET')return{report:d.report[id]||{status:'Draft'},hours:[],stats:{booked:0,attended:0,female:0,male:0,first_sessions:0,follow_up_sessions:0,counselling_minutes:0}};d.report[id]={...body,status:S.session.role==='intern'?'Submitted':'Reviewed'};return d.report[id];}
  if(route==='programme')return demoProgramme(d);
  throw Error('Preview route not implemented');
}
function demoProgramme(d){const atRiskInterns=demoRequirement(11).summary.at_risk_components>0?1:0;return{metrics:{interns:1,cases:0,active_cases:0,hours:470.5,at_risk_interns:atRiskInterns,open_supervision:0,reviewed_reports:0,booked:0,attended:0,attendance_rate:null,median_days_to_intake:null},sites:[],institutions:[{institution:'SACAP',count:1}]};}
async function preview(role){S.preview=true;S.data=demo();const profile=role==='intern'?{id:11,display_name:'Erin George'}:{id:1,display_name:role==='management'?'Programme Viewer':'Vivian Leibrandt'};S.session={profile,role};shell();const requested=new URLSearchParams(location.search).get('view');if(requested&&titles[requested])setTimeout(()=>go(requested),0);}
let pendingAuthCallback=null;
function authError(message){$('#authErr').classList.remove('hidden');$('#authErr').textContent=message;}
function showPasswordSetup(result){pendingAuthCallback=result;$('#login').classList.add('hidden');$('#setPassword').classList.remove('hidden');$('#setPasswordMessage').innerHTML=result.type==='recovery'?'<b>Choose a new password</b><br>Enter and confirm your new password.':'<b>Finish setting up your account</b><br>Create a password to accept your invitation.';}
async function finishLogin(){const b=await api('bootstrap');S.session={profile:b.profile,role:b.role};shell();}
async function init(){const qp=new URLSearchParams(location.search),pr=window.__AUTO_PREVIEW__||qp.get('preview'),allowed=location.hostname==='localhost'||location.hostname==='127.0.0.1'||pr!==null;if(allowed){$('#preview').classList.remove('hidden');$$('[data-preview]').forEach(b=>b.onclick=()=>preview(b.dataset.preview));}if(['programme_lead','intern','management'].includes(pr))return preview(pr);try{S.identity=await import('https://cdn.jsdelivr.net/npm/@netlify/identity@2.0.0/+esm');const result=await S.identity.handleAuthCallback();if(result&&['invite','recovery'].includes(result.type))return showPasswordSetup(result);if(await S.identity.getUser())return finishLogin();}catch(e){if(!allowed)authError(e.message||'Netlify Identity could not complete authentication.');}}

$('#login').onsubmit=async e=>{e.preventDefault();try{await S.identity.login($('#email').value,$('#password').value);await finishLogin();}catch(x){authError(x.message);}};
$('#setPassword').onsubmit=async e=>{e.preventDefault();const password=$('#newPassword').value;if(password!==$('#confirmPassword').value)return authError('The passwords do not match.');try{if(pendingAuthCallback?.type==='invite')await S.identity.acceptInvite(pendingAuthCallback.token,password);else if(pendingAuthCallback?.type==='recovery')await S.identity.updateUser({password});else throw Error('The invitation or recovery link is no longer active.');location.replace('/');}catch(x){authError(x.message);}};
$('#logout').onclick=()=>S.preview?location.reload():(S.identity.logout().then(()=>location.reload()));
$('#menu').onclick=()=>$('aside').classList.toggle('open');
$('#modalClose').onclick=closeModal; $('#modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
$('#emergency').onclick=()=>$('#em').classList.add('open'); $('#emClose').onclick=()=>$('#em').classList.remove('open');
$('#quickHelp').onclick=()=>{S.assistantSeed='';go('assistant');};
init();

