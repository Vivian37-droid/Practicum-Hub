// Prompt 8 ("refine individual workflows") focused tests. Free-text fields
// below use generic placeholders ("Risk case", "Discussed in supervision")
// rather than any realistic patient detail — consistent with "keep patient
// information out of free-text examples, logs and test fixtures". All
// Supabase access is a mocked, in-memory queue/table (see helpers/mockAdmin.js);
// nothing here reads or writes a real database.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockAdmin, auditInsertPayload, ctxFor } from './helpers/mockAdmin.js';

const { getAdminMock } = vi.hoisted(() => ({ getAdminMock: vi.fn() }));
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: getAdminMock }));

const h = await import('../functions/api/_handlers.js');

function fakeUrl(qs = '') { return new URL('https://hub.example.test/api/x' + qs); }

beforeEach(() => { getAdminMock.mockReset(); });

describe('interns(): resend-invite safeguards', () => {
  it('refuses to resend once the invitee has already accepted and signed in', async () => {
    const { admin } = createMockAdmin([
      { data: { id: 5, display_name: 'Jamie Extern', email: 'jamie@example.test', identity_user_id: 'auth-uid-1' }, error: null }
    ]);
    admin.auth.admin.getUserById.mockResolvedValue({ data: { user: { confirmed_at: '2026-01-01T00:00:00Z' } }, error: null });
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.interns(ctx, {}, fakeUrl(), { id: 5, action: 'resend_invite' }, 'PATCH')).rejects.toMatchObject({ status: 400 });
    expect(admin.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('resends and audits when the invitee has never signed in (no identity_user_id yet)', async () => {
    const { admin, calls } = createMockAdmin([
      { data: { id: 6, display_name: 'Alex New', email: 'alex@example.test', identity_user_id: null }, error: null },
      { data: { id: 300 }, error: null }
    ]);
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({ error: null });
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.interns(ctx, {}, fakeUrl(), { id: 6, action: 'resend_invite' }, 'PATCH');
    expect(result).toEqual({ ok: true, resent_id: 6 });
    expect(admin.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalledWith('alex@example.test', expect.objectContaining({ data: expect.objectContaining({ display_name: 'Alex New' }) }));
    const audit = auditInsertPayload(calls);
    expect(audit.action).toBe('resend_invite');
    expect(audit.entity_type).toBe('intern');
  });

  it('resends when invited but not yet confirmed', async () => {
    const { admin } = createMockAdmin([
      { data: { id: 7, display_name: 'Sam Pending', email: 'sam@example.test', identity_user_id: 'auth-uid-2' }, error: null },
      { data: { id: 301 }, error: null }
    ]);
    admin.auth.admin.getUserById.mockResolvedValue({ data: { user: { confirmed_at: null } }, error: null });
    admin.auth.admin.inviteUserByEmail.mockResolvedValue({ error: null });
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.interns(ctx, {}, fakeUrl(), { id: 7, action: 'resend_invite' }, 'PATCH');
    expect(result).toEqual({ ok: true, resent_id: 7 });
    expect(admin.auth.admin.inviteUserByEmail).toHaveBeenCalled();
  });

  it('requires programme_lead role and touches no data for anyone else', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.interns(ctx, {}, fakeUrl(), { id: 5, action: 'resend_invite' }, 'PATCH')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });
});

describe('requirements(): "not viable at current pace" cap', () => {
  function progressData({ target, encounterMinutes, recentMinutes }) {
    return {
      profile: { id: 5, placement_start: '2026-07-01', placement_end: '2027-06-01', overall_programme_hours: 720, default_session_minutes: 50 },
      components: [{
        id: 1, code: 'individual_counselling', name: 'Individual counselling',
        component_type: 'individual_counselling', calculation_mode: 'individual_encounters',
        target_hours: target, counts_for_pace: true
      }],
      manual: {}, encounter: { minutes: encounterMinutes, booked: 10, attended: 8, avg_minutes: 50 },
      recent_encounter: { minutes: recentMinutes }, active_cases: {}, deliverables: {}, opening: {}
    };
  }

  it('suppresses the projected date and flags not-viable when weeks-to-target exceeds the horizon', async () => {
    // target 500h, 10h completed, only 1h in the last 4 weeks -> ~1960 weeks to target
    const { admin } = createMockAdmin([{ data: progressData({ target: 500, encounterMinutes: 600, recentMinutes: 60 }), error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.requirements(ctx, {}, fakeUrl('?intern_id=5'), {}, 'GET');
    expect(result.summary.clinical_pace_not_viable).toBe(true);
    expect(result.summary.estimated_clinical_target_date).toBeNull();
  });

  it('still returns a real target date when the projection is within the horizon', async () => {
    // target 50h, 10h completed, 10h in the last 4 weeks -> ~16 weeks to target
    const { admin } = createMockAdmin([{ data: progressData({ target: 50, encounterMinutes: 600, recentMinutes: 600 }), error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.requirements(ctx, {}, fakeUrl('?intern_id=5'), {}, 'GET');
    expect(result.summary.clinical_pace_not_viable).toBe(false);
    expect(result.summary.estimated_clinical_target_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('supervision(): due date and assigned supervisor', () => {
  it('POST persists the due date and auto-assigns the intern\'s own supervisor', async () => {
    const inserted = { id: 40, intern_profile_id: 5, topic: 'Risk case', due_date: '2026-10-01', assigned_supervisor_identity_user_id: 'auth-sup-1' };
    const { admin, calls } = createMockAdmin([
      { data: { supervisor_identity_user_id: 'auth-sup-1' }, error: null },
      { data: inserted, error: null },
      { data: { id: 99 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.supervision(ctx, {}, fakeUrl('?intern_id=5'), { topic: 'Risk case', question: 'What next?', due_date: '2026-10-01' }, 'POST');
    expect(result).toEqual(inserted);
    const insertCall = calls.find(c => c.table === 'supervision_items' && c.ops.some(op => op[0] === 'insert'));
    const insertedPayload = insertCall.ops.find(op => op[0] === 'insert')[1];
    expect(insertedPayload.due_date).toBe('2026-10-01');
    expect(insertedPayload.assigned_supervisor_identity_user_id).toBe('auth-sup-1');
  });

  it('GET resolves assigned_supervisor_name from the supervisor\'s own profile', async () => {
    const { admin } = createMockAdmin([
      { data: [{ id: 1, intern_profile_id: 5, assigned_supervisor_identity_user_id: 'auth-sup-1', status: 'Open', created_at: '2026-09-01T00:00:00Z', cases: null }], error: null },
      { data: [{ identity_user_id: 'auth-sup-1', display_name: 'Dr Smith' }], error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const rows = await h.supervision(ctx, {}, fakeUrl('?intern_id=5'), {}, 'GET');
    expect(rows[0].assigned_supervisor_name).toBe('Dr Smith');
  });

  it('GET leaves assigned_supervisor_name null when no supervisor is assigned yet', async () => {
    const { admin } = createMockAdmin([
      { data: [{ id: 2, intern_profile_id: 5, assigned_supervisor_identity_user_id: null, status: 'Open', created_at: '2026-09-01T00:00:00Z', cases: null }], error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const rows = await h.supervision(ctx, {}, fakeUrl('?intern_id=5'), {}, 'GET');
    expect(rows[0].assigned_supervisor_name).toBeNull();
  });

  it('PATCH can update the due date', async () => {
    const row = { id: 4, intern_profile_id: 5, status: 'Open', supervisor_note: null, due_date: '2026-09-01' };
    const updated = { ...row, status: 'Reviewed', supervisor_note: 'Discussed in supervision', due_date: '2026-11-01' };
    const { admin, calls } = createMockAdmin([
      { data: row, error: null },
      { data: updated, error: null },
      { data: { id: 9 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.supervision(ctx, {}, fakeUrl(), { id: 4, status: 'Reviewed', supervisor_note: 'Discussed in supervision', due_date: '2026-11-01' }, 'PATCH');
    expect(result.due_date).toBe('2026-11-01');
    const updateCall = calls.find(c => c.table === 'supervision_items' && c.ops.some(op => op[0] === 'update'));
    expect(updateCall.ops.find(op => op[0] === 'update')[1].due_date).toBe('2026-11-01');
  });

  it('PATCH can clear an existing due date', async () => {
    const row = { id: 4, intern_profile_id: 5, status: 'Open', supervisor_note: null, due_date: '2026-09-01' };
    const updated = { ...row, status: 'Open', due_date: null };
    const { admin, calls } = createMockAdmin([
      { data: row, error: null },
      { data: updated, error: null },
      { data: { id: 10 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await h.supervision(ctx, {}, fakeUrl(), { id: 4, status: 'Open', due_date: '' }, 'PATCH');
    const updateCall = calls.find(c => c.table === 'supervision_items' && c.ops.some(op => op[0] === 'update'));
    expect(updateCall.ops.find(op => op[0] === 'update')[1].due_date).toBeNull();
  });
});

describe('competencies(): rating/evidence history', () => {
  it('POST writes an audit_log entry recording actor role and name', async () => {
    const { admin, calls } = createMockAdmin([
      { data: { id: 10 }, error: null },
      { data: null, error: null },
      { data: { id: 55, intern_profile_id: 5, competency_id: 10, intern_rating: null, supervisor_rating: 4, evidence: null, supervisor_comment: 'Good progress' }, error: null },
      { data: { id: 200 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead', { display_name: 'Dr Lead' });
    await h.competencies(ctx, {}, fakeUrl('?intern_id=5'), { competency_id: 10, supervisor_rating: 4, supervisor_comment: 'Good progress' }, 'POST');
    const audit = auditInsertPayload(calls);
    expect(audit.action).toBe('update');
    expect(audit.entity_type).toBe('competency_progress');
    expect(audit.entity_id).toBe('55');
    expect(audit.detail).toMatchObject({ actor_role: 'programme_lead', actor_name: 'Dr Lead', supervisor_rating: 4, supervisor_comment: 'Good progress' });
  });

  it('GET scopes history to the right competency_progress id — no leakage across competencies or interns', async () => {
    const definitions = [
      {
        id: 1, name: 'Comp A', sort_order: 1,
        competency_progress: [
          { id: 101, intern_profile_id: 5, intern_rating: 3, supervisor_rating: 4, evidence: 'e1', supervisor_comment: 'c1' },
          { id: 102, intern_profile_id: 9, intern_rating: 2, supervisor_rating: 2, evidence: 'e2', supervisor_comment: 'c2' }
        ]
      },
      {
        id: 2, name: 'Comp B', sort_order: 2,
        competency_progress: [
          { id: 201, intern_profile_id: 5, intern_rating: 5, supervisor_rating: 5, evidence: 'e3', supervisor_comment: 'c3' }
        ]
      }
    ];
    const historyRows = [
      { entity_id: '101', created_at: '2026-09-01T00:00:00Z', detail: JSON.stringify({ actor_role: 'supervisor', actor_name: 'Dr X', supervisor_rating: 4 }) },
      { entity_id: '201', created_at: '2026-09-02T00:00:00Z', detail: JSON.stringify({ actor_role: 'intern', actor_name: 'Jamie', intern_rating: 5 }) }
    ];
    const { admin, calls } = createMockAdmin([
      { data: definitions, error: null },
      { data: historyRows, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.competencies(ctx, {}, fakeUrl('?intern_id=5'), {}, 'GET');

    const historyQuery = calls.find(c => c.table === 'audit_log');
    const inOp = historyQuery.ops.find(op => op[0] === 'in');
    expect(inOp[2].sort()).toEqual(['101', '201']); // only this intern's own progress ids, not intern 9's 102

    const compA = result.find(r => r.name === 'Comp A');
    const compB = result.find(r => r.name === 'Comp B');
    expect(compA.history).toEqual([{ created_at: '2026-09-01T00:00:00Z', actor_role: 'supervisor', actor_name: 'Dr X', supervisor_rating: 4 }]);
    expect(compB.history).toEqual([{ created_at: '2026-09-02T00:00:00Z', actor_role: 'intern', actor_name: 'Jamie', intern_rating: 5 }]);
  });
});

describe('hoursView(): activity-log correction history', () => {
  it('GET attaches correction history only to entries actually in this intern\'s log, scoped by entry id', async () => {
    const entries = [
      { entry: { id: 1, intern_profile_id: 5, work_date: '2026-09-01', hours: 2 } },
      { entry: { id: 2, intern_profile_id: 5, work_date: '2026-09-02', hours: 3 } }
    ];
    const historyRows = [
      { entity_id: '1', reason: 'Fixed a typo', created_at: '2026-09-05T00:00:00Z', detail: JSON.stringify({ before: { hours: 1 }, after: { hours: 2 } }) }
    ];
    const { admin, calls } = createMockAdmin([
      { data: entries, error: null },        // rpc hours_entries_with_component
      { data: historyRows, error: null },    // audit_log correction history
      { data: { requirement_profile_id: 7 }, error: null }, // profiles lookup
      { data: [], error: null }              // requirement_components
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.hoursView(ctx, {}, fakeUrl('?intern_id=5'), {}, 'GET');

    const historyQuery = calls.find(c => c.table === 'audit_log');
    const inOp = historyQuery.ops.find(op => op[0] === 'in');
    expect(inOp[2]).toEqual(['1', '2']); // exactly this intern's entry ids, no more, no less

    expect(result.entries[0].correction_history).toEqual([{ created_at: '2026-09-05T00:00:00Z', reason: 'Fixed a typo', before: { hours: 1 }, after: { hours: 2 } }]);
    expect(result.entries[1].correction_history).toEqual([]);
  });
});
