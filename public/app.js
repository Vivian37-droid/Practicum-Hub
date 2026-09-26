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
registerForm('fPurgeIntern', e => purgeIntern(e));
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
registerForm('fWeeklyAppointment', e => saveWeeklyAppointment(e));
registerForm('fMyService', e => saveMyService(e));
registerForm('fServiceSchedule', e => saveServiceSchedule(e));
registerForm('fMilestone', e => saveMilestone(e));
registerForm('fFeedback', async e => { const b = Object.fromEntries(new FormData(e.target)); b.context_view = S.view; try { await api('feedback', { method: 'POST', body: JSON.stringify(b) }); toast('Feedback saved'); go('feedback'); } catch (x) { toast(x.message); } });

let S = { identity: null, session: null, view: 'dashboard', intern: null, preview: false, data: null, handbookSection: 0, assistantSeed: '', reportsMonth: null, dailyDate: null, refreshPromise: null };
const IDLE_LIMIT_MS=30*60*1000,IDLE_WARNING_MS=28*60*1000;
let idleLogoutTimer=null,idleWarningTimer=null,idleListenersBound=false;
function resetIdleTimers(){
  if(!S.session||S.preview)return;
  clearTimeout(idleLogoutTimer);clearTimeout(idleWarningTimer);
  idleWarningTimer=setTimeout(()=>toast('For your security, you will be signed out in 2 minutes unless you continue working.'),IDLE_WARNING_MS);
  idleLogoutTimer=setTimeout(async()=>{try{await S.supabase?.auth.signOut()}finally{location.reload()}},IDLE_LIMIT_MS);
}
function startIdleProtection(){
  if(!idleListenersBound){['pointerdown','keydown','touchstart','scroll'].forEach(name=>window.addEventListener(name,resetIdleTimers,{passive:true}));idleListenersBound=true;}
  resetIdleTimers();
}

// Per-role nav labels (unchanged wording from before Prompt 6) — now grouped
// under NAV_GROUPS instead of rendered as one flat list, per Prompt 6's
// "reorganise navigation into clearer groups" requirement. A view only
// appears in the sidebar for a role if it has a label here, so role
// permissions are exactly as strict as before this refactor.
const NAV_LABELS = {
  programme_lead: { dashboard: 'Action Centre', myservice:'My Service', weekly: 'Weekly plan', interns: 'Interns', overview: 'Intern overview', daily: 'Daily check-in', referrals: 'Referral tracker', progress: 'Requirements & pace', cases: 'Case workflow', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Reports', assistant: 'Practicum Assistant', programme: 'Programme evidence', handbook: 'Handbook' },
  supervisor: { dashboard: 'Action Centre', weekly: 'Weekly plan', interns: 'Assigned interns', overview: 'Intern overview', daily: 'Daily check-in', referrals: 'Referrals', progress: 'Requirements & pace', cases: 'Cases', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Reports', assistant: 'Practicum Assistant', handbook: 'Handbook' },
  intern: { dashboard: 'My placement', weekly: 'My weekly plan', daily: 'How was today?', referrals: 'My referrals', progress: 'My requirements', cases: 'My cases', supervision: 'Supervision prep', competencies: 'My competencies', hours: 'Activity log', reports: 'My report', assistant: 'Practicum Assistant', feedback: 'Pilot feedback', handbook: 'Handbook' },
  management: { dashboard: 'Programme overview', programme: 'Programme evidence', handbook: 'Handbook' }
};
// Group order and membership per Prompt 6. A group is only rendered for a
// role if at least one of its views has a label for that role.
const NAV_GROUPS = [
  ['Home', ['dashboard','myservice']],
  ['Weekly work', ['weekly','daily']],
  ['Clinical work', ['referrals','cases']],
  ['Supervision', ['supervision']],
  ['Progress', ['hours','progress','competencies','interns','overview']],
  ['Reports & support', ['reports','programme','assistant','feedback','handbook']]
];
function navFlat(role) { return Object.keys(NAV_LABELS[role] || {}); }
const titles = { dashboard: 'Action Centre', myservice:'My Service', weekly:'Weekly plan', interns: 'Interns', overview: 'Intern overview', daily: 'How was today?', referrals: 'Referral tracker', progress: 'Requirements & pace', cases: 'Case workflow', supervision: 'Supervision', competencies: 'Competencies', hours: 'Activity log', reports: 'Monthly reports', assistant: 'Practicum Assistant', feedback: 'Pilot feedback', programme: 'Programme evidence', handbook: 'Practicum handbook' };

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
// Prompt 2: accessible dialog behaviour shared by #modal and the #em
// (emergency) dialog — both already have role="dialog"/aria-modal="true"/
// aria-labelledby set statically in index.html (harmless while hidden via
// display:none, which removes them from the accessibility tree entirely).
// What JS still owns: moving focus in, trapping Tab/Shift+Tab inside the
// dialog, closing on Escape, and returning focus to whatever triggered the
// dialog when it closes.
let dialogReturnFocus = null;
function focusableIn(container) {
  return $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
    .filter(el => el.offsetParent !== null);
}
function openDialog(el) {
  dialogReturnFocus = document.activeElement;
  el.classList.add('open');
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(el); return; }
    if (e.key !== 'Tab') return;
    const items = focusableIn(el.querySelector('.modal-card'));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  el._onKey = onKey;
  document.addEventListener('keydown', onKey);
  el.querySelector('.modal-card').focus();
}
function closeDialog(el) {
  el.classList.remove('open');
  if (el._onKey) { document.removeEventListener('keydown', el._onKey); el._onKey = null; }
  if (dialogReturnFocus && document.contains(dialogReturnFocus)) dialogReturnFocus.focus();
  dialogReturnFocus = null;
}
// `closeLabel` lets a caller give the × button a name matching what's
// actually being closed (Prompt 2: "Close case allocation" rather than a
// bare "Close") — most callers just get "Close <title>", which is already
// descriptive and unique even where it isn't perfectly worded.
function modal(title, html, closeLabel) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modalClose').setAttribute('aria-label', 'Close ' + (closeLabel || title));
  openDialog($('#modal'));
}
function closeModal() { closeDialog($('#modal')); }
function openEmergency() { openDialog($('#em')); }
function closeEmergency() { closeDialog($('#em')); }

// Prompt 5: the mobile nav drawer gets the same backdrop/focus-trap/Escape/
// return-focus treatment as a dialog, but isn't marked role="dialog" itself
// — it's the persistent navigation landmark, just temporarily covering the
// screen on narrow widths, not a one-off overlay.
let drawerReturnFocus = null;
function openDrawer() {
  drawerReturnFocus = document.activeElement;
  $('aside').classList.add('open');
  $('#navBackdrop').classList.add('show');
  $('#menu').setAttribute('aria-expanded', 'true');
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const items = focusableIn($('aside'));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  $('aside')._onKey = onKey;
  document.addEventListener('keydown', onKey);
  $('#navClose').focus();
}
// `returnFocus` is false when closing because the user picked a destination
// (the clicked nav button should keep focus, not get overridden back to the
// hamburger) and true for an explicit cancel — Escape, backdrop click, or
// the drawer's own close button.
function closeDrawer(returnFocus = true) {
  $('aside').classList.remove('open');
  $('#navBackdrop').classList.remove('show');
  $('#menu').setAttribute('aria-expanded', 'false');
  if ($('aside')._onKey) { document.removeEventListener('keydown', $('aside')._onKey); $('aside')._onKey = null; }
  if (returnFocus && drawerReturnFocus && document.contains(drawerReturnFocus)) drawerReturnFocus.focus();
  drawerReturnFocus = null;
}
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

async function accessSession(forceRefresh = false) {
  if (forceRefresh || !S.refreshPromise) {
    const pendingRefresh = (async () => {
      if (!forceRefresh) {
        const { data, error } = await S.supabase.auth.getSession();
        if (error) throw error;
        if (data.session) return data.session;
      }
      const { data, error } = await S.supabase.auth.refreshSession();
      if (error) throw error;
      return data.session || null;
    })();
    S.refreshPromise = pendingRefresh;
    pendingRefresh.finally(() => { if (S.refreshPromise === pendingRefresh) S.refreshPromise = null; });
  }
  return S.refreshPromise;
}

async function api(path, options = {}) {
  if (S.preview) return demoApi(path, options);
  let session = await accessSession();
  if (!session) throw Error('Your session has expired. Please sign in again.');
  const request = currentSession => fetch('/api/' + path, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${currentSession.access_token}` },
    ...options
  });
  let response = await request(session);
  if (response.status === 401) {
    session = await accessSession(true);
    if (session) response = await request(session);
  }
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
    const always=groupLabel==='Home';
    return `<details class="navgroup" ${always?'open':''}><summary>${esc(groupLabel)}</summary><div>${items.map(v => `<button class="navbtn" data-view="${v}">${esc(labels[v])}</button>`).join('')}</div></details>`;
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
  $('#title').textContent = titles[view]; if ($('aside').classList.contains('open')) closeDrawer(false);
  if (!opts.fromHistory) { const url = new URL(location.href); if (view === 'dashboard') url.searchParams.delete('view'); else url.searchParams.set('view', view); history.pushState(null, '', url); }
  $('#content').innerHTML = skeleton();
  try {
    if (view === 'dashboard') await dashboard();
    else if (view === 'daily') await daily();
    else if (view === 'interns') await interns();
    else if (view === 'overview') await internOverviewView();
    else if (view === 'referrals') await referrals();
    else if (view === 'weekly') await weeklyPlan();
    else if (view === 'myservice') await myService();
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
// Prompt 5: toggles a table row's collapsed .mobile-secondary cells (mobile
// only — see styles.css; on desktop .row-expand doesn't render at all, so
// this never runs there).
function bindRowExpand() {
  $$('.row-expand').forEach(btn => btn.onclick = () => {
    const tr = btn.closest('tr');
    const expanded = tr.classList.toggle('expanded');
    btn.setAttribute('aria-expanded', String(expanded));
    btn.textContent = expanded ? 'Less details' : 'More details';
  });
}

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
      <div><small>At current pace</small><b>${s.clinical_pace_not_viable ? 'Not viable at current pace' : s.estimated_clinical_target_date ? esc(s.estimated_clinical_target_date) : '—'}</b></div>
      <div><small>Current active cases</small><b>${s.active_cases == null ? '—' : fmt(s.active_cases)}</b></div>
    </div>
    <p class="muted">${s.weeks_remaining == null ? 'Add the official placement end date to calculate the exact weekly target.' : esc(s.caseload_status)}${s.additional_bookings_needed ? ` · approximately ${fmt(s.additional_bookings_needed)} additional bookings/week may be needed.` : ''}</p>
    <small class="muted">Historical logbook activity can establish a recent pace even before the placement end date is entered. Booking targets require actual booked-versus-attended data from the Hub.</small>
  </div>`;
}


function weeklyScheduleCard(items=[], isAdmin=false, internId=null){
  const days=['','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const rows=items.map(x=>`<div class="row"><div class="grow"><b>${days[x.weekday]} · ${esc(x.title)}</b><br><small class="muted">${x.start_time?esc(String(x.start_time).slice(0,5)):''}${x.end_time?'–'+esc(String(x.end_time).slice(0,5)):''}${x.site?' · '+esc(x.site):''}${x.recurrence_note?' · '+esc(x.recurrence_note):''}</small></div>${x.activity_type?tag(x.activity_type):''}${isAdmin?`<button class="btn small danger-btn" data-del-schedule="${x.id}" aria-label="Delete placement day: ${days[x.weekday]} ${esc(x.title)}">Delete</button>`:''}</div>`).join('');
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
    $('#content').innerHTML = `<div class="hero"><small>${esc(req.profile.requirement_profile_name || req.profile.institution || 'Placement')}</small><h2>Welcome, ${esc(S.session.profile.display_name || '')}.</h2><p>Your handbook, weekly plan, live requirements, supervision preparation and help when you are stuck — in one place.</p><div class="actions"><button class="btn" data-go="handbook">Open handbook</button><button class="btn" data-go="assistant">I’m stuck / ask for help</button><button class="btn" data-go="progress">Check my targets</button><button class="btn" data-go="feedback">Give pilot feedback</button></div></div>
      ${requirementSummaryCard(req)}
      <div class="grid two" style="margin-top:14px">${weeklyScheduleCard(pilot.schedule)}${plannedActivitiesCard(pilot.planned)}</div><div class="grid two" style="margin-top:14px">${clinicalPaceCard(req)}<div class="card"><h3>Current workload</h3><div class="mini-grid"><div><small>Active cases</small><b>${d.metrics.active_cases}</b></div><div><small>Open supervision items</small><b>${d.metrics.open_supervision}</b></div><div><small>Outstanding deliverables</small><b>${req.summary.outstanding_deliverables}</b></div><div><small>Expected attended sessions</small><b>${fmt(req.summary.expected_attended_sessions)}/wk</b></div></div><div class="actions dark"><button class="btn" data-go="supervision">Prepare supervision</button><button class="btn" data-go="handbook">Open handbook</button></div></div></div>`;
    bindGo(); return;
  }

  const m = d.metrics;
  const all = (d.interns || []).reduce((a, x) => {
    const s = x.snapshot || {};
    a.referrals += Number(s.referrals_total || 0); a.attempts += Number(s.contact_attempts || 0);
    a.attended += Number(s.attended_week || 0); a.outstanding += Number(s.outstanding || 0) + Number(s.awaiting_acceptance || 0);
    return a;
  }, { referrals: 0, attempts: 0, attended: 0, outstanding: 0 });
  const cards = (d.interns || []).map(internSnapshotCard).join('');
  $('#content').innerHTML = `<div class="action-head"><div><span class="eyebrow-dark">Supervisor overview</span><h2>Action Centre</h2><p>See what each intern has done, what is coming up and where follow-up is needed.</p></div><div class="action-filters"><button class="btn primary" data-go="referrals">Open referral tracker</button><button class="btn" data-go="daily">Daily check-ins</button></div></div>
    <div class="grid metrics action-metrics">${metric('Patients referred', all.referrals, 'all active interns')}${metric('Contact attempts', all.attempts, 'recorded to date')}${metric('Attended this week', all.attended, 'individual sessions')}${metric('Needs attention', all.outstanding, 'referrals and supervision')}</div>
    ${queueCard(d.queue || [], d.interns || [])}
    <div class="section action-section"><div><h3>Intern snapshots</h3><p>Live information from referrals, sessions, activity logs and weekly plans.</p></div><span class="tag">This week</span></div>
    <div class="snapshot-grid">${cards || '<div class="card queue-empty">No active interns found.</div>'}</div>`;
  $$('[data-open]').forEach(btn => btn.onclick = () => { setActiveIntern(d.interns.find(i => i.id == btn.dataset.open)); go('overview'); });
  $$('[data-open-referrals]').forEach(btn => btn.onclick = () => { setActiveIntern(d.interns.find(i => i.id == btn.dataset.openReferrals)); go('referrals'); });
  bindQueue(d.queue || [], d.interns || []);
  bindGo();
}

const weekDayName = n => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][Number(n)] || '';
function internSnapshotCard(x) {
  const s = x.snapshot || {};
  const attention = x.requirements?.at_risk_components ? 'Target at risk' : x.requirements?.watch_components ? 'Watch' : 'On track';
  const upcoming = (s.upcoming_week || []).map(item => `<div class="snapshot-line"><span class="snapshot-date">${item.date ? esc(String(item.date).slice(5)) : weekDayName(item.weekday)}</span><div><b>${esc(item.title)}</b><small>${esc(item.site || item.kind || '')}</small></div></div>`).join('');
  const alerts = [];
  if (s.awaiting_acceptance) alerts.push(`${s.awaiting_acceptance} awaiting acceptance`);
  if (s.no_response) alerts.push(`${s.no_response} awaiting a response`);
  if (s.outstanding) alerts.push(`${s.outstanding} overdue/open actions`);
  return `<article class="snapshot-card">
    <div class="snapshot-title"><div><button type="button" class="row-open" data-open="${x.id}">${esc(x.display_name)}</button><small>${esc(x.institution || 'Institution not set')}</small></div>${tag(attention)}</div>
    <div class="snapshot-band"><div><strong>${s.referrals_total || 0}</strong><span>referred</span></div><div><strong>${s.contact_attempts || 0}</strong><span>contact attempts</span></div><div><strong>${s.booked || 0}</strong><span>booked</span></div><div><strong>${s.attended_week || 0}</strong><span>attended this week</span></div></div>
    <div class="snapshot-detail"><div><span>Accepted</span><b>${s.referrals_accepted || 0}</b></div><div><span>Patients contacted</span><b>${s.patients_contacted || 0}</b></div><div><span>DNA this week</span><b>${s.dna_week || 0}</b></div><div><span>Intakes / follow-ups</span><b>${s.intakes_week || 0} / ${s.followups_week || 0}</b></div></div>
    <div class="snapshot-columns"><div><h4>Rest of the week</h4>${upcoming || '<p class="queue-empty">Nothing planned yet.</p>'}</div><div><h4>Needs attention</h4>${alerts.length ? alerts.map(a => `<div class="attention-line"><span></span>${esc(a)}</div>`).join('') : '<p class="queue-empty">Nothing outstanding.</p>'}</div></div>
    <div class="snapshot-actions"><button class="btn small" data-open="${x.id}">Full overview</button><button class="btn small" data-open-referrals="${x.id}">View referrals</button></div>
  </article>`;
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

function nextMonday(){const d=new Date(),day=d.getDay()||7;d.setDate(d.getDate()-day+8);return d.toISOString().slice(0,10)}
async function weeklyPlan(){
  const switcherHtml=await internSwitcherHtml(); if(!needIntern(switcherHtml)){bindInternSwitcher();return}
  const start=S.weeklyStart||nextMonday(), payload=await api(`weekly-plan?intern_id=${activeId()}&start=${start}`),data=payload.appointments||[];
  const statuses=['Booked','Attended','Did not attend','Cancelled','Rescheduled'];
  const counts=Object.fromEntries(statuses.map(s=>[s,data.filter(x=>x.status===s).length]));
  const keys=[...new Set(data.map(x=>`${x.appointment_date}|${x.site}`))];
  const groups=keys.map((key,i)=>{const [date,site]=key.split('|'),xs=data.filter(x=>x.appointment_date===date&&x.site===site),label=new Date(date+'T00:00:00').toLocaleDateString('en-ZA',{weekday:'long',day:'numeric',month:'long'});return `<details class="clinic-day" ${i===0?'open':''}><summary><div><b>${esc(label)} — ${esc(site)}</b><span>${xs.length} appointments</span></div><div>${xs.filter(x=>x.status==='Attended').length} attended · ${xs.filter(x=>x.status==='Did not attend').length} DNA · ${xs.filter(x=>x.status==='Booked').length} awaiting</div></summary><div class="clinic-slots">${xs.map(x=>`<div class="clinic-slot"><b>${esc(String(x.appointment_time).slice(0,5))}</b><span>${esc((payload.cases||[]).find(c=>c.id===x.case_id)?.case_code||'Unlinked appointment')}</span><select data-plan-status="${x.id}" aria-label="Outcome for ${esc(String(x.appointment_time).slice(0,5))}">${statuses.map(s=>`<option ${s===x.status?'selected':''}>${s}</option>`).join('')}</select></div>`).join('')}</div></details>`}).join('');
  $('#content').innerHTML=switcherHtml+`<div class="action-head"><div><span class="eyebrow-dark">Week beginning ${esc(start)}</span><h2>Weekly work</h2><p>Open a day and facility to record appointment outcomes.</p></div><button id="addWeeklyAppointment" class="btn primary">Add case appointment</button></div><div class="weekly-summary"><div class="weekly-primary"><strong>${data.length}</strong><span>appointments planned</span></div><div class="weekly-outcomes"><span><b>${counts.Attended}</b> attended</span><span><b>${counts['Did not attend']}</b> DNA</span><span><b>${counts.Booked}</b> awaiting outcome</span></div></div><div class="clinic-groups">${groups||'<div class="card queue-empty">No appointments loaded for this week.</div>'}</div>`;
  $$('[data-plan-status]').forEach(el=>el.onchange=async()=>{try{await api('weekly-plan',{method:'PATCH',body:JSON.stringify({id:el.dataset.planStatus,status:el.value})});toast('Appointment outcome updated');go('weekly')}catch(x){toast(x.message)}});
  $('#addWeeklyAppointment').onclick=()=>{modal('Add case appointment',`<form id="fWeeklyAppointment" class="formgrid"><input type="hidden" name="intern_profile_id" value="${activeId()}"><div class="field"><label>De-identified case<select name="case_id"><option value="">Unlinked appointment</option>${(payload.cases||[]).map(c=>`<option value="${c.id}">${esc(c.case_code)}</option>`).join('')}</select></label></div><div class="field"><label>Facility<select name="facility_id" required><option value="">Select facility…</option>${(payload.facilities||[]).map(f=>`<option value="${f.id}">${esc(f.name)} — ${esc(f.service_context)}</option>`).join('')}</select></label></div><div class="field"><label>Date<input type="date" name="appointment_date" required></label></div><div class="field"><label>Time<input type="time" name="appointment_time" required></label></div><div class="full"><button class="btn primary">Add booking</button></div></form>`)};
  bindInternSwitcher();
}
async function saveWeeklyAppointment(e){try{await api('weekly-plan',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});closeModal();toast('Case appointment added');go('weekly')}catch(x){toast(x.message)}}
async function myService(){
  const selected=S.myServiceMonth||month(),d=await api(`my-service?month=${selected}`),entries=d.entries||[],sum=k=>entries.reduce((n,x)=>n+Number(x[k]||0),0),booked=sum('booked'),attended=sum('attended');
  const sites=[...new Set(entries.map(x=>x.facility_name))],facilityRows=sites.map(site=>{const xs=entries.filter(x=>x.facility_name===site),b=xs.reduce((n,x)=>n+x.booked,0),a=xs.reduce((n,x)=>n+x.attended,0);return `<tr><td><b>${esc(site)}</b></td><td>${b}</td><td>${a}</td><td>${Math.max(0,b-a)}</td><td>${a+Math.max(0,b-a)?Math.round(a/b*100)||0:0}%</td></tr>`}).join('');
  const recent=entries.map(x=>`<div class="row"><div class="grow"><b>${esc(x.work_date)} · ${esc(x.facility_name)}</b><br><small class="muted">${x.booked} booked · ${x.attended} attended · ${Math.max(0,x.booked-x.attended)} DNA${x.note?' · '+esc(x.note):''}</small></div></div>`).join('');
  const statusOptions=['Planned','Completed','Cancelled'];
  const schedule=(d.schedule||[]).map(x=>{const dt=new Date(x.service_date+'T00:00:00');return `<div class="schedule-row ${x.schedule_status==='Cancelled'?'is-cancelled':''}"><div class="schedule-date"><b>${dt.toLocaleDateString('en-ZA',{weekday:'short'})}</b><span>${dt.getDate()}</span></div><div class="schedule-copy"><b>${esc(x.facility_name)}</b><span>${esc(x.service_focus||'')}</span></div><select class="schedule-status" data-schedule-status="${x.id}" aria-label="Status for ${esc(x.facility_name)}">${statusOptions.map(s=>`<option ${s===(x.schedule_status||'Planned')?'selected':''}>${s}</option>`).join('')}</select><button class="btn small" data-edit-schedule="${x.id}">Edit</button><button class="iconbtn danger" data-delete-schedule="${x.id}" aria-label="Remove ${esc(x.facility_name)}">×</button></div>`}).join('');
  $('#content').innerHTML=`<div class="action-head"><div><span class="eyebrow-dark">Private service record</span><h2>My Service</h2><p>Your figures are separate from intern activity.</p></div><div class="action-filters"><input id="myServiceMonth" type="month" value="${esc(selected)}"><button id="addScheduleEntry" class="btn">Add programme entry</button><button id="addMyStats" class="btn primary">Add daily figures</button></div></div><div class="notice info" style="margin-top:14px"><b>Using a photo:</b> Photograph your daily statistics sheet and upload it in ChatGPT. I can extract the figures for you to check before they are entered here.</div><div class="grid metrics action-metrics">${metric('Booked',booked)}${metric('Attended',attended)}${metric('DNA',Math.max(0,booked-attended))}${metric('Attendance rate',booked?Math.round(attended/booked*100)+'%':'—')}</div><div class="section"><h3>My schedule</h3></div><div class="card schedule-list">${schedule||'No schedule recorded for this month.'}</div><div class="section"><h3>By facility</h3></div>${table(['Facility','Booked','Attended','DNA','Attendance'],facilityRows,'No service statistics for this month.')}<div class="section"><h3>Daily entries</h3></div><div class="card list">${recent||'No daily figures recorded yet.'}</div>`;
  $('#myServiceMonth').onchange=e=>{S.myServiceMonth=e.target.value;go('myservice')};
  $('#addMyStats').onclick=()=>modal('Add daily service figures',`<form id="fMyService" class="formgrid"><div class="field"><label>Date<input name="work_date" type="date" value="${today()}" required></label></div><div class="field"><label>Facility<select name="facility_id" required><option value="">Select facility…</option>${d.facilities.map(f=>`<option value="${f.id}">${esc(f.name)} — ${esc(f.service_context)}</option>`).join('')}</select></label></div>${['booked','attended','female','male','other_gender','intake','follow_up','individual','group_sessions','family_sessions','community_activities'].map(k=>`<div class="field"><label>${esc(k.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()))}<input name="${k}" type="number" min="0" value="0" required></label></div>`).join('')}<div class="full field"><label>Note<textarea name="note" maxlength="500"></textarea></label></div><div class="full"><button class="btn primary">Save daily figures</button></div></form>`);
  const scheduleForm=(x={})=>`<form id="fServiceSchedule" class="formgrid"><input type="hidden" name="id" value="${x.id||''}"><div class="field"><label>Date<input name="service_date" type="date" value="${esc(x.service_date||selected+'-01')}" required></label></div><div class="field"><label>Status<select name="schedule_status">${statusOptions.map(s=>`<option ${s===(x.schedule_status||'Planned')?'selected':''}>${s}</option>`).join('')}</select></label></div><div class="full field"><label>Location or activity<input name="facility_name" maxlength="120" value="${esc(x.facility_name||'')}" placeholder="e.g. Groendal Clinic" required></label></div><div class="full field"><label>Description<input name="service_focus" maxlength="180" value="${esc(x.service_focus||'')}" placeholder="e.g. Clinic counselling service"></label></div><div class="full"><button class="btn primary">Save programme entry</button></div></form>`;
  $('#addScheduleEntry').onclick=()=>modal('Add programme entry',scheduleForm());
  $$('[data-edit-schedule]').forEach(el=>el.onclick=()=>{const x=(d.schedule||[]).find(v=>v.id===Number(el.dataset.editSchedule));modal('Edit programme entry',scheduleForm(x))});
  $$('[data-schedule-status]').forEach(el=>el.onchange=async()=>{const x=(d.schedule||[]).find(v=>v.id===Number(el.dataset.scheduleStatus));try{await api('my-service',{method:'PATCH',body:JSON.stringify({...x,kind:'schedule',schedule_status:el.value})});toast('Programme status updated');go('myservice')}catch(err){toast(err.message)}});
  $$('[data-delete-schedule]').forEach(el=>el.onclick=async()=>{if(!confirm('Remove this programme entry?'))return;try{await api('my-service',{method:'DELETE',body:JSON.stringify({kind:'schedule',id:Number(el.dataset.deleteSchedule)})});toast('Programme entry removed');go('myservice')}catch(err){toast(err.message)}});
}
async function saveMyService(e){try{await api('my-service',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});closeModal();toast('Daily service figures saved');go('myservice')}catch(x){toast(x.message)}}
async function saveServiceSchedule(e){try{const body=Object.fromEntries(new FormData(e.target));body.kind='schedule';await api('my-service',{method:body.id?'PATCH':'POST',body:JSON.stringify(body)});closeModal();toast('Programme entry saved');go('myservice')}catch(x){toast(x.message)}}

// Prompt 8: "invitation date, invitation status, last login" — Account tag
// colour follows the same status vocabulary the rest of the app uses.
const inviteTagClass = status => status === 'Active' ? 'green' : status === 'Invited — pending' ? 'amber' : status === 'Unknown' ? '' : 'red';
async function interns() {
  const data = await api('interns');
  const isAdmin = S.session.role === 'programme_lead';
  const rows = data.map(x => {
    const s = x.requirement_summary || {};
    const attention = s.at_risk_components ? 'Target at risk' : s.watch_components ? 'Watch' : 'On track';
    const invite = x.invite || { status: 'Unknown', invited_at: null, last_sign_in_at: null };
    const accountCell = `<span class="tag ${inviteTagClass(invite.status)}">${esc(invite.status)}</span>${invite.invited_at ? `<br><small class="muted">Invited ${esc(new Date(invite.invited_at).toLocaleDateString())}</small>` : ''}<br><small class="muted">${invite.last_sign_in_at ? 'Last login ' + esc(new Date(invite.last_sign_in_at).toLocaleDateString()) : 'Never signed in'}</small>${isAdmin && invite.status !== 'Active' ? `<br><button type="button" class="btn small" data-resend-invite="${x.id}" data-name="${esc(x.display_name)}">Resend invitation</button>` : ''}`;
    // Deactivate is deliberately styled as a low-key text action, not a
    // solid red button — Prompt 8: "make destructive administration less
    // visually prominent." The confirmation dialog (adminDelete/confirmModal)
    // still shows a proper danger-styled button before anything happens.
    return `<tr><td><button type="button" class="row-open" data-open="${x.id}">${esc(x.display_name)}</button>${x.active === false ? ' ' + tag('Deactivated') : ''}<br>${esc(x.email)}</td><td class="mobile-secondary" data-label="Institution">${esc(x.institution || '—')}</td><td class="mobile-secondary" data-label="Progress">${fmt(s.total_completed)} / ${fmt(s.total_target || 720)}</td><td class="mobile-secondary" data-label="Weeks left">${s.weeks_remaining == null ? '—' : fmt(s.weeks_remaining)}</td><td data-label="Status">${tag(attention)}</td><td class="mobile-secondary" data-label="Cases">${x.active_cases}</td><td class="mobile-secondary" data-label="Account">${accountCell}</td>${isAdmin ? `<td>${x.active === false ? `<button class="btn small" data-reactivate-intern="${x.id}" data-name="${esc(x.display_name)}" aria-label="Reactivate placement for ${esc(x.display_name)}">Reactivate</button> <button class="btn small danger-btn" data-purge-intern="${x.id}" data-name="${esc(x.display_name)}" data-email="${esc(x.email)}" aria-label="Permanently delete test placement for ${esc(x.display_name)}">Delete test record</button>` : `<button class="btn-subtle" data-del-intern="${x.id}" data-del-name="${esc(x.display_name)}" aria-label="Deactivate placement for ${esc(x.display_name)}">Deactivate</button>`}</td>` : ''}<td class="mobile-toggle"><button type="button" class="row-expand" aria-expanded="false">More details</button></td></tr>`;
  }).join('');
  $('#content').innerHTML = `<div class="section"><div><h2>Intern placements</h2><p>Institution determines the verified requirement profile automatically.</p></div>${S.session.role === 'programme_lead' ? '<button id="addIntern" class="btn primary">Add intern</button>' : ''}</div>
    ${table(['Intern', 'Institution', 'Progress', 'Weeks left', 'Pace', 'Cases', 'Account', ...(isAdmin ? ['Admin'] : [])], rows)}
    <div class="notice info" style="margin-top:12px"><b>Account setup:</b> Adding a new intern automatically sends them a Supabase sign-in invitation by email. SACAP and Cornerstone use different formal hour categories, and the Hub loads the selected profile automatically.</div>`;
  $$('[data-open]').forEach(btn => btn.onclick = () => { setActiveIntern(data.find(i => i.id == btn.dataset.open)); go('overview'); });
  $$('[data-resend-invite]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    confirmModal(`Resend the invitation to ${esc(b.dataset.name)}?`, `${esc(b.dataset.name)} will receive a new sign-in invitation email. This is safe — it does nothing if they've already accepted and signed in.`, async () => {
      try { await api('interns', { method: 'PATCH', body: JSON.stringify({ id: b.dataset.resendInvite, action: 'resend_invite' }) }); closeModal(); toast(`Invitation resent to ${b.dataset.name}`); go('interns'); }
      catch (x) { closeModal(); toast(x.message); }
    }, { confirmLabel: 'Resend invitation', danger: false });
  }));
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
  $$('[data-purge-intern]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    modal(`Permanently delete ${esc(b.dataset.name)}?`, `<form id="fPurgeIntern"><input type="hidden" name="id" value="${b.dataset.purgeIntern}"><input type="hidden" name="action" value="purge_test_intern"><p>This is only for a test placement. It permanently removes the sign-in account and all linked hours, referrals, cases, supervision, competencies and reports. It cannot be undone.</p><div id="purgeError" class="notice danger hidden" role="alert" aria-live="assertive"></div><div class="field"><label>Reason<textarea name="reason" required></textarea></label></div><div class="field"><label>Type ${esc(b.dataset.email)} to confirm<input name="confirm_email" type="email" required autocomplete="off"></label></div><button class="btn danger-btn">Permanently delete test record</button></form>`);
  }));
  bindRowExpand();
}
async function saveIntern(e) { if (e.target.id !== 'fIntern') return; e.preventDefault(); try { const created = await api('interns', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); setActiveIntern(created); closeModal(); toast(created.invite?.sent ? 'Placement created · invite email sent' : created.invite && !created.invite.sent ? `Placement created, but the invite email failed: ${created.invite.reason || 'unknown error'}` : 'Placement updated'); go('interns'); } catch (x) { toast(x.message); } }
async function purgeIntern(e) {
  if (e.target.id !== 'fPurgeIntern') return;
  e.preventDefault();
  const errorBox = $('#purgeError', e.target);
  errorBox?.classList.add('hidden');
  try {
    await api('interns', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
    clearActiveIntern(); closeModal(); toast('Test intern and linked records permanently deleted'); go('interns');
  } catch (x) {
    if (errorBox) { errorBox.textContent = x.message || 'The test intern could not be deleted.'; errorBox.classList.remove('hidden'); }
    toast('Deletion failed — see the message in the form.');
  }
}

function internPreviewMarkup(d) {
  const req = d.requirements;
  const activeCases = d.cases.filter(x => x.status !== 'Exited').length;
  const openSupervision = d.supervision.filter(x => x.status === 'Open').length;
  const outstandingMilestones = d.milestones.filter(x => !['Complete','Not applicable'].includes(x.status)).length;
  return `<div class="notice info preview-banner"><b>Read-only intern preview:</b> This is the placement information ${esc(d.profile.display_name)} sees. No changes can be made from this preview. <button id="exitInternPreview" class="btn small">Return to Programme Lead view</button></div>
    <div class="hero"><small>${esc(req.profile.requirement_profile_name || d.profile.institution || 'Placement')}</small><h2>Welcome, ${esc(d.profile.display_name)}.</h2><p>Your handbook, weekly plan, live requirements, supervision preparation and help when you are stuck — in one place.</p></div>
    ${requirementSummaryCard(req)}
    <div class="grid two" style="margin-top:14px">${weeklyScheduleCard(d.schedule)}${clinicalPaceCard(req)}</div>
    <div class="card" style="margin-top:14px"><h3>Current workload</h3><div class="mini-grid"><div><small>Active cases</small><b>${activeCases}</b></div><div><small>Open supervision items</small><b>${openSupervision}</b></div><div><small>Placement milestones outstanding</small><b>${outstandingMilestones}</b></div><div><small>Expected attended sessions</small><b>${fmt(req.summary.expected_attended_sessions)}/wk</b></div></div></div>`;
}

async function internOverviewView() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId();
  const d = await api(`intern-overview?intern_id=${id}`);
  const activeCases = d.cases.filter(x => x.status !== 'Exited');
  const openReferrals = d.referrals.filter(x => !String(x.status).startsWith('Closed'));
  const overdueRefs = openReferrals.filter(x => referralDaysOverdue(x) > 0);
  const openSupervision = d.supervision.filter(x => x.status === 'Open');
  const completeMilestones = d.milestones.filter(x => x.status === 'Complete').length;
  const referralRows = openReferrals.slice(0, 6).map(x => `<tr><td><b>${esc(x.referral_code)}</b></td><td>${tag(x.status)}</td><td>${esc(x.site || '—')}</td><td>${x.next_action_date ? esc(x.next_action_date) : '—'}</td></tr>`).join('');
  const caseRows = activeCases.slice(0, 6).map(x => `<tr><td><b>${esc(x.case_code)}</b></td><td>${tag(x.status)}</td><td>${esc(x.site || '—')}</td><td>${x.sessions || 0}</td></tr>`).join('');
  const milestoneRows = d.milestones.map(x => `<tr><td><b>${esc(x.title)}</b></td><td>${x.due_date ? esc(x.due_date) : '—'}</td><td>${tag(x.status)}</td><td><button class="btn small" data-milestone="${x.id}">Update</button></td></tr>`).join('');
  $('#content').innerHTML = switcherHtml + `<div class="hero"><small>${esc(d.profile.institution || 'Placement')}</small><h2>${esc(d.profile.display_name)} · complete placement view</h2><p>Account, referrals, cases, supervision, requirements and milestones in one operational view.</p><div class="actions"><button id="viewAsIntern" class="btn">View as ${esc(d.profile.display_name)}</button><button class="btn" data-go="supervision">Open supervision</button><button class="btn" data-go="progress">Review requirements</button></div></div>
    <div class="grid metrics">${metric('Open referrals', openReferrals.length, `${overdueRefs.length} overdue`)}${metric('Active cases', activeCases.length)}${metric('Open supervision', openSupervision.length)}${metric('Milestones', `${completeMilestones}/${d.milestones.length}`, 'completed')}</div>
    ${requirementSummaryCard(d.requirements)}
    <div class="grid two" style="margin-top:14px">${weeklyScheduleCard(d.schedule)}${clinicalPaceCard(d.requirements)}</div>
    <div class="section"><div><h3>Current referral journey</h3><p>Booked and intake-completed referrals flow automatically into Case Workflow.</p></div><button class="btn" data-go="referrals">Open all referrals</button></div>${table(['Code','Stage','Facility','Next action'], referralRows, 'No open referrals.')}
    <div class="section"><div><h3>Active cases</h3><p>Linked to their originating referral wherever applicable.</p></div><button class="btn" data-go="cases">Open Case Workflow</button></div>${table(['Code','Status','Facility','Sessions'], caseRows, 'No active cases.')}
    <div class="section"><div><h3>Placement milestones</h3><p>Orientation, evaluations, competencies, logbook verification and exit requirements.</p></div></div>${table(['Milestone','Due','Status',''], milestoneRows, 'No milestones configured.')}`;
  bindInternSwitcher(); bindGo();
  $('#viewAsIntern').onclick = () => { $('#content').innerHTML = internPreviewMarkup(d); $('#exitInternPreview').onclick = () => go('overview'); };
  $$('[data-milestone]').forEach(b => b.onclick = () => milestoneModal(d.milestones.find(x => x.id == b.dataset.milestone), id));
}

function milestoneModal(x, internId) {
  modal('Update placement milestone', `<form id="fMilestone" class="formgrid"><input type="hidden" name="id" value="${x.id}"><input type="hidden" name="intern_profile_id" value="${internId}"><div class="full"><b>${esc(x.title)}</b></div><div class="field"><label>Status<select name="status">${['Not started','In progress','Complete','Not applicable'].map(s => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div><div class="field"><label>Due date<input name="due_date" type="date" value="${esc(x.due_date || '')}"></label></div><div class="full field"><label>Note<textarea name="note" maxlength="1000">${esc(x.note || '')}</textarea></label></div><div class="full"><button class="btn primary">Save milestone</button></div></form>`);
}
async function saveMilestone(e) { if (e.target.id !== 'fMilestone') return; e.preventDefault(); try { await api('milestones', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Milestone updated'); go('overview'); } catch (x) { toast(x.message); } }

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
// Prompt 8: "surface the next required action" — a plain-language next step
// derived from the referral's own status, so a supervisor scanning the list
// doesn't have to infer it themselves from the status tag alone.
function referralNextAction(x) {
  if (String(x.status).startsWith('Closed')) return 'None — closed';
  return ({
    'Allocated': 'Attempt first contact',
    'Contact attempted': 'Follow up the contact attempt',
    'Contact made': 'Schedule a booking',
    'Booked': 'Confirm attendance / prepare intake',
    'Intake completed': 'Begin ongoing sessions',
    'Active': 'Continue sessions and monitor progress',
    'Awaiting feedback': 'Follow up for feedback',
    'Reallocated': 'Confirm the new allocation'
  })[x.status] || 'Review current status';
}
const REFERRAL_SORTS = {
  next_action_asc: { label: 'Next action (soonest first)', cmp: (a, b) => (a.next_action_date || '9999-99-99').localeCompare(b.next_action_date || '9999-99-99') },
  overdue_desc: { label: 'Most overdue first', cmp: (a, b) => referralDaysOverdue(b) - referralDaysOverdue(a) },
  code_asc: { label: 'Code (A–Z)', cmp: (a, b) => String(a.referral_code).localeCompare(String(b.referral_code)) },
  priority_desc: { label: 'Priority (highest first)', cmp: (a, b) => ({ Urgent: 2, Priority: 1, Routine: 0 }[b.priority] || 0) - ({ Urgent: 2, Priority: 1, Routine: 0 }[a.priority] || 0) }
};
function referralDaysOverdue(x) {
  if (!x.next_action_date || String(x.status).startsWith('Closed')) return -Infinity;
  return Math.floor((new Date(today()) - new Date(x.next_action_date)) / 86400000);
}
async function referrals() {
  const own = S.session.role === 'intern', query = own ? 'referrals' : (S.intern?.id ? `referrals?intern_id=${S.intern.id}` : 'referrals');
  const [data, internsData] = await Promise.all([api(query), own ? Promise.resolve([]) : api('interns')]);
  const isAdmin = S.session.role === 'programme_lead';
  const sites = [...new Set(data.map(x => x.site).filter(Boolean))].sort();
  const statuses = [...new Set(data.map(x => x.status).filter(Boolean))].sort();
  const internNames = own ? [] : [...new Set(data.map(x => x.intern_name).filter(Boolean))].sort();
  const filters = { q: '', status: '', site: '', intern: '', overdueOnly: false, sort: 'next_action_asc' };

  const rowHtml = x => {
    const daysOverdue = referralDaysOverdue(x);
    const nextActionCell = x.next_action_date
      ? `${esc(x.next_action_date)}${daysOverdue > 0 ? `<br><span class="tag red">${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue</span>` : ''}`
      : '—';
    const accepted = x.accepted_at ? `${tag('Accepted')}<br><small class="muted">${esc(new Date(x.accepted_at).toLocaleDateString())}</small>` : (own ? `<button class="btn small primary" data-accept-referral="${x.id}">Accept</button>` : tag('Awaiting acceptance'));
    return `<tr><td><b>${esc(x.referral_code)}</b></td>${own ? '' : `<td data-label="Intern">${esc(x.intern_name)}</td>`}<td class="mobile-secondary" data-label="Allocated">${esc(x.referral_date)}</td><td data-label="Acknowledged">${accepted}</td><td class="mobile-secondary" data-label="Source">${esc(x.referral_source || '—')}</td><td class="mobile-secondary" data-label="Site">${esc(x.site || '—')}</td><td class="mobile-secondary" data-label="Category">${esc(x.presenting_category || '—')}</td><td data-label="Priority">${tag(x.priority)}</td><td data-label="Status">${tag(x.status)}</td><td class="mobile-secondary" data-label="Attempts">${x.contact_attempts}</td><td data-label="Next action">${nextActionCell}</td><td data-label="Next required action"><small>${esc(referralNextAction(x))}</small></td><td class="mobile-secondary" data-label="Latest update">${x.update_category ? tag(x.update_category) : '—'}${x.last_update ? `<br><small class="muted">${esc(x.last_update)}</small>` : ''}</td><td><button class="btn small" data-referral-update="${x.id}" aria-label="Update referral ${esc(x.referral_code)}">Update</button>${isAdmin ? ` <button class="btn small danger-btn" data-del-referral="${x.id}" data-code="${esc(x.referral_code)}" aria-label="Delete referral ${esc(x.referral_code)}">Delete</button>` : ''}</td><td class="mobile-toggle"><button type="button" class="row-expand" aria-expanded="false">More details</button></td></tr>`;
  };

  const draw = () => {
    let filtered = data.filter(x => {
      if (filters.status && x.status !== filters.status) return false;
      if (filters.site && x.site !== filters.site) return false;
      if (filters.intern && x.intern_name !== filters.intern) return false;
      if (filters.overdueOnly && referralDaysOverdue(x) <= 0) return false;
      if (filters.q) {
        const hay = `${x.referral_code} ${x.site || ''} ${x.presenting_category || ''} ${x.intern_name || ''} ${x.last_update || ''}`.toLowerCase();
        if (!hay.includes(filters.q.toLowerCase())) return false;
      }
      return true;
    });
    filtered.sort(REFERRAL_SORTS[filters.sort].cmp);
    $('#refTableWrap').innerHTML = table(['Code', ...(own ? [] : ['Intern']), 'Allocated', 'Acknowledged', 'Source', 'Site', 'Category', 'Priority', 'Status', 'Attempts', 'Next action', 'Next required action', 'Latest update', ''], filtered.map(rowHtml).join(''), data.length ? 'No referrals match these filters.' : 'No referrals have been added yet.');
    $$('[data-accept-referral]').forEach(b => b.onclick = async () => { try { await api('referrals', { method: 'PATCH', body: JSON.stringify({ id: b.dataset.acceptReferral, action: 'accept' }) }); toast('Referral accepted'); go('referrals'); } catch (x) { toast(x.message); } });
    $$('[data-referral-update]').forEach(b => b.onclick = () => referralModal(data.find(x => x.id == b.dataset.referralUpdate), internsData));
    $$('[data-del-referral]').forEach(b => b.onclick = () => adminDelete('referrals', b.dataset.delReferral, `referral ${b.dataset.code}`, () => go('referrals'), {
      message: `This permanently deletes referral ${esc(b.dataset.code)} unless undone. It can be restored from the confirmation toast right after deleting.`,
      reason: { required: false, label: 'Reason (optional)' },
      restorePath: 'audit-restore'
    }));
    bindRowExpand();
  };

  const open = data.filter(x => !String(x.status).startsWith('Closed')).length;
  const overdue = data.filter(x => referralDaysOverdue(x) > 0).length;
  $('#content').innerHTML = `<div class="hero"><small>De-identified workflow</small><h2>${own ? 'Track the referrals allocated to you.' : 'See what happened after each referral was allocated.'}</h2><p>Record contact progress, booking, intake and closure so referrals do not disappear from view.</p><div class="actions"><button id="addReferral" class="btn">Add referral</button></div></div>
    <div class="grid metrics">${metric('Open referrals', open)}${metric('Overdue next actions', overdue)}${metric('Total tracked', data.length)}${metric('Awaiting feedback', data.filter(x => x.status === 'Awaiting feedback').length)}</div>
    <div class="section"><div><h3>${own ? 'My referral list' : S.intern ? esc(S.intern.display_name) + ' · referrals' : 'All intern referrals'}</h3><p>Status and a short operational update are visible to the intern and supervisor.</p></div></div>
    <div class="card" style="margin-bottom:14px"><div class="formgrid">
      <div class="field"><label>Search<input id="refSearch" placeholder="Code, site, category…"></label></div>
      <div class="field"><label>Status<select id="refStatus"><option value="">All statuses</option>${statuses.map(s => `<option>${esc(s)}</option>`).join('')}</select></label></div>
      <div class="field"><label>Facility<select id="refSite"><option value="">All facilities</option>${sites.map(s => `<option>${esc(s)}</option>`).join('')}</select></label></div>
      ${own ? '' : `<div class="field"><label>Intern<select id="refIntern"><option value="">All interns</option>${internNames.map(n => `<option>${esc(n)}</option>`).join('')}</select></label></div>`}
      <div class="field"><label>Sort by<select id="refSort">${Object.entries(REFERRAL_SORTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></label></div>
      <div class="field" style="align-self:end"><label style="display:flex;align-items:center;gap:8px;text-transform:none;font-size:13px;font-weight:600"><input id="refOverdueOnly" type="checkbox" style="width:auto;min-height:0"> Overdue only</label></div>
    </div></div>
    <div id="refTableWrap"></div>
    <div class="notice info" style="margin-top:12px">Do not enter patient names, ID numbers, phone numbers, addresses or clinical narrative. Keep clinical documentation in the approved patient record.</div>`;
  $('#addReferral').onclick = () => referralModal(null, internsData);
  $('#refSearch').oninput = e => { filters.q = e.target.value; draw(); };
  $('#refStatus').onchange = e => { filters.status = e.target.value; draw(); };
  $('#refSite').onchange = e => { filters.site = e.target.value; draw(); };
  $('#refIntern')?.addEventListener('change', e => { filters.intern = e.target.value; draw(); });
  $('#refSort').onchange = e => { filters.sort = e.target.value; draw(); };
  $('#refOverdueOnly').onchange = e => { filters.overdueOnly = e.target.checked; draw(); };
  draw();
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
async function saveReferral(e){if(e.target.id!=='fReferral')return;e.preventDefault();const item=resolvePresentingCategory(resolveSite(Object.fromEntries(new FormData(e.target))));try{await api('referrals',{method:item.id?'PATCH':'POST',body:JSON.stringify(item)});closeModal();const linked=['Booked','Intake completed','Active','Awaiting feedback'].includes(item.status);toast(linked?'Referral saved · available in Case Workflow':item.id?'Referral updated':'Referral added');go('referrals');}catch(x){toast(x.message);}}

async function requirementsView() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), req = await api(`requirements?intern_id=${id}`), s = req.summary;
  const canSetOpening = S.session.role !== 'intern' && S.session.role !== 'management';
  const isAdmin = S.session.role === 'programme_lead';
  const pilot = S.session.role !== 'management' ? await api(`pilot-context?intern_id=${id}`) : null;
  const rows = req.components.filter(x => x.calculation_mode !== 'deliverable').map(x => `<tr><td><b>${esc(x.name)}</b><br><span class="muted">${responsibilityLabel(x.responsibility)}</span></td><td class="mobile-secondary" data-label="Completed">${fmt(x.completed)} / ${fmt(x.target_hours)}${x.opening_balance ? `<br><small class="muted">Opening balance: ${fmt(x.opening_balance)} h</small>` : ''}</td><td data-label="Progress">${progressBar(x.completed, x.target_hours)}<small>${pc(x.completed, x.target_hours)}%</small></td><td class="mobile-secondary" data-label="Remaining">${fmt(x.remaining)}</td><td class="mobile-secondary" data-label="Needed / week">${x.needed_per_week == null ? '—' : fmt(x.needed_per_week) + ' h/wk'}</td><td data-label="Projected">${x.projected_completion == null ? '—' : fmt(x.projected_completion)}</td><td data-label="Status">${tag(x.status)}</td>${canSetOpening ? `<td class="mobile-secondary" data-label="Existing hours"><button class="btn small" data-opening="${x.id}">Opening balance</button></td>` : ''}<td class="mobile-toggle"><button type="button" class="row-expand" aria-expanded="false">More details</button></td></tr>`).join('');
  const deliverables = req.components.filter(x => x.calculation_mode === 'deliverable');
  $('#content').innerHTML = switcherHtml + `<div class="hero"><small>${esc(req.profile.requirement_profile_name || '')}</small><h2>${S.session.role === 'intern' ? 'Your requirement profile' : esc(req.profile.display_name) + ' · requirement profile'}</h2><p>The 720-hour programme is broken into the categories required by the intern’s institution. Campus/institution components remain visible without making the placement site responsible for producing them.</p><div class="actions"><button class="btn" data-go="hours">Log non-session activity</button><button class="btn" data-go="cases">Record counselling activity</button><button class="btn" data-go="assistant">Ask about my progress</button></div></div>
    ${requirementSummaryCard(req)}
    ${s.source_audit ? `<div class="notice amber" style="margin-top:14px"><b>Imported logbook audit:</b> The institutional sheet displays <b>${fmt(s.source_audit.sheet_displayed_total)} h</b>, while <b>${fmt(s.source_audit.evidence_backed_total)} h</b> is currently supported by student-signed rows. <b>${fmt(s.source_audit.unconfirmed_prefilled_hours)} h</b> appears in pre-filled rows without the student signature and has not been counted as completed in this pilot. ${s.source_audit.data_quality_note ? esc(s.source_audit.data_quality_note) : ''}</div>` : ''}
    ${clinicalPaceCard(req)}
    <details class="card" style="margin-top:14px"><summary style="cursor:pointer;font-weight:800">How the target works</summary><div style="margin-top:10px"><p>Remaining hours ÷ remaining placement weeks gives the weekly pace required. Counselling is translated into equivalent attended sessions and a booking target adjusted for the intern’s actual attendance rate.</p><p class="muted">Individual counselling activity is derived from attended case sessions and their duration. This avoids logging the same clinical time twice.</p>${canSetOpening ? '<p class="muted">For interns already mid-placement, use <b>Opening balance</b> once to carry across hours already completed in their institutional logbook. New Hub activity is then added from that point forward.</p>' : ''}</div></details>
    <div class="section"><div><h3>Formal requirements</h3><p>Verified SACAP / Cornerstone categories.</p></div></div>${table(['Requirement', 'Completed', 'Progress', 'Remaining', 'Needed / week', 'Projected', 'Status', ...(canSetOpening ? ['Existing hours'] : [])], rows)}
    ${deliverables.length ? `<div class="section"><div><h3>Required deliverables</h3><p>Tracked as completion tasks rather than invented hour values.</p></div></div><div class="card list">${deliverables.map(d => `<div class="row"><div class="grow"><b>${esc(d.name)}</b><br><small class="muted">${responsibilityLabel(d.responsibility)}</small></div><select data-deliverable="${d.id}" aria-label="Status for ${esc(d.name)}"><option ${d.deliverable_status === 'Not started' ? 'selected' : ''}>Not started</option><option ${d.deliverable_status === 'In progress' ? 'selected' : ''}>In progress</option><option ${d.deliverable_status === 'Complete' ? 'selected' : ''}>Complete</option></select></div>`).join('')}</div>` : ''}
    ${pilot ? `<details style="margin-top:14px"><summary style="cursor:pointer;font-weight:800;padding:8px 0">Weekly schedule</summary><div style="margin-top:6px">${weeklyScheduleCard(pilot.schedule, isAdmin, id)}</div></details>` : ''}
    <div class="notice info" style="margin-top:14px"><b>Verified requirement profile:</b> ${esc(req.profile.requirement_profile_name || 'Generic')}. Hour targets are based on the supplied 2026 source material. Site/shared/campus responsibility labels are operational programme classifications and can be adjusted if the institutions specify a different split.</div>`;
  bindGo();
  bindInternSwitcher();
  $$('[data-deliverable]').forEach(sel => sel.onchange = async () => { await api('requirements', { method: 'PATCH', body: JSON.stringify({ intern_profile_id: id, component_id: +sel.dataset.deliverable, status: sel.value }) }); toast('Deliverable updated'); });
  $$('[data-opening]').forEach(btn => btn.onclick = () => openingBalanceModal(req.components.find(x => x.id == btn.dataset.opening), id));
  $('#editSchedule')?.addEventListener('click', () => scheduleModal(id));
  $$('[data-del-schedule]').forEach(b => b.onclick = () => adminDelete('pilot-context', b.dataset.delSchedule, 'placement day', () => go('progress')));
  bindRowExpand();
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
  const rows = data.map(x => `<tr><td><b>${esc(x.case_code)}</b></td><td data-label="Site">${esc(x.site)}</td>${id ? '' : `<td data-label="Intern">${esc(x.intern_name)}</td>`}<td class="mobile-secondary" data-label="Category">${esc(x.presenting_category || '—')}</td><td data-label="Sessions">${x.sessions}</td><td class="mobile-secondary" data-label="Planned frequency">${canPlan ? `<select data-frequency="${x.id}" aria-label="Planned frequency for case ${esc(x.case_code)}"><option value="1" ${Number(x.planned_frequency_weeks) === 1 ? 'selected' : ''}>Weekly</option><option value="2" ${Number(x.planned_frequency_weeks) === 2 ? 'selected' : ''}>Fortnightly</option><option value="4" ${Number(x.planned_frequency_weeks) === 4 ? 'selected' : ''}>Monthly</option></select>` : ({1:'Weekly',2:'Fortnightly',4:'Monthly'}[Number(x.planned_frequency_weeks)] || `Every ${fmt(x.planned_frequency_weeks)} weeks`)}</td><td class="mobile-secondary" data-label="Supervision">${tag(x.supervision_status)}</td><td data-label="Status"><select data-status="${x.id}" aria-label="Status for case ${esc(x.case_code)}">${['Allocated', 'Contact attempted', 'Booked', 'Intake', 'Active', 'Exit review', 'Exited'].map(s => `<option ${s === x.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td><td><button class="btn" data-act="${x.id}" aria-label="Record counselling activity for case ${esc(x.case_code)}">Record session</button></td>${isAdmin ? `<td><button class="btn small danger-btn" data-del-case="${x.id}" data-code="${esc(x.case_code)}" data-sessions="${x.sessions}" aria-label="Delete case ${esc(x.case_code)}">Delete</button></td>` : ''}<td class="mobile-toggle"><button type="button" class="row-expand" aria-expanded="false">More details</button></td></tr>`).join('');
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h2>${S.session.role === 'intern' ? 'My cases' : id ? esc(S.intern.display_name) + ' · cases' : 'All cases'}</h2><p>De-identified workflow. Frequency feeds the caseload adequacy calculation.</p></div>${['programme_lead', 'supervisor'].includes(S.session.role) && id ? '<button id="addCase" class="btn primary">Allocate case</button>' : ''}</div>
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
  $('#addCase')?.addEventListener('click', () => { modal('Allocate de-identified case', `<form id="fCase" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Case code<input name="case_code" placeholder="KHC-026" required></label></div><div class="field"><label>Site<select name="site" required>${siteOptions()}</select></label></div>${siteOtherField()}<div class="field"><label>Presenting category<select name="presenting_category">${presentingCategoryOptions()}</select></label></div>${presentingCategoryOtherField()}<div class="field"><label>Planned frequency<select name="planned_frequency_weeks"><option value="1">Weekly</option><option value="2">Fortnightly</option><option value="4">Monthly</option></select></label></div><div class="full"><button class="btn primary">Allocate</button></div></form>`, 'case allocation'); bindSiteToggle($('#fCase')); bindPresentingCategoryToggle($('#fCase')); });
  bindRowExpand();
}
async function saveCase(e) { if (e.target.id !== 'fCase') return; e.preventDefault(); try { await api('cases', { method: 'POST', body: JSON.stringify(resolvePresentingCategory(resolveSite(Object.fromEntries(new FormData(e.target))))) }); closeModal(); toast('Case allocated'); go('cases'); } catch (x) { toast(x.message); } }
function activityModal(c, selectedDate = today(), returnView = 'cases') { modal('Record counselling activity · ' + c.case_code, `<form id="fActivity" class="formgrid" data-return-view="${esc(returnView)}"><input type="hidden" name="intern_profile_id" value="${c.intern_profile_id}"><input type="hidden" name="case_id" value="${c.id}"><div class="field"><label>Date<input name="encounter_date" type="date" value="${esc(selectedDate)}" required></label></div><div class="field"><label>Session<select name="session_type"><option>Intake</option><option>Follow-up</option><option>Termination</option></select></label></div><div class="field"><label>Booked<select name="booked"><option value="true">Yes</option><option value="false">No</option></select></label></div><div class="field"><label>Attended<select name="attended"><option value="true">Yes</option><option value="false">No</option></select></label></div><div class="field"><label>Duration if attended (minutes)<input name="duration_minutes" type="number" min="1" max="480" value="60"></label></div><div class="field"><label>Gender for monthly statistics<select name="patient_gender"><option>Female</option><option>Male</option><option>Other</option><option>Unknown</option></select></label></div><div class="full"><button class="btn primary">Save activity</button></div></form>`); }
async function saveActivity(e) { if (e.target.id !== 'fActivity') return; e.preventDefault(); const returnView = e.target.dataset.returnView || 'cases'; try { await api('encounters', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Session recorded'); go(returnView); } catch (x) { toast(x.message); } }

async function daily() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), selectedDate = S.dailyDate || today();
  const [data, hoursData] = await Promise.all([api(`daily-summary?intern_id=${id}&date=${selectedDate}`), api(`hours?intern_id=${id}`)]);
  const s = data.stats || {};
  const missingGender = Number(s.not_recorded_gender || 0);
  const sessionRows = (data.encounters || []).map(x => `<div class="row"><div class="grow"><b>${esc(x.case_code || 'De-identified case')}</b><br><small class="muted">${esc(x.session_type)} · ${x.booked ? 'Booked' : 'Not booked'} · ${x.attended ? `Attended · ${fmt(x.duration_minutes)} min · ${esc(x.patient_gender || 'Unknown')}` : 'Did not attend'} · ${esc(x.site || 'Facility not recorded')}</small></div>${tag(x.attended ? 'Attended' : 'DNA')}</div>`).join('');
  const activityRows = (data.activities || []).map(x => `<div class="row"><div class="grow"><b>${esc(x.service_type || x.category)}</b><br><small class="muted">${esc(x.category)} · ${esc(x.site || 'Facility not recorded')}${x.note ? ' · ' + esc(x.note) : ''}</small></div><b>${fmt(x.hours)} h</b></div>`).join('');
  $('#content').innerHTML = switcherHtml + `<div class="hero"><small>Daily close-out</small><h2>How was today?</h2><p>Record today’s work once. The totals below come from the same case sessions and activity entries used in Reports and practicum-hour calculations.</p><div class="actions"><button id="dailySession" class="btn">Record individual session</button><button id="dailyOther" class="btn">Log another activity</button></div></div>
    <div class="section"><div><h3>Daily summary</h3><p>Choose a date to review or complete.</p></div><div class="field" style="min-width:180px"><label>Date<input id="dailyDate" type="date" value="${esc(selectedDate)}"></label></div></div>
    <div class="grid three">${metric('Booked', s.booked || 0)}${metric('Attended', s.attended || 0)}${metric('Did not attend', s.did_not_attend || 0)}${metric('Female', s.female || 0)}${metric('Male', s.male || 0)}${metric('Intake sessions', s.intake_sessions || 0)}${metric('Follow-up sessions', s.follow_up_sessions || 0)}${metric('Counselling time', `${fmt((s.counselling_minutes || 0) / 60)} h`)}${metric('Other activities', (data.activities || []).length)}</div>
    ${missingGender ? `<div class="notice amber" style="margin-top:14px"><b>Complete today’s records:</b> ${missingGender} attended session${missingGender === 1 ? ' has' : 's have'} no gender recorded.</div>` : ''}
    <div class="grid two" style="margin-top:14px"><div><div class="section"><h3>Individual counselling</h3></div><div class="card list">${sessionRows || 'No individual sessions recorded for this date.'}</div></div><div><div class="section"><h3>Other practicum activity</h3></div><div class="card list">${activityRows || 'No additional activities recorded for this date.'}</div></div></div>
    <div class="notice info" style="margin-top:14px"><b>No duplicate capture:</b> individual sessions recorded here are saved in Case workflow and counted automatically. The Activity form includes Individual, Group and Family counselling; use Individual there only when the session is not already recorded against a case.</div>`;
  bindInternSwitcher();
  $('#dailyDate').onchange = e => { S.dailyDate = e.target.value; go('daily'); };
  $('#dailySession').onclick = () => {
    if (!(data.cases || []).length) return toast('No active case is available. Add or activate a case first.');
    modal('Choose a case', `<div class="card list">${data.cases.map(c => `<button class="btn" data-daily-case="${c.id}">${esc(c.case_code)} · ${esc(c.site)}</button>`).join('')}</div>`);
    $$('[data-daily-case]').forEach(b => b.onclick = () => activityModal(data.cases.find(c => c.id == b.dataset.dailyCase), selectedDate, 'daily'));
  };
  $('#dailyOther').onclick = () => activityHoursModal(id, hoursData.components, selectedDate, 'daily');
}

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
  const id = activeId(), [data, overview] = await Promise.all([api(`supervision?intern_id=${id}`), api(`intern-overview?intern_id=${id}`)]), isIntern = S.session.role === 'intern', isAdmin = S.session.role === 'programme_lead';
  // Prompt 8: "improve the empty state with safe examples" — de-identified,
  // generic scenarios that model good use without referencing any real
  // patient, so the empty state doubles as a quick example of what belongs
  // here.
  const SUPERVISION_EXAMPLES = [
    'Risk assessment approach for a client presenting with passive suicidal ideation',
    'How to structure a termination session when a client discontinues abruptly',
    'Formulation uncertainty on a case with overlapping anxiety and grief presentations'
  ];
  const emptyState = `<div class="notice info"><b>No supervision items yet.</b> A good supervision item is a specific question, e.g.:<ul style="margin:8px 0 0;padding-left:18px">${SUPERVISION_EXAMPLES.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  const dueLabel = x => {
    if (!x.due_date) return '';
    const overdue = x.due_date < today() && x.status === 'Open';
    return ` ${overdue ? `<span class="tag red">Due ${esc(x.due_date)} — overdue</span>` : `<span class="tag">Due ${esc(x.due_date)}</span>`}`;
  };
  const agenda = [];
  data.filter(x => x.status === 'Open').forEach(x => agenda.push({severity:x.priority === 'Risk / urgent'?'red':'amber',label:`Supervision question: ${x.topic}`}));
  overview.referrals.filter(x => referralDaysOverdue(x) > 0).forEach(x => agenda.push({severity:'red',label:`Referral ${x.referral_code}: next action overdue`}));
  const staleCutoff = new Date(Date.now()-21*86400000);
  overview.cases.filter(x => ['Intake','Active','Exit review'].includes(x.status) && new Date(x.updated_at) < staleCutoff).forEach(x => agenda.push({severity:'amber',label:`Case ${x.case_code}: review progress`}));
  overview.milestones.filter(x => x.due_date && !['Complete','Not applicable'].includes(x.status) && x.due_date <= new Date(Date.now()+14*86400000).toISOString().slice(0,10)).forEach(x => agenda.push({severity:x.due_date<today()?'red':'amber',label:`Milestone: ${x.title} · due ${x.due_date}`}));
  const agendaHtml = `<div class="card" style="margin-bottom:14px"><h3>Suggested supervision agenda</h3><p class="muted">Prepared from open questions, overdue referral actions, inactive cases and placement milestones.</p><div class="list">${agenda.map(x=>`<div class="row"><span class="tag ${x.severity}">${x.severity==='red'?'Priority':'Review'}</span><div class="grow">${esc(x.label)}</div></div>`).join('')||'<div class="queue-empty">No operational concerns detected. Use the session for reflective learning and development.</div>'}</div></div>`;
  $('#content').innerHTML = switcherHtml + agendaHtml + `<div class="section"><div><h2>${isIntern ? 'Prepare for supervision' : esc(S.intern?.display_name || '') + ' · supervision'}</h2><p>Turn uncertainty into a specific supervision question before the session.</p></div><button id="addSup" class="btn primary">Add supervision item</button></div><div class="card list">${data.map(x => `<div class="row"><div class="grow"><b>${esc(x.topic)}</b> ${x.case_code ? `<span class="tag">${esc(x.case_code)}</span>` : ''}${dueLabel(x)}<br><span>${esc(x.question)}</span>${x.action_taken ? `<br><small class="muted">Already tried: ${esc(x.action_taken)}</small>` : ''}${x.supervisor_note ? `<br><small><b>Response:</b> ${esc(x.supervisor_note)}</small>` : ''}<br><small class="muted">${x.assigned_supervisor_name ? `Assigned to ${esc(x.assigned_supervisor_name)}` : 'Not yet assigned to a specific supervisor'}</small></div>${tag(x.priority)} ${tag(x.status)}${!isIntern && x.status === 'Open' ? `<button class="btn" data-review="${x.id}" aria-label="Review supervision item: ${esc(x.topic)}">Review</button>` : ''}${isAdmin ? `<button class="btn small danger-btn" data-del-sup="${x.id}" data-topic="${esc(x.topic)}" aria-label="Delete supervision item: ${esc(x.topic)}">Delete</button>` : ''}</div>`).join('') || emptyState}</div>`;
  bindInternSwitcher();
  $('#addSup').onclick = () => supervisionModal(id);
  $$('[data-review]').forEach(b => b.onclick = () => { const x = data.find(i => i.id == b.dataset.review); modal('Review supervision item', `<form id="fSupReview"><input type="hidden" name="id" value="${x.id}"><div class="field"><label>Supervisor response<textarea name="supervisor_note">${esc(x.supervisor_note || '')}</textarea></label></div><div class="field"><label>Due date<input name="due_date" type="date" value="${esc(x.due_date || '')}"></label></div><div class="field"><label>Status<select name="status"><option>Open</option><option selected>Reviewed</option><option>Closed</option></select></label></div><button class="btn primary">Save</button></form>`); });
  $$('[data-del-sup]').forEach(b => b.onclick = () => adminDelete('supervision', b.dataset.delSup, `supervision item “${b.dataset.topic}”`, () => go('supervision'), {
    message: `This permanently deletes the supervision item “${esc(b.dataset.topic)}” unless undone. It can be restored from the confirmation toast right after deleting.`,
    reason: { required: false, label: 'Reason (optional)' },
    restorePath: 'audit-restore'
  }));
}
function supervisionModal(id, preset = {}) { modal('Add to supervision', `<form id="fSup" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Topic<input name="topic" value="${esc(preset.topic || '')}" required></label></div><div class="field"><label>Priority<select name="priority"><option>Routine</option><option>Important</option><option>Risk / urgent</option></select></label></div><div class="field"><label>Due date (optional)<input name="due_date" type="date"></label></div><div class="full field"><label>What exactly are you unsure about?<textarea name="question" required>${esc(preset.question || '')}</textarea></label></div><div class="full field"><label>What have you already considered / tried?<textarea name="action_taken">${esc(preset.action_taken || '')}</textarea></label></div><div class="full"><button class="btn primary">Add to supervision</button></div></form>`); }
async function saveSup(e) { if (e.target.id !== 'fSup') return; e.preventDefault(); try { await api('supervision', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Added to supervision'); if (S.view === 'supervision') go('supervision'); } catch (x) { toast(x.message); } }
async function saveSupReview(e) { if (e.target.id !== 'fSupReview') return; e.preventDefault(); try { await api('supervision', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); closeModal(); toast('Supervision updated'); go('supervision'); } catch (x) { toast(x.message); } }

// Prompt 8: "define behavioural anchors for ratings 1–5" — one shared
// rubric across all nine fixed competencies (their own descriptions
// already say what each competency covers; this says what each rating
// number means for any of them).
const COMPETENCY_ANCHORS = [
  [1, 'Not yet demonstrated', 'Requires direct supervisor guidance or modelling to attempt this.'],
  [2, 'Emerging', 'Attempts this with significant support and prompting.'],
  [3, 'Developing', 'Performs this independently in straightforward situations.'],
  [4, 'Competent', 'Performs this independently and consistently across varied situations.'],
  [5, 'Advanced', 'Performs this independently, adapts it to complex situations, and can model it for others.']
];
function competencyAnchorsHtml() {
  return `<details class="card" style="margin-bottom:14px"><summary style="cursor:pointer;font-weight:800">What each rating means (1–5)</summary><dl class="definitions">${COMPETENCY_ANCHORS.map(([n, label, desc]) => `<dt>${n} — ${esc(label)}</dt><dd>${esc(desc)}</dd>`).join('')}</dl></details>`;
}
async function competencies() {
  const switcherHtml = await internSwitcherHtml();
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), data = await api(`competencies?intern_id=${id}`), isIntern = S.session.role === 'intern';
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h2>${isIntern ? 'My competency development' : 'Competency development'}</h2><p>Ratings are supported by evidence and supervisor feedback.</p></div></div>${competencyAnchorsHtml()}<div class="grid three">${data.map(x => `<div class="card competency"><b>${esc(x.name)}</b><p class="muted">${esc(x.description)}</p><div class="rating"><span>Intern</span><b>${x.intern_rating || '—'} / 5</b><span>Supervisor</span><b>${x.supervisor_rating || '—'} / 5</b></div>${x.evidence ? `<p><small><b>Evidence:</b> ${esc(x.evidence)}</small></p>` : ''}${x.supervisor_comment ? `<p><small><b>Feedback:</b> ${esc(x.supervisor_comment)}</small></p>` : ''}${x.history?.length ? `<details><summary>History (${x.history.length})</summary><div class="list" style="margin-top:6px">${x.history.map(h => `<div class="row"><div class="grow"><small>${h.actor_role === 'intern' ? 'Self' : 'Supervisor'} rating ${h.intern_rating ?? h.supervisor_rating ?? '—'}/5 by ${esc(h.actor_name || 'unknown')}</small></div><small class="muted">${esc(new Date(h.created_at).toLocaleDateString())}</small></div>`).join('')}</div></details>` : ''}<button class="btn" data-comp="${x.id}" aria-label="${isIntern ? 'Update reflection for' : 'Assess'} ${esc(x.name)}">${isIntern ? 'Update reflection' : 'Assess / feedback'}</button></div>`).join('')}</div>`;
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
const PRACTICUM_ACTIVITY_TYPES = [
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
];
function practicumActivityTypeOptions(selected = 'Other professional activity') {
  return PRACTICUM_ACTIVITY_TYPES.map(type => `<option ${type === selected ? 'selected' : ''}>${esc(type)}</option>`).join('');
}

function activityHoursModal(id, components, selectedDate = today(), returnView = 'hours') {
  const opts = components.map(c => `<option value="${esc(c.code)}">${esc(c.manual_label || c.name)}</option>`).join('');
  modal('Log practicum activity', `<form id="fHours" class="formgrid" data-return-view="${esc(returnView)}"><input type="hidden" name="intern_profile_id" value="${id}"><div class="full field"><label>Formal requirement<select name="component_code" required>${opts}</select></label></div><div class="field"><label>Activity type<select name="service_type" required>${practicumActivityTypeOptions()}</select></label><small class="muted">Includes Individual, Group and Family counselling. Do not log an individual session again if it is already in Case workflow.</small></div><div class="field"><label>Facility<select name="site" required>${siteOptions()}</select></label></div>${siteOtherField()}<div class="field"><label>Date<input name="work_date" type="date" value="${esc(selectedDate)}" required></label></div><div class="field"><label>Hours<input name="hours" type="number" min="0.25" max="24" step="0.25" required></label></div><div class="full field"><label>Brief description<textarea name="note" placeholder="No patient-identifying information"></textarea></label></div><div class="full"><button class="btn primary">Save hours</button></div></form>`);
  bindSiteToggle($('#fHours'));
}

async function hours() {
  const switcherHtml = await internSwitcherHtml({ allowAll: true });
  if (!activeId() && ['programme_lead', 'supervisor'].includes(S.session.role)) return hoursAllView(switcherHtml);
  if (!needIntern(switcherHtml)) { bindInternSwitcher(); return; }
  const id = activeId(), [data, req] = await Promise.all([api(`hours?intern_id=${id}`), api(`requirements?intern_id=${id}`)]);
  const isAdmin = S.session.role === 'programme_lead';
  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h2>Activity log</h2><p>Log each practicum activity against the institution’s formal category.</p></div><button id="logHours" class="btn primary">Log activity hours</button></div>
    <div class="grid two"><div class="notice info"><b>Avoid double-counting individual sessions.</b><br>Sessions already recorded against a case are counted automatically. Use “Individual counselling” here only when the session is not recorded in Case workflow.</div><div class="card"><b>${esc(req.profile.requirement_profile_name || '')}</b><p class="muted">${fmt(req.summary.total_completed)} of ${fmt(req.summary.total_target)} formal hours currently recorded.</p>${progressBar(req.summary.total_completed, req.summary.total_target)}</div></div>
    <div class="section"><h3>Recent activity</h3></div><div class="card list">${data.entries.map(x => `<div class="row"><div class="grow"><b>${esc(x.component_name || x.category)}</b>${x.correction_history?.length ? ` <span class="tag amber">Corrected ×${x.correction_history.length}</span>` : ''}<br><small class="muted">${esc(x.work_date)} · ${esc(x.service_type || 'Legacy activity type not recorded')} · ${esc(x.site || 'Facility not recorded')}${x.note ? ' · ' + esc(x.note) : ''}</small>${x.correction_history?.length ? `<details><summary>Correction history</summary><div class="list" style="margin-top:6px">${x.correction_history.map(h => `<div class="row"><div class="grow"><small>${esc(h.reason || 'No reason recorded')}${h.before && h.after ? ` — ${fmt(h.before.hours)} h → ${fmt(h.after.hours)} h` : ''}</small></div><small class="muted">${esc(new Date(h.created_at).toLocaleDateString())}</small></div>`).join('')}</div></details>` : ''}</div><b>${fmt(x.hours)} h</b>${isAdmin ? `<button class="btn small" data-edit-hours="${x.id}" aria-label="Edit activity entry: ${esc(x.component_name || x.category)} on ${esc(x.work_date)}">Edit</button> <button class="btn small danger-btn" data-del-hours="${x.id}" aria-label="Delete activity entry: ${esc(x.component_name || x.category)} on ${esc(x.work_date)}">Delete</button>` : ''}</div>`).join('') || 'No manually logged activity yet.'}</div>`;
  bindInternSwitcher();
  $('#logHours').onclick = () => activityHoursModal(id, data.components);
  // Prompt 4: "a correction workflow for logged hours rather than silent
  // destructive deletion" — Edit updates the entry in place (with a
  // mandatory reason, audited as a before/after pair) instead of requiring
  // programme_lead to delete and re-create it.
  $$('[data-edit-hours]').forEach(b => b.onclick = () => {
    const x = data.entries.find(e => e.id == b.dataset.editHours);
    modal('Correct activity entry', `<form id="fHoursEdit" class="formgrid"><input type="hidden" name="id" value="${x.id}"><div class="full field"><label>Formal requirement<select name="component_code" required>${data.components.map(c => `<option value="${esc(c.code)}" ${c.code === x.component_code ? 'selected' : ''}>${esc(c.manual_label || c.name)}</option>`).join('')}</select></label></div><div class="field"><label>Activity type<select name="service_type" required>${practicumActivityTypeOptions(x.service_type || 'Other professional activity')}</select></label></div><div class="field"><label>Facility<select name="site" required>${siteOptions(x.site || '')}</select></label></div>${siteOtherField(x.site || '')}<div class="field"><label>Date<input name="work_date" type="date" value="${esc(x.work_date)}" required></label></div><div class="field"><label>Hours<input name="hours" type="number" min="0.25" max="24" step="0.25" value="${x.hours}" required></label></div><div class="full field"><label>Brief description<textarea name="note" placeholder="No patient-identifying information">${esc(x.note || '')}</textarea></label></div><div class="full field"><label>Reason for this correction<textarea name="reason" required placeholder="e.g. wrong category selected, date entered incorrectly"></textarea></label></div><div class="full"><button class="btn primary">Save correction</button></div></form>`); bindSiteToggle($('#fHoursEdit'));
  });
  $$('[data-del-hours]').forEach(b => b.onclick = () => adminDelete('hours', b.dataset.delHours, 'activity entry', () => go('hours'), {
    message: 'This permanently deletes this logged activity entry. This cannot be undone — for a wrong category, date or hours value, use Edit instead.',
    reason: { required: true, label: 'Reason for deleting' }
  }));
}
async function saveHours(e) { if (e.target.id !== 'fHours') return; e.preventDefault(); const returnView = e.target.dataset.returnView || 'hours'; try { await api('hours', { method: 'POST', body: JSON.stringify(resolveSite(Object.fromEntries(new FormData(e.target)))) }); closeModal(); toast('Activity saved'); go(returnView); } catch (x) { toast(x.message); } }
async function saveHoursCorrection(e) { if (e.target.id !== 'fHoursEdit') return; e.preventDefault(); try { await api('hours', { method: 'PATCH', body: JSON.stringify(resolveSite(Object.fromEntries(new FormData(e.target)))) }); closeModal(); toast('Activity entry corrected'); go('hours'); } catch (x) { toast(x.message); } }

// Prompt 7: builds the CSV export from exactly the rows/fields the page
// renders (never a separate recomputation), so an exported total can always
// be reconciled against what's on screen and, from there, against the
// source records the server derived it from.
function buildReportCsv(internName, selectedMonth, s, hoursRows, corrections, activityBreakdown = []) {
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
  rows.push(['Counselling/activity type', 'Facility', 'Hours']);
  activityBreakdown.forEach(x => rows.push([x.service_type, x.site, x.hours]));
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
  const activityBreakdown = data.activity_breakdown || [];
  const activityBreakdownHtml = activityBreakdown.length
    ? table(['Counselling / activity type', 'Facility', 'Hours'], activityBreakdown.map(x => `<tr><td>${esc(x.service_type)}</td><td>${esc(x.site)}</td><td>${fmt(x.hours)} h</td></tr>`).join(''))
    : '<div class="card">No activity recorded for this period.</div>';
  const correctionsHtml = corrections.length
    ? corrections.map(c => `<div class="row"><div class="grow">Activity entry #${esc(c.entity_id)} was corrected</div><small class="muted">${esc(c.reason || 'No reason recorded')} · ${esc(new Date(c.created_at).toLocaleDateString())}</small></div>`).join('')
    : 'No corrections recorded this period — the figures above are as originally entered.';

  const trend = data.trend || [];
  const trendMonthsWithData = trend.filter(t => t.booked || t.attended || t.hours).length;
  const trendHtml = trendMonthsWithData >= 2
    ? `<div class="tablewrap"><table><thead><tr><th>Month</th><th>Booked</th><th>Attended</th><th>Hours logged</th></tr></thead><tbody>${trend.map(t => `<tr><td><b>${esc(monthLabel(t.month))}</b></td><td data-label="Booked">${t.booked}</td><td data-label="Attended">${t.attended}</td><td data-label="Hours logged">${fmt(t.hours)} h</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">Not enough history yet for a trend — at least two months of activity are needed.</p>`;

  const reviewHistoryHtml = (data.review_history || []).length
    ? data.review_history.map(h => `<div class="row"><div class="grow">${h.action === 'review' ? 'Marked reviewed' : 'Submitted'}${h.reason ? ` — ${esc(h.reason)}` : ''}</div><small class="muted">${esc(new Date(h.created_at).toLocaleString())}</small></div>`).join('')
    : 'No review history yet.';

  $('#content').innerHTML = switcherHtml + `<div class="section"><div><h2>${isIntern ? 'My monthly report' : 'Monthly report'} · ${esc(internName || '')}</h2><p>${esc(institution || 'Institution not set')} · ${esc(monthLabel(selectedMonth))}</p></div><span class="tag">${esc(data.report.status)}</span></div>
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
    <div class="section"><div><h3>Activity by type and facility</h3><p>Individual sessions come from attended encounters; group, family and other activities come from the activity log.</p></div></div>${activityBreakdownHtml}
    <div class="grid two" style="margin-top:14px">
      <div><div class="section tight"><h3>Corrected this period</h3></div><div class="card list">${correctionsHtml}</div></div>
      <div><div class="section tight"><h3>Review history</h3></div><div class="card list">${reviewHistoryHtml}</div></div>
    </div>
    <div class="section"><h3>Trend (last 6 months)</h3></div><div class="card">${trendHtml}</div>
    <div class="section"><h3>${isIntern ? 'Submission' : 'Supervisor review'}</h3></div><div class="card field"><label>${isIntern ? 'Reflection / notable activity' : 'Supervisor comment'}<textarea id="comment">${esc(isIntern ? data.report.intern_comment || '' : data.report.supervisor_comment || '')}</textarea></label><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px" class="no-print"><button id="sendReport" class="btn primary">${reviewBtnLabel}</button><button id="exportCsv" class="btn" type="button">Export CSV</button><button id="printReport" class="btn" type="button">Print / Save as PDF</button></div></div>`;
  bindInternSwitcher();
  $('#reportMonth').onchange = e => { S.reportsMonth = e.target.value; go('reports'); };
  $('#exportCsv').onclick = () => downloadCsv(`report-${(internName || 'intern').replace(/\s+/g, '_')}-${selectedMonth}.csv`, buildReportCsv(internName, selectedMonth, s, data.hours || [], corrections, activityBreakdown));
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
  $('#content').innerHTML=switcherHtml+`<div class="hero"><small>Live pilot</small><h2>${isIntern?'Help shape the Practicum Hub.':'Pilot feedback'}</h2><p>${isIntern?'Tell us what is useful, what gets in your way, and what you expected to find but could not.':'Review what the intern is experiencing so the system improves during the pilot.'}</p></div>
    ${isIntern?`<div class="card" style="margin-top:14px"><form id="fFeedback" class="formgrid"><input type="hidden" name="intern_profile_id" value="${id}"><div class="field"><label>Type<select name="feedback_type"><option>What worked</option><option>What was frustrating</option><option>I could not find something</option><option>Suggestion</option><option>General</option></select></label></div><div class="field"><label>How useful was the Hub today? (1–5)<input name="rating" type="number" min="1" max="5"></label></div><div class="full field"><label>Feedback<textarea name="message" required placeholder="Be specific — what were you trying to do?"></textarea></label></div><div class="full"><button class="btn primary">Send feedback</button></div></form></div>`:''}
    <div class="section"><div><h3>Feedback history</h3><p>Used during the Erin pilot to drive weekly iteration.</p></div></div><div class="card list">${data.map(x=>`<div class="row"><div class="grow"><b>${esc(x.feedback_type)}</b> ${x.rating?`<span class="tag">${x.rating}/5</span>`:''}<br><span>${esc(x.message)}</span><br><small class="muted">${esc(String(x.created_at||'').slice(0,10))}${x.context_view?' · '+esc(x.context_view):''}</small></div>${tag(x.status||'New')}${isAdmin?`<button class="btn small danger-btn" data-del-feedback="${x.id}" data-type="${esc(x.feedback_type)}" aria-label="Delete ${esc(x.feedback_type)} feedback entry">Delete</button>`:''}</div>`).join('')||'No feedback yet.'}</div>`;
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
  $('#content').innerHTML = `<div class="hero assistant-hero"><small>Grounded practicum support</small><h2>What are you stuck with?</h2><p>This assistant uses the approved handbook and live placement data to help you think, find the right procedure, prepare for supervision and recognise when to escalate. It does not diagnose or replace supervision.</p></div>
    <div class="assistant-layout"><div><div class="section"><h3>Common challenges</h3></div><div class="help-grid">${GUIDES.map(g => `<button class="help-tile" data-guide="${g.key}"><b>${g.title}</b><span>Get a structured next step</span></button>`).join('')}</div></div>
    <div class="card"><h3>Ask the Practicum Hub</h3><p class="muted">Do not enter names, ID numbers, phone numbers, addresses or other identifying patient details.</p><textarea id="ask" rows="5" aria-label="Ask the Practicum Hub a question" placeholder="Example: I’m not sure how to structure the next session, or am I on track with my counselling hours?">${esc(S.assistantSeed || '')}</textarea><button id="askBtn" class="btn primary">Get grounded guidance</button><div id="answer" class="assistant-answer"></div></div></div>`;
  S.assistantSeed = '';
  $$('[data-guide]').forEach(b => b.onclick = () => answerGuide(GUIDES.find(g => g.key === b.dataset.guide), id));
  $('#askBtn').onclick = () => answerQuestion($('#ask').value, id);
  if ($('#ask').value) $('#askBtn').click();
}
async function answerGuide(guide, id) {
  const answer = $('#answer');
  answer.innerHTML = `<div class="assistant-response"><h3>${esc(guide.title)}</h3><p>${guide.body}</p>${guide.key === 'risk' ? '<button class="btn danger-btn" id="openEmergency">Open emergency guide</button>' : ''}${guide.key === 'supervision' && id ? '<button class="btn" id="toSup">Add this to supervision</button>' : ''}${guide.key === 'hours' && id ? '<div id="hoursHelp">Loading your pace…</div>' : ''}</div>`;
  $('#openEmergency')?.addEventListener('click', openEmergency);
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
  $('#content').innerHTML = `<div class="hero"><h2>Evidence accumulates while the programme runs.</h2><p>Access, attendance, requirement completion and supervision demand become programme evidence without rebuilding the story retrospectively.</p></div>
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
  const meta = H.meta || {};
  // Prompt 8: "add document version, content owner, approval date and
  // review date" — shown honestly: fields the programme hasn't set yet say
  // so instead of a placeholder that looks like a real date.
  const metaLine = `Version ${esc(meta.version || '—')} · Content owner: ${meta.contentOwner ? esc(meta.contentOwner) : '<b>not yet configured</b>'} · Approved: ${meta.approvedDate ? esc(meta.approvedDate) : '<b>not yet configured</b>'} · Next review: ${meta.reviewDate ? esc(meta.reviewDate) : '<b>not yet configured</b>'}`;
  $('#content').innerHTML = `<div class="notice info" style="margin-bottom:10px">${metaLine}</div>
    <div class="handbook"><div class="hindex"><div style="padding:10px"><label class="sr-only" for="hsearch">Search handbook</label><input id="hsearch" placeholder="Search handbook…"><p class="muted" style="font-size:11px;margin:8px 0 0">Section numbers follow the original handbook document order; they're grouped by topic below for easier browsing, so numbers within a group are not always consecutive.</p></div><nav id="hlist" class="hlist" aria-label="Handbook sections"></nav></div><article class="harticle"><div class="hhead"><small id="hnum"></small><h2 id="htitle"></h2><button id="askSection" class="btn ghost">Ask about this section</button></div><div id="hbody" class="hbody"></div></article></div>`;
  // Prompt 2: these were clickable <div>s — not focusable, not announced as
  // interactive, and not operable with Enter/Space. Real <button>s fix all
  // three at once; .hitem's CSS resets the browser's default button chrome
  // so the look is unchanged.
  const draw = (q = '') => {
    $('#hlist').innerHTML = '';
    H.catOrder.forEach(c => {
      const matches = H.sections.map((s, i) => ({ s, i })).filter(x => x.s.cat === c && (x.s.title + ' ' + x.s.search + ' ' + x.s.content.replace(/<[^>]+>/g, ' ')).toLowerCase().includes(q.toLowerCase()));
      if (!matches.length) return;
      $('#hlist').insertAdjacentHTML('beforeend', `<div class="hcat">${H.catNames[c]}</div>` + matches.map(x => `<button type="button" class="hitem ${x.i === S.handbookSection ? 'active' : ''}" data-h="${x.i}"${x.i === S.handbookSection ? ' aria-current="true"' : ''}>${esc(x.s.num)}. ${esc(x.s.title)}</button>`).join(''));
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
  serviceStats:[],interns:[{id:11,email:'erin.pilot@example.test',display_name:'Erin George',institution:'SACAP',active_cases:0,open_supervision:0,active:true,identity_user_id:'erin-pilot',placement_start:'2026-05-18',placement_end:'2026-11-12'}],
  cases:[], appointments:{11:[]}, sup:{11:[]}, feedback:{11:[]}, milestones:{11:[
    {id:1,title:'Orientation completed',status:'Complete',due_date:'2026-05-18'},
    {id:2,title:'Mid-placement evaluation',status:'Complete',due_date:'2026-08-03'},
    {id:3,title:'Final evaluation',status:'Not started',due_date:'2026-11-02'},
    {id:4,title:'Logbook verification',status:'In progress',due_date:'2026-11-09'},
    {id:5,title:'Exit interview',status:'Not started',due_date:'2026-11-12'}
  ]}, schedule:{11:[{weekday:1,start_time:'08:00',end_time:'10:00',title:'Supervision with Vivian',site:'Stellenbosch Hospital',activity_type:'Supervision',recurrence_note:'Every Monday'},{weekday:1,start_time:'10:30',title:'Patient sessions',site:'Stellenbosch Hospital',activity_type:'Clinical',recurrence_note:'3–4 bookings'},{weekday:2,start_time:'08:30',title:'Clinic day',site:'Don & Pat or Jamestown Clinic',activity_type:'Clinical + community',recurrence_note:'Patients throughout the day + one psychoeducation/community talk'},{weekday:3,start_time:'08:30',title:'Alternating clinical day',site:'Stellenbosch Hospital / Night Shelter',activity_type:'Clinical',recurrence_note:'Alternates weekly'},{weekday:4,start_time:'08:30',title:'Clinic day',site:'Idas Valley Clinic',activity_type:'Clinical',recurrence_note:'SACAP supervision at 12:00, then patients'},{weekday:5,title:'Campus day',site:'SACAP campus',activity_type:'Campus',recurrence_note:'Every Friday'}]}, planned:{11:[{activity_date:'2026-10-01',title:'Make Mental Health Everybody’s Business campaign',component_code:'psychoeducation-community',site:'Subdistrict campaign',planned_hours:null,preparation_hours:null,status:'Planned',note:'Design posters and “Did you know?” mental-health snippets; preparation begins from 1 October'},{activity_date:'2026-10-09',title:'Preschool mental-health activity',component_code:'psychoeducation-community',site:'Preschool',planned_hours:5,preparation_hours:null,status:'Planned',note:'Programme design and preparation hours to be logged when known'},{activity_date:'2026-10-23',title:'Care at the Retreat event',component_code:'psychoeducation-community',site:'Retreat',planned_hours:6,preparation_hours:18,status:'Planned',note:'Needs analysis, programme preparation and event delivery'},{activity_date:null,title:'Ebenezer activity',component_code:'psychoeducation-community',site:'Ebenezer',planned_hours:null,preparation_hours:4,status:'Planned',note:'Date and event hours to confirm'}]},
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
  if(route==='dashboard'){if(S.session.role==='intern')return{metrics:{active_cases:0,open_supervision:0},requirements:demoRequirement(11)};if(S.session.role==='management')return demoProgramme(d);const interns=d.interns.map(x=>({...x,requirements:demoRequirement(x.id).summary,requirement_profile_name:demoRequirement(x.id).profile.requirement_profile_name,snapshot:{referrals_total:12,referrals_open:9,referrals_accepted:10,awaiting_acceptance:2,contact_attempts:18,patients_contacted:9,no_response:2,booked:6,booked_week:7,attended_week:5,dna_week:2,intakes_week:2,followups_week:3,activities_week:3,hours_week:18.5,outstanding:2,upcoming_week:[{weekday:4,title:'Clinic day',site:'Idas Valley Clinic'},{weekday:5,title:'Campus day',site:'SACAP campus'}]}}));const atRisk=interns.reduce((n,p)=>n+(p.requirements.at_risk_components>0?1:0),0);return{interns,metrics:{interns:interns.length,active_cases:0,open_supervision:0,at_risk:atRisk},queue:[{severity:'amber',title:'Erin George: two referrals need follow-up',reason:'No successful contact has been recorded yet.',view:'referrals',intern_id:11}]};}
  if(route==='interns'){
    if(method==='PATCH'&&body.action==='resend_invite')return{ok:true,resent_id:+body.id};
    if(method==='PATCH'&&body.action==='reactivate')return{ok:true,reactivated_id:+body.id};
    if(method==='PATCH'&&body.action==='purge_test_intern'){d.interns=d.interns.filter(x=>x.id!==+body.id);return{ok:true,purged_id:+body.id};}
    return d.interns.map(x=>({...x,requirement_summary:demoRequirement(x.id).summary,invite:x.invite||{status:'Active',invited_at:'2026-05-10',last_sign_in_at:'2026-09-18'}}));
  }
  if(route==='pilot-context')return {schedule:d.schedule[id]||[],planned:d.planned[id]||[]};
  if(route==='intern-overview')return{profile:d.interns.find(x=>x.id===id)||d.interns[0],requirements:demoRequirement(id||11),referrals:d.referrals.filter(x=>x.intern_profile_id===id),cases:d.cases.filter(x=>x.intern_profile_id===id),supervision:d.sup[id]||[],milestones:d.milestones[id]||[],schedule:d.schedule[id]||[],reports:[]};
  if(route==='milestones'){let items=d.milestones[id]||[];if(method==='GET')return items;const x=items.find(x=>x.id===+body.id);if(x)Object.assign(x,body);return x||body;}
  if(route==='feedback'){if(method==='GET')return d.feedback[id]||[];(d.feedback[id]||=[]).unshift({...body,id:Date.now(),status:'New',created_at:new Date().toISOString()});return body;}
  if(route==='requirements'){if(method==='PATCH')return body;return demoRequirement(id||11);}
  if(route==='cases'){if(method==='GET')return id?d.cases.filter(x=>x.intern_profile_id===id):d.cases;let x=d.cases.find(x=>x.id===+body.id);if(method==='PATCH'){Object.assign(x,body);return x}if(method==='POST'){const n={...body,id:Date.now(),intern_profile_id:+body.intern_profile_id,sessions:0,supervision_status:'Not yet',status:'Allocated'};d.cases.push(n);return n;}}
  if(route==='referrals'){if(method==='GET')return d.referrals;let x=d.referrals.find(x=>x.id===+body.id);if(method==='PATCH'){if(body.action==='accept'){x.accepted_at=new Date().toISOString();return x;}Object.assign(x,body);return x}const n={...body,id:Date.now(),intern_profile_id:id||+body.intern_profile_id||11,intern_name:'Erin George',contact_attempts:+body.contact_attempts||0};d.referrals.push(n);return n;}
  if(route==='encounters'){if(method==='GET')return d.enc.filter(x=>x.intern_profile_id===id);d.enc.push({...body,id:Date.now(),intern_profile_id:+body.intern_profile_id,booked:String(body.booked)!=='false',attended:String(body.attended)!=='false',duration_minutes:+body.duration_minutes||0,site:d.cases.find(c=>c.id===+body.case_id)?.site||'',case_code:d.cases.find(c=>c.id===+body.case_id)?.case_code||''});return body;}
  if(route==='daily-summary'){
    const day=q.get('date')||today(),enc=d.enc.filter(x=>x.intern_profile_id===id&&x.encounter_date===day),att=enc.filter(x=>x.attended),activities=(d.hours[id]||[]).filter(x=>x.work_date===day);
    return{date:day,stats:{booked:enc.filter(x=>x.booked).length,attended:att.length,did_not_attend:enc.filter(x=>x.booked&&!x.attended).length,female:att.filter(x=>x.patient_gender==='Female').length,male:att.filter(x=>x.patient_gender==='Male').length,other_gender:att.filter(x=>x.patient_gender==='Other').length,not_recorded_gender:att.filter(x=>!x.patient_gender||x.patient_gender==='Unknown').length,intake_sessions:att.filter(x=>x.session_type==='Intake').length,follow_up_sessions:att.filter(x=>x.session_type==='Follow-up').length,termination_sessions:att.filter(x=>x.session_type==='Termination').length,counselling_minutes:att.reduce((n,x)=>n+(+x.duration_minutes||0),0)},encounters:enc,activities,cases:d.cases.filter(x=>x.intern_profile_id===id&&x.status!=='Exited')};
  }
  if(route==='weekly-plan'){const items=d.appointments[id]||[];if(method==='GET')return{appointments:items,cases:d.cases.filter(c=>c.intern_profile_id===id),facilities:SITES.map((name,i)=>({id:i+1,name,service_context:name.includes('OPD')?'Outpatient':name==='Stellenbosch Hospital'?'Inpatient':'Community'}))};if(method==='POST'){const n={...body,id:Date.now(),intern_profile_id:id,status:'Booked',site:SITES[+body.facility_id-1]};items.push(n);return n}const x=items.find(x=>x.id===+body.id);if(x)Object.assign(x,body);return x||body;}
  if(route==='my-service'){const facilities=SITES.map((name,i)=>({id:i+1,name,service_context:name.includes('OPD')?'Outpatient':name==='Stellenbosch Hospital'?'Inpatient':'Community'}));if(method==='GET')return{entries:d.serviceStats,facilities,schedule:[{facility_name:'Stellenbosch Hospital OPD',schedule_pattern:'Every Monday and Tuesday',service_focus:'Booked outpatient counselling'}]};const n={...body,id:Date.now(),facility_name:facilities[+body.facility_id-1].name};d.serviceStats.push(n);return n;}
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
      activity_breakdown:[{service_type:'Individual counselling',site:'Stellenbosch Hospital',hours:10.5},{service_type:'Group counselling',site:'Idas Valley Clinic',hours:1}],
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
function authMessage(message, kind='danger'){
  const el=$('#authErr');
  el.className=`notice ${kind}`;
  el.textContent=message;
}
function authError(message){authMessage(message,'danger');}
function showPasswordSetup(type){pendingAuthType=type;$('#login').classList.add('hidden');$('#setPassword').classList.remove('hidden');$('#setPasswordMessage').innerHTML=type==='recovery'?'<b>Choose a new password</b><br>Enter and confirm your new password.':'<b>Finish setting up your account</b><br>Create a password to accept your invitation.';}
async function finishLogin(){const b=await api('bootstrap');S.session={profile:b.profile,role:b.role};restoreActiveIntern();shell();startIdleProtection();}

// Auth: Supabase Auth (supabase-js) replaces @netlify/identity. Invite and
// password-recovery links both land back on this page with tokens in the
// URL hash; supabase-js's detectSessionInUrl consumes that hash on client
// creation and establishes a (temporary, for invite/recovery) session
// automatically, then fires onAuthStateChange with the matching event.
async function init(){
  const qp=new URLSearchParams(location.search),isLocal=location.hostname==='localhost'||location.hostname==='127.0.0.1',pr=isLocal?(window.__AUTO_PREVIEW__||qp.get('preview')):null,allowed=isLocal;
  if(!isLocal&&qp.has('preview')){qp.delete('preview');const clean=location.pathname+(qp.toString()?`?${qp}`:'')+location.hash;history.replaceState(null,'',clean);}
  if(allowed){$('#preview').classList.remove('hidden');$$('[data-preview]').forEach(b=>b.onclick=()=>preview(b.dataset.preview));}
  if(['programme_lead','intern','management'].includes(pr))return preview(pr);
  try{
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    if(!window.__SUPABASE_URL__ || window.__SUPABASE_URL__.includes('YOUR-PROJECT-REF')) throw Error('Supabase is not configured yet (see public/config.js).');
    S.supabase=createClient(window.__SUPABASE_URL__, window.__SUPABASE_ANON_KEY__);
    const hashParams=new URLSearchParams(location.hash.replace(/^#/,''));
    const hashType=hashParams.get('type');
    const hashError=hashParams.get('error_description');
    if(hashError){
      history.replaceState(null,'',location.pathname);
      authError('This sign-in link is invalid or has expired. Use “Forgot password?” to receive a new secure link.');
    }
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
$('#forgotPassword').onclick=async()=>{
  const email=$('#email').value.trim();
  if(!email){authError('Enter your email address first, then select “Forgot password?”.');$('#email').focus();return;}
  try{
    $('#forgotPassword').disabled=true;
    const {error}=await S.supabase.auth.resetPasswordForEmail(email,{redirectTo:`${location.origin}/`});
    if(error)throw error;
    authMessage('Password-reset email sent. Open the newest email and use its link once.','info');
  }catch(x){authError(x.message||'The password-reset email could not be sent.');}
  finally{$('#forgotPassword').disabled=false;}
};
$('#setPassword').onsubmit=async e=>{e.preventDefault();const password=$('#newPassword').value;if(password!==$('#confirmPassword').value)return authError('The passwords do not match.');try{const {error}=await S.supabase.auth.updateUser({password});if(error)throw error;history.replaceState(null,'',location.pathname);location.replace('/');}catch(x){authError(x.message);}};
$('#logout').onclick=()=>S.preview?location.reload():(S.supabase.auth.signOut().then(()=>location.reload()));
$('#menu').onclick=()=>{$('aside').classList.contains('open')?closeDrawer():openDrawer();};
$('#navClose').onclick=()=>closeDrawer();
$('#navBackdrop').onclick=()=>closeDrawer();
$('#modalClose').onclick=closeModal; $('#modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
$('#emergency').onclick=openEmergency; $('#emClose').onclick=closeEmergency; $('#em').onclick=e=>{if(e.target.id==='em')closeEmergency();};
$('#quickHelp').onclick=()=>{S.assistantSeed='';go('assistant');};
init();
