// Prompt 4: "unauthorised users cannot perform restricted actions." Every
// destructive/finalising endpoint checks role server-side before touching
// the database (role is derived from PROGRAMME_LEAD_EMAILS / auth metadata,
// never from anything the client sends — see functions/_shared/context.js).
// These tests prove the rejection happens, and — just as importantly for
// "do not modify production records during testing" — that it happens
// *before* any admin.from()/rpc() call, i.e. a rejected request touches no
// data at all, real or mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockAdmin, ctxFor } from './helpers/mockAdmin.js';

const { getAdminMock } = vi.hoisted(() => ({ getAdminMock: vi.fn() }));
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: getAdminMock }));

const h = await import('../functions/api/_handlers.js');

function fakeUrl(qs = '') { return new URL('https://hub.example.test/api/x' + qs); }

beforeEach(() => { getAdminMock.mockReset(); });

describe('destructive endpoints reject the wrong role before touching data', () => {
  it('interns() DELETE: an intern cannot deactivate any placement', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('intern');
    await expect(h.interns(ctx, {}, fakeUrl('?id=5'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('interns() DELETE: a supervisor cannot deactivate a placement (programme_lead only)', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.interns(ctx, {}, fakeUrl('?id=5'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('interns() PATCH reactivate: a supervisor cannot reactivate a placement', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.interns(ctx, {}, fakeUrl(), { id: 5, action: 'reactivate' }, 'PATCH')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('cases() DELETE: a supervisor cannot delete a case', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.cases(ctx, {}, fakeUrl('?id=9'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('referrals() DELETE: an intern cannot delete a referral', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('intern');
    await expect(h.referrals(ctx, {}, fakeUrl('?id=9'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('supervision() DELETE: a supervisor cannot delete a supervision item', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.supervision(ctx, {}, fakeUrl('?id=9'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('hoursView() DELETE: a supervisor cannot delete a logged hours entry', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.hoursView(ctx, {}, fakeUrl('?id=9'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('hoursView() PATCH: a supervisor cannot correct a logged hours entry', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.hoursView(ctx, {}, fakeUrl(), { id: 9, hours: 2, reason: 'fix' }, 'PATCH')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('feedback() DELETE: a supervisor cannot delete a feedback entry', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.feedback(ctx, {}, fakeUrl('?id=9'), {}, 'DELETE')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('restoreAudit(): only programme_lead may restore a deleted record', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('supervisor');
    await expect(h.restoreAudit(ctx, {}, fakeUrl(), { audit_id: 1 }, 'POST')).rejects.toMatchObject({ status: 403 });
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('restoreAudit(): rejects a non-POST method before checking role or data', async () => {
    const { admin } = createMockAdmin([]);
    getAdminMock.mockReturnValue(admin);
    const ctx = ctxFor('programme_lead');
    await expect(h.restoreAudit(ctx, {}, fakeUrl(), { audit_id: 1 }, 'GET')).rejects.toMatchObject({ status: 405 });
    expect(admin.from).not.toHaveBeenCalled();
  });
});
