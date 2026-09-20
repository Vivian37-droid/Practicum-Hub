// Prompt 7: "add tests that reconcile exported totals with source records
// and prevent reports from silently mixing data belonging to different
// interns or reporting periods." reports() fires several admin.from()/rpc()
// calls concurrently (Promise.all), so this uses createNamedMockAdmin,
// which resolves by table/rpc NAME (and, where it matters, by the actual
// arguments a call used) rather than call order — call order across
// racing branches isn't guaranteed, but which table/rpc a given branch
// calls, and what it passes, is exactly what we want to pin down.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNamedMockAdmin, ctxFor } from './helpers/mockAdmin.js';

const { getAdminMock } = vi.hoisted(() => ({ getAdminMock: vi.fn() }));
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: getAdminMock }));

const h = await import('../functions/api/_handlers.js');

function fakeUrl(qs = '') { return new URL('https://hub.example.test/api/reports' + qs); }

beforeEach(() => { getAdminMock.mockReset(); });

// audit_log is queried twice per GET (corrections, then review history),
// distinguished only by which entity_type they filtered on — this picks the
// right canned response for each without caring which order they land in.
function audit_log(correctionsRows, historyRows) {
  return (ops) => {
    const filtersHours = ops.some(op => op[0] === 'eq' && op[1] === 'entity_type' && op[2] === 'hours');
    return { data: filtersHours ? correctionsRows : historyRows, error: null };
  };
}

describe('reports(): reconciliation — exported fields are the source records, untouched', () => {
  it('passes through the stats/hours/corrections/trend/review rows exactly as the database returned them', async () => {
    const stats = { booked: 10, attended: 8, female: 5, male: 2, other_gender: 1, not_recorded_gender: 0, intake_sessions: 2, follow_up_sessions: 5, termination_sessions: 1, counselling_minutes: 480 };
    const hoursRows = [{ code: 'counselling', name: 'Counselling', total: 8, encounter_hours: 8, manual_hours: 0 }];
    const trendRows = [{ month: '2026-04-01', booked: 1, attended: 1, hours: 1 }, { month: '2026-05-01', booked: 2, attended: 2, hours: 2 }];
    const correctionsRows = [{ entity_id: '101', reason: 'Fixed date', created_at: '2026-09-05T00:00:00Z' }];
    const historyRows = [{ action: 'review', reason: null, created_at: '2026-09-10T00:00:00Z', detail: '{}' }];

    const { admin } = createNamedMockAdmin({
      tables: {
        monthly_reports: { data: { id: 42, status: 'Reviewed', reviewed_by_name: 'Dr X', reviewed_at: '2026-09-10T00:00:00Z' }, error: null },
        hours: { data: [{ id: 101 }, { id: 102 }], error: null },
        audit_log: audit_log(correctionsRows, historyRows)
      },
      rpcs: {
        report_encounter_stats: { data: stats, error: null },
        range_requirement_hours: { data: hoursRows, error: null },
        report_trend_stats: { data: trendRows, error: null }
      }
    });
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    const result = await h.reports(ctx, {}, fakeUrl('?intern_id=5&month=2026-09-01'), {}, 'GET');

    expect(result.stats).toEqual(stats);
    expect(result.hours).toEqual(hoursRows);
    expect(result.trend).toEqual(trendRows);
    expect(result.corrections).toEqual(correctionsRows);
    expect(result.review_history).toEqual(historyRows);
    expect(typeof result.refreshed_at).toBe('string');
  });

  it('only looks up corrections/review history for hours entries actually in this period', async () => {
    const { admin, calls } = createNamedMockAdmin({
      tables: {
        monthly_reports: { data: { id: 7, status: 'Draft' }, error: null },
        hours: { data: [{ id: 101 }, { id: 102 }], error: null },
        audit_log: audit_log([], [])
      },
      rpcs: {
        report_encounter_stats: { data: {}, error: null },
        range_requirement_hours: { data: [], error: null },
        report_trend_stats: { data: [], error: null }
      }
    });
    getAdminMock.mockReturnValue(admin);
    await h.reports(ctxFor('programme_lead'), {}, fakeUrl('?intern_id=5&month=2026-09-01'), {}, 'GET');
    const correctionsQuery = calls.find(c => c.table === 'audit_log' && c.ops.some(op => op[0] === 'eq' && op[2] === 'hours'));
    const inOp = correctionsQuery.ops.find(op => op[0] === 'in');
    expect(inOp[2]).toEqual(['101', '102']); // exactly this period's hours ids, no more, no less
  });
});

describe('reports(): does not mix data belonging to different interns', () => {
  it('scopes report_encounter_stats and range_requirement_hours to the requested intern each time', async () => {
    const { admin } = createNamedMockAdmin({
      tables: {
        monthly_reports: (ops) => { const eq = ops.find(o => o[0] === 'eq' && o[1] === 'intern_profile_id'); return { data: { id: eq[2], status: 'Draft' }, error: null }; },
        hours: { data: [], error: null },
        audit_log: audit_log([], [])
      },
      rpcs: {
        report_encounter_stats: (args) => ({ data: { booked: args.p_intern_id * 10, attended: args.p_intern_id }, error: null }),
        range_requirement_hours: (args) => ({ data: [{ code: 'x', name: 'X', total: args.p_intern_id, encounter_hours: 0, manual_hours: 0 }], error: null }),
        report_trend_stats: () => ({ data: [], error: null })
      }
    });
    getAdminMock.mockReturnValue(admin);
    const resultA = await h.reports(ctxFor('programme_lead'), {}, fakeUrl('?intern_id=5&month=2026-09-01'), {}, 'GET');
    const resultB = await h.reports(ctxFor('programme_lead'), {}, fakeUrl('?intern_id=9&month=2026-09-01'), {}, 'GET');
    expect(resultA.stats.booked).toBe(50);
    expect(resultA.hours[0].total).toBe(5);
    expect(resultB.stats.booked).toBe(90);
    expect(resultB.hours[0].total).toBe(9);
  });
});

describe('reports(): does not mix data belonging to different reporting periods', () => {
  it('computes a distinct start/end date range per requested month', async () => {
    const { admin } = createNamedMockAdmin({
      tables: { monthly_reports: { data: null, error: null }, hours: { data: [], error: null }, audit_log: audit_log([], []) },
      rpcs: {
        report_encounter_stats: (args) => ({ data: { start: args.p_start, end: args.p_end }, error: null }),
        range_requirement_hours: () => ({ data: [], error: null }),
        report_trend_stats: () => ({ data: [], error: null })
      }
    });
    getAdminMock.mockReturnValue(admin);
    const jan = await h.reports(ctxFor('programme_lead'), {}, fakeUrl('?intern_id=5&month=2026-01-01'), {}, 'GET');
    const sep = await h.reports(ctxFor('programme_lead'), {}, fakeUrl('?intern_id=5&month=2026-09-01'), {}, 'GET');
    expect(jan.stats).toEqual({ start: '2026-01-01', end: '2026-02-01' });
    expect(sep.stats).toEqual({ start: '2026-09-01', end: '2026-10-01' });
  });
});
