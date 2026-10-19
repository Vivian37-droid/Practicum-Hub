import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockAdmin, ctxFor } from './helpers/mockAdmin.js';
import { codeValue, isDeidentifiedCode, CODE_RULE } from '../functions/_shared/util.js';

const getAdminMock = vi.fn();
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: (...args) => getAdminMock(...args) }));
const h = await import('../functions/api/_handlers.js');

const updatePayload = calls => {
  const write = calls.find(c => c.table === 'referrals' && c.ops.some(op => op[0] === 'update'));
  return write.ops.find(op => op[0] === 'update')[1];
};

describe('de-identified codes', () => {
  it('accepts programme code formats and rejects names', () => {
    for (const ok of ['EG-024', 'khc-026', 'R12', 'SH-2026-001']) expect(isDeidentifiedCode(ok)).toBe(true);
    for (const bad of ['JANE SMITH', 'Jane', 'Mary-Ann', 'EG 024', '', '-12']) expect(isDeidentifiedCode(bad)).toBe(false);
    expect(codeValue(' eg-024 ', 'Referral code')).toBe('EG-024');
    expect(() => codeValue('Jane Smith', 'Referral code')).toThrow(/de-identified code/);
  });

  it('keeps the browser rule in step with the server rule', () => {
    const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(app).toContain(`const CODE_RULE = ${CODE_RULE};`);
  });
});

describe('referral code correction', () => {
  beforeEach(() => getAdminMock.mockReset());
  const current = { id: 20, intern_profile_id: 1, referral_code: 'JANE SMITH', priority: 'Routine', status: 'Allocated', contact_attempts: 2, next_action_date: '2026-10-01', last_update: 'Left message', update_category: null, closed_at: null };

  it('replaces a name with a code and audits without the old value', async () => {
    const { admin, calls } = createMockAdmin([
      { data: current, error: null },
      { data: { ...current, referral_code: 'EG-030' }, error: null },
      { data: { id: 91 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    await h.referrals(ctxFor('intern'), {}, new URL('https://example.test/api/referrals'), { id: 20, referral_code: 'eg-030' }, 'PATCH');
    expect(updatePayload(calls).referral_code).toBe('EG-030');
    const auditInsert = calls.find(c => c.table === 'audit_log').ops.find(op => op[0] === 'insert')[1];
    expect(auditInsert.detail).toContain('code_corrected');
    expect(auditInsert.detail).not.toContain('JANE');
  });

  it('refuses to replace a code with another name', async () => {
    const { admin } = createMockAdmin([{ data: current, error: null }]);
    getAdminMock.mockReturnValue(admin);
    await expect(h.referrals(ctxFor('intern'), {}, new URL('https://example.test/api/referrals'), { id: 20, referral_code: 'John Doe' }, 'PATCH'))
      .rejects.toThrow(/de-identified code/);
  });

  it('still allows a status update on a legacy code and keeps omitted fields', async () => {
    const { admin, calls } = createMockAdmin([
      { data: current, error: null },
      { data: { ...current, status: 'Contact made' }, error: null },
      { data: { id: 92 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);
    await h.referrals(ctxFor('intern'), {}, new URL('https://example.test/api/referrals'), { id: 20, referral_code: 'Jane Smith', status: 'Contact made' }, 'PATCH');
    const payload = updatePayload(calls);
    expect(payload.referral_code).toBe('JANE SMITH');
    expect(payload.next_action_date).toBe('2026-10-01');
    expect(payload.last_update).toBe('Left message');
  });

  it('rejects a name on a new referral', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    await expect(h.referrals(ctxFor('intern'), {}, new URL('https://example.test/api/referrals'), {
      referral_code: 'Jane Smith', referral_date: '2026-10-19', status: 'Allocated', priority: 'Routine'
    }, 'POST')).rejects.toThrow(/de-identified code/);
  });
});
