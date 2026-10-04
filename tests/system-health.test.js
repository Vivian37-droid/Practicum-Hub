import { describe, expect, it, vi } from 'vitest';
import { createNamedMockAdmin, ctxFor } from './helpers/mockAdmin.js';

const { getAdminMock } = vi.hoisted(() => ({ getAdminMock: vi.fn() }));
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: getAdminMock }));
const h = await import('../functions/api/_handlers.js');

describe('schema health', () => {
  it('reports the current migration version', async () => {
    const { admin } = createNamedMockAdmin({
      tables: { app_schema_version: { data: { version: 20, applied_at: '2026-10-04T00:00:00Z' }, error: null } },
      rpcs: { app_schema_health: { data: { ok: true, missing: [] }, error: null } }
    });
    getAdminMock.mockReturnValue(admin);
    await expect(h.systemHealth(ctxFor('programme_lead'), {})).resolves.toMatchObject({ status: 'ok', required_version: 20, detected_version: 20, missing: [] });
  });

  it('warns when the version table is missing', async () => {
    const { admin } = createNamedMockAdmin({
      tables: { app_schema_version: { data: null, error: { message: 'relation does not exist' } } },
      rpcs: { app_schema_health: { data: null, error: { message: 'function does not exist' } } }
    });
    getAdminMock.mockReturnValue(admin);
    await expect(h.systemHealth(ctxFor('programme_lead'), {})).resolves.toMatchObject({ status: 'migration_required', detected_version: null });
  });

  it('warns when an intermediate migration is missing despite a high marker', async () => {
    const { admin } = createNamedMockAdmin({
      tables: { app_schema_version: { data: { version: 20, applied_at: '2026-10-04T00:00:00Z' }, error: null } },
      rpcs: { app_schema_health: { data: { ok: false, missing: ['audit_log.reason'] }, error: null } }
    });
    getAdminMock.mockReturnValue(admin);
    await expect(h.systemHealth(ctxFor('programme_lead'), {})).resolves.toMatchObject({
      status: 'migration_required', detected_version: 20, missing: ['audit_log.reason']
    });
  });
});
