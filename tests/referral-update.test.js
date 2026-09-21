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
});
