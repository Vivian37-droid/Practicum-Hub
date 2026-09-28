import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAdmin } from './helpers/mockAdmin.js';

const { getAdminMock } = vi.hoisted(() => ({ getAdminMock: vi.fn() }));
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: getAdminMock }));

const { context } = await import('../functions/_shared/context.js');

beforeEach(() => getAdminMock.mockReset());

function request() {
  return new Request('https://hub.example.test/api/bootstrap', {
    headers: { authorization: 'Bearer test-token' }
  });
}

describe('server-controlled role resolution', () => {
  it('ignores a programme-lead role claimed through user_metadata', async () => {
    const { admin } = createMockAdmin([
      { data: { role: 'intern', active: true }, error: null },
      { data: { id: 7, role: 'intern', active: true }, error: null }
    ]);
    admin.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-7', email: 'intern@example.test', user_metadata: { roles: ['programme_lead'] }, app_metadata: {} } },
      error: null
    });
    getAdminMock.mockReturnValue(admin);

    const ctx = await context(request(), { PROGRAMME_LEAD_EMAILS: '' });

    expect(ctx.role).toBe('intern');
    expect(admin.rpc).toHaveBeenCalledWith('app_context_upsert', expect.objectContaining({ p_role: 'intern' }));
  });

  it('honours a role already stored in the protected profile', async () => {
    const { admin } = createMockAdmin([
      { data: { role: 'supervisor', active: true }, error: null },
      { data: { id: 8, role: 'supervisor', active: true }, error: null }
    ]);
    admin.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-8', email: 'supervisor@example.test', user_metadata: {}, app_metadata: {} } },
      error: null
    });
    getAdminMock.mockReturnValue(admin);

    const ctx = await context(request(), { PROGRAMME_LEAD_EMAILS: '' });

    expect(ctx.role).toBe('supervisor');
  });
});
