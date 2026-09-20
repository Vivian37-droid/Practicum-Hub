// Prompt 4: "audit records are created" for every destructive/correcting
// action, restoring a delete works (and only once), and a second "mark
// reviewed" call is unambiguous rather than silently re-stamping the
// reviewer/timestamp. All Supabase access is a mocked, in-memory queue (see
// helpers/mockAdmin.js) — nothing here reads or writes a real database.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockAdmin, auditInsertPayload, ctxFor } from './helpers/mockAdmin.js';

const { getAdminMock } = vi.hoisted(() => ({ getAdminMock: vi.fn() }));
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: getAdminMock }));

const h = await import('../functions/api/_handlers.js');

function fakeUrl(qs = '') { return new URL('https://hub.example.test/api/x' + qs); }

beforeEach(() => { getAdminMock.mockReset(); });

describe('deleting a referral', () => {
  it('deactivating an intern writes an audit record with the reason and returns no auth-account deletion', async () => {
    const row = { id: 5, display_name: 'Erin George', email: 'erin@example.test', active: true };
    const { admin, calls } = createMockAdmin([
      { data: row, error: null },     // select profile
      { error: null },                 // update active=false
      { data: { id: 42 }, error: null } // audit_log insert
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.interns(ctx, {}, fakeUrl('?id=5'), { reason: 'Placement ended early' }, 'DELETE');
    expect(result).toEqual({ ok: true, deactivated_id: 5 });
    const audit = auditInsertPayload(calls);
    expect(audit.action).toBe('deactivate');
    expect(audit.entity_type).toBe('intern');
    expect(audit.reason).toBe('Placement ended early');
    expect(audit.detail).toEqual({ display_name: 'Erin George', email: 'erin@example.test' });
    // No admin.auth.admin.deleteUser call — the account is preserved, only blocked via context()'s active check.
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it('requires a reason to deactivate an intern', async () => {
    const row = { id: 5, display_name: 'Erin George', email: 'erin@example.test', active: true };
    const { admin } = createMockAdmin([{ data: row, error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.interns(ctx, {}, fakeUrl('?id=5'), {}, 'DELETE')).rejects.toMatchObject({ status: 400 });
  });

  it('captures the full row and returns an audit_id so the delete can be undone', async () => {
    const row = { id: 9, referral_code: 'EG-024', status: 'Allocated', intern_profile_id: 3 };
    const { admin, calls } = createMockAdmin([
      { data: row, error: null },
      { data: { id: 77 }, error: null },
      { error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.referrals(ctx, {}, fakeUrl('?id=9'), {}, 'DELETE');
    expect(result).toEqual({ ok: true, deleted_id: 9, audit_id: 77 });
    const audit = auditInsertPayload(calls);
    expect(audit.action).toBe('delete');
    expect(audit.entity_type).toBe('referral');
    expect(audit.detail).toEqual(row); // full row captured, not just referral_code
  });
});

describe('restoreAudit()', () => {
  it('re-inserts the snapshotted row and marks the audit entry restored', async () => {
    const snapshot = { id: 9, referral_code: 'EG-024', status: 'Allocated', intern_profile_id: 3 };
    const logRow = { id: 77, action: 'delete', entity_type: 'referral', restored_at: null, detail: JSON.stringify(snapshot), profile_id: 3 };
    const { admin, calls } = createMockAdmin([
      { data: logRow, error: null },                              // select audit_log
      { data: { ...snapshot, id: 55 }, error: null },              // insert referrals
      { error: null },                                             // update audit_log.restored_at
      { data: { id: 78 }, error: null }                            // audit() for the restore itself
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const restored = await h.restoreAudit(ctx, {}, fakeUrl(), { audit_id: 77 }, 'POST');
    expect(restored).toEqual({ ...snapshot, id: 55 });
    const insertCall = calls.find(c => c.table === 'referrals');
    const insertedFields = insertCall.ops.find(op => op[0] === 'insert')[1];
    expect(insertedFields.id).toBeUndefined(); // old id stripped, a new row/id is created
    expect(insertedFields.referral_code).toBe('EG-024');
    const restoreAudit = auditInsertPayload(calls, 0);
    expect(restoreAudit.action).toBe('restore');
  });

  it('refuses to restore the same deletion twice', async () => {
    const logRow = { id: 77, action: 'delete', entity_type: 'referral', restored_at: '2026-01-01T00:00:00Z', detail: '{"id":9}', profile_id: 3 };
    const { admin } = createMockAdmin([{ data: logRow, error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.restoreAudit(ctx, {}, fakeUrl(), { audit_id: 77 }, 'POST')).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to restore a case (cascading children make it unsafe)', async () => {
    const logRow = { id: 80, action: 'delete', entity_type: 'case', restored_at: null, detail: '{"id":1}', profile_id: 3 };
    const { admin } = createMockAdmin([{ data: logRow, error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.restoreAudit(ctx, {}, fakeUrl(), { audit_id: 80 }, 'POST')).rejects.toMatchObject({ status: 400 });
  });
});

describe('hours correction workflow', () => {
  it('updates the entry, keeps both old and new values in the audit trail, and requires a reason', async () => {
    const before = { id: 3, intern_profile_id: 1, work_date: '2026-09-01', hours: 2, component_code: 'other-professional', category: 'Other', note: 'typo' };
    const after = { ...before, hours: 3, note: 'fixed' };
    const { admin, calls } = createMockAdmin([
      { data: before, error: null }, // select
      { data: after, error: null },  // update ... .select().single()
      { data: { id: 5 }, error: null } // audit insert
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.hoursView(ctx, {}, fakeUrl(), { id: 3, hours: 3, note: 'fixed', reason: 'Wrong hours logged' }, 'PATCH');
    expect(result).toEqual(after);
    const audit = auditInsertPayload(calls);
    expect(audit.action).toBe('correct');
    expect(audit.reason).toBe('Wrong hours logged');
    expect(audit.detail).toEqual({ before, after });
  });

  it('rejects a correction with no reason', async () => {
    const before = { id: 3, intern_profile_id: 1, work_date: '2026-09-01', hours: 2, component_code: 'other-professional', category: 'Other', note: null };
    const { admin } = createMockAdmin([{ data: before, error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.hoursView(ctx, {}, fakeUrl(), { id: 3, hours: 5 }, 'PATCH')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an out-of-range corrected hours value', async () => {
    const before = { id: 3, intern_profile_id: 1, work_date: '2026-09-01', hours: 2, component_code: 'other-professional', category: 'Other', note: null };
    const { admin } = createMockAdmin([{ data: before, error: null }]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.hoursView(ctx, {}, fakeUrl(), { id: 3, hours: 30, reason: 'test' }, 'PATCH')).rejects.toMatchObject({ status: 400 });
  });
});

describe('report review finalisation is unambiguous', () => {
  it('flags a second "mark reviewed" call as already_reviewed instead of a plain re-review', async () => {
    const { admin } = createMockAdmin([
      { data: { status: 'Reviewed' }, error: null }, // existing report lookup
      { data: { id: 7, status: 'Reviewed', reviewed_by_name: 'Dr Smith', reviewed_at: '2026-01-01T00:00:00Z' }, error: null }, // rpc upsert
      { data: { id: 55 }, error: null } // audit insert
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.reports(ctx, {}, fakeUrl('?intern_id=1&month=2026-09-01'), { intern_profile_id: 1, month: '2026-09-01' }, 'POST');
    expect(result.already_reviewed).toBe(true);
    expect(result.reviewed_by_name).toBe('Dr Smith');
  });

  it('a first review is not flagged as already_reviewed', async () => {
    const { admin } = createMockAdmin([
      { data: null, error: null }, // no existing report row yet (Draft)
      { data: { id: 7, status: 'Reviewed', reviewed_by_name: 'Dr Smith', reviewed_at: '2026-01-01T00:00:00Z' }, error: null },
      { data: { id: 56 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.reports(ctx, {}, fakeUrl('?intern_id=1&month=2026-09-01'), { intern_profile_id: 1, month: '2026-09-01' }, 'POST');
    expect(result.already_reviewed).toBe(false);
  });
});

describe('supervision review is audited', () => {
  it('records who reviewed a supervision item, not just its delete', async () => {
    const row = { id: 4, intern_profile_id: 1, status: 'Open', supervisor_note: null, topic: 'Risk case' };
    const updated = { ...row, status: 'Reviewed', supervisor_note: 'Discussed in supervision' };
    const { admin, calls } = createMockAdmin([
      { data: row, error: null },      // select supervision_items
      { data: updated, error: null },  // update ... .select().single()
      { data: { id: 9 }, error: null } // audit insert
    ]);
    getAdminMock.mockReturnValue(admin);
    // programme_lead so assertInternAccess()'s canAccessIntern() short-circuits
    // to true without an extra DB round trip (a supervisor ctx would need one
    // more mocked response here for the supervisor/intern-link lookup).
    const ctx = ctxFor('programme_lead');
    const result = await h.supervision(ctx, {}, fakeUrl(), { id: 4, status: 'Reviewed', supervisor_note: 'Discussed in supervision' }, 'PATCH');
    expect(result).toEqual(updated);
    const audit = auditInsertPayload(calls);
    expect(audit.action).toBe('review');
    expect(audit.entity_type).toBe('supervision');
  });
});
