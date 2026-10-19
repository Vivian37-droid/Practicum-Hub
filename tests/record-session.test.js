import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAdmin, ctxFor } from './helpers/mockAdmin.js';

const getAdminMock = vi.fn();
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: (...args) => getAdminMock(...args) }));
const h = await import('../functions/api/_handlers.js');

const url = new URL('https://example.test/api/encounters');
const profile = { id: 1, requirement_profile_id: 3, default_session_minutes: 60, requirement_profiles: { code: 'sacap-bpsych', name: 'SACAP', overall_programme_hours: 720 } };
const session = { referral_id: 40, encounter_date: '2026-10-19', session_type: 'Intake', booked: 'true', attended: 'true', duration_minutes: '50', patient_gender: 'Female' };
const updatesTo = (calls, table) => calls.filter(c => c.table === table && c.ops.some(op => op[0] === 'update')).map(c => c.ops.find(op => op[0] === 'update')[1]);

describe('recording a session from a referral', () => {
  beforeEach(() => getAdminMock.mockReset());

  it('moves an early-stage referral forward so its case exists, then records the session', async () => {
    const referral = { id: 40, intern_profile_id: 1, status: 'Contact made' };
    const linkedCase = { id: 77, intern_profile_id: 1, referral_id: 40, site: 'Stellenbosch Hospital' };
    const { admin, calls } = createMockAdmin([
      { data: profile, error: null },
      { data: referral, error: null },
      { data: { ...referral, status: 'Intake completed' }, error: null },
      { data: { id: 900 }, error: null },
      { data: linkedCase, error: null },
      { data: { id: 501, case_id: 77 }, error: null },
      { data: { id: 901 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    const row = await h.encounters(ctxFor('intern'), {}, url, session, 'POST');

    expect(row.case_id).toBe(77);
    expect(updatesTo(calls, 'referrals')[0]).toMatchObject({ status: 'Intake completed' });
    expect(admin.rpc).toHaveBeenCalledWith('create_encounter', expect.objectContaining({ p_case_id: 77, p_session_type: 'Intake', p_duration: 50 }));
  });

  it('uses the existing case without changing a referral that already has one', async () => {
    const { admin, calls } = createMockAdmin([
      { data: profile, error: null },
      { data: { id: 40, intern_profile_id: 1, status: 'Booked' }, error: null },
      { data: { id: 78, intern_profile_id: 1, referral_id: 40, site: 'Idas Valley Clinic' }, error: null },
      { data: { id: 502, case_id: 78 }, error: null },
      { data: { id: 902 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    await h.encounters(ctxFor('intern'), {}, url, { ...session, session_type: 'Follow-up' }, 'POST');

    expect(updatesTo(calls, 'referrals')).toHaveLength(0);
    expect(admin.rpc).toHaveBeenCalledWith('create_encounter', expect.objectContaining({ p_case_id: 78 }));
  });

  it('refuses a closed referral and saves nothing', async () => {
    const { admin, calls } = createMockAdmin([
      { data: profile, error: null },
      { data: { id: 40, intern_profile_id: 1, status: 'Closed – no contact' }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    await expect(h.encounters(ctxFor('intern'), {}, url, session, 'POST')).rejects.toMatchObject({ status: 400 });
    expect(updatesTo(calls, 'referrals')).toHaveLength(0);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('validates the session before touching the referral', async () => {
    const { admin, calls } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);

    await expect(h.encounters(ctxFor('intern'), {}, url, { ...session, session_type: 'Nonsense' }, 'POST')).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('interns adding their own clients', () => {
  beforeEach(() => getAdminMock.mockReset());

  it('lets an intern add a client for themselves with the default frequency', async () => {
    const { admin, calls } = createMockAdmin([
      { data: { id: 80, intern_profile_id: 1 }, error: null },
      { data: { id: 903 }, error: null }
    ]);
    getAdminMock.mockReturnValue(admin);

    await h.cases(ctxFor('intern'), {}, new URL('https://example.test/api/cases'), {
      intern_profile_id: 99, case_code: 'eg-031', site: 'Stellenbosch Hospital', planned_frequency_weeks: 4
    }, 'POST');

    const insert = calls.find(c => c.table === 'cases').ops.find(op => op[0] === 'insert')[1];
    expect(insert).toMatchObject({ intern_profile_id: 1, case_code: 'EG-031', planned_frequency_weeks: 1 });
  });

  it('still rejects a name as the client code', async () => {
    getAdminMock.mockReturnValue(createMockAdmin([]).admin);
    await expect(h.cases(ctxFor('intern'), {}, new URL('https://example.test/api/cases'), {
      case_code: 'Jane Smith', site: 'Stellenbosch Hospital'
    }, 'POST')).rejects.toThrow(/de-identified code/);
  });
});
