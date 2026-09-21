import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAdmin, ctxFor } from './helpers/mockAdmin.js';

const getAdminMock = vi.fn();
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: (...args) => getAdminMock(...args) }));
const h = await import('../functions/api/_handlers.js');

describe('referral updates', () => {
  beforeEach(() => getAdminMock.mockReset());

  it('lets the allocated intern save through a direct referrals update', async () => {
    const current = { id: 14, intern_profile_id: 1, priority: 'Routine', status: 'Allocated', contact_attempts: 0, closed_at: null, update_category: null };
    const saved = { ...current, status: 'Contact attempted', contact_attempts: 1, update_category: 'Attempted contact – no response' };
    const { admin, calls } = createMockAdmin([
      { data: current, error: null },
      { data: saved, error: null },
      { data: { id: 88 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    const result = await h.referrals(ctxFor('intern'), {}, new URL('https://example.test/api/referrals'), {
      id: 14,
      status: 'Contact attempted',
      priority: 'Routine',
      contact_attempts: 1,
      update_category: 'Attempted contact – no response',
      last_update: 'No response'
    }, 'PATCH');

    expect(result.status).toBe('Contact attempted');
    expect(admin.rpc).not.toHaveBeenCalledWith('update_referral', expect.anything());
    const write = calls.find(c => c.table === 'referrals' && c.ops.some(op => op[0] === 'update'));
    expect(write.ops.find(op => op[0] === 'update')[1]).toMatchObject({
      status: 'Contact attempted',
      contact_attempts: 1,
      update_category: 'Attempted contact – no response'
    });
  });

  it('automatically accepts a referral an intern creates for themselves', async () => {
    const saved = { id: 15, intern_profile_id: 1, referral_code: 'EG-025', status: 'Allocated', accepted_at: '2026-09-21T12:00:00.000Z' };
    const { admin, calls } = createMockAdmin([
      { data: saved, error: null },
      { data: { id: 89 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    await h.referrals(ctxFor('intern'), {}, new URL('https://example.test/api/referrals'), {
      referral_code: 'EG-025',
      referral_date: '2026-09-21',
      status: 'Allocated',
      priority: 'Routine'
    }, 'POST');

    const insert = calls.find(c => c.table === 'referrals' && c.ops.some(op => op[0] === 'insert'));
    const payload = insert.ops.find(op => op[0] === 'insert')[1];
    expect(payload.accepted_at).toBeTruthy();
    expect(payload.accepted_by_identity_user_id).toBe('user-intern');
  });

  it('leaves a supervisor-allocated referral awaiting acceptance', async () => {
    const saved = { id: 16, intern_profile_id: 1, referral_code: 'EG-026', status: 'Allocated', accepted_at: null };
    const { admin, calls } = createMockAdmin([
      { data: { id: 1 }, error: null },
      { data: saved, error: null },
      { data: { id: 90 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    await h.referrals(ctxFor('programme_lead'), {}, new URL('https://example.test/api/referrals'), {
      intern_profile_id: 1,
      referral_code: 'EG-026',
      referral_date: '2026-09-21',
      status: 'Allocated',
      priority: 'Routine'
    }, 'POST');

    const insert = calls.find(c => c.table === 'referrals' && c.ops.some(op => op[0] === 'insert'));
    const payload = insert.ops.find(op => op[0] === 'insert')[1];
    expect(payload.accepted_at).toBeNull();
    expect(payload.accepted_by_identity_user_id).toBeNull();
  });
});
