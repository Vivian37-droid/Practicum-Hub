import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockAdmin, ctxFor } from './helpers/mockAdmin.js';

const getAdminMock = vi.fn();
vi.mock('../functions/_shared/clients.js', () => ({ getAdmin: (...args) => getAdminMock(...args) }));
const { audit } = await import('../functions/_shared/context.js');

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const router = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

describe('audit log failures', () => {
  beforeEach(() => getAdminMock.mockReset());

  it('does not turn a completed save into an error', async () => {
    getAdminMock.mockReturnValue(createMockAdmin([{ data: null, error: { message: 'audit unavailable' } }]).admin);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(audit(ctxFor('intern'), {}, 'create', 'encounter', 5, {}, 1)).resolves.toBeNull();
    spy.mockRestore();
  });

  it('still blocks a delete that has no snapshot to undo from', async () => {
    getAdminMock.mockReturnValue(createMockAdmin([{ data: null, error: { message: 'audit unavailable' } }]).admin);
    await expect(audit(ctxFor('programme_lead'), {}, 'delete', 'referral', 5, {}, 1)).rejects.toMatchObject({ status: 500 });
  });
});

describe('forms and sign-in', () => {
  it('asks before a tap outside, Escape or × discards a filled-in form', () => {
    expect(app).toMatch(/\$\('#modal'\)\.onclick=e=>\{if\(e\.target\.id==='modal'\)requestCloseModal\(\);\}/);
    expect(app).toContain("$('#modalClose').onclick=requestCloseModal");
    expect(app).toContain("el.id === 'modal' ? requestCloseModal() : closeDialog(el)");
  });

  it('keeps an unsaved form across the idle sign-out', () => {
    expect(app).toMatch(/idleLogoutTimer=setTimeout\(async\(\)=>\{saveFormDraft\(\);/);
    expect(app).toContain('offerFormDraft();');
  });

  it('keeps messages up long enough to read', () => {
    expect(app).not.toContain('action ? 8000 : 2200');
  });

  it('trims the email and explains common sign-in failures', () => {
    expect(app).toContain("email:$('#email').value.trim()");
    expect(app).toContain('function friendlyAuthError');
  });

  it('does not compute the dashboard twice on sign-in', () => {
    expect(router).not.toContain('dashboard: await h.dashboard');
  });
});
