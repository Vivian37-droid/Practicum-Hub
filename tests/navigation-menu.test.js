import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('simplified navigation', () => {
  it('shows every menu group open instead of collapsed', () => {
    expect(app).toContain('NAV_MENUS[role]');
    expect(app).not.toContain('<details class="navgroup"');
  });

  it('puts the daily intern screens first and keeps hidden screens reachable', () => {
    expect(app).toContain("['Every day', ['dashboard', 'daily', 'referrals', 'cases', 'weekly']]");
    expect(app).toContain('data-go="daily">Record today’s work');
    expect(app).toContain('data-go="feedback">Give pilot feedback');
    expect(app).toContain("$('#quickHelp').onclick");
  });

  it('titles each page with the role’s own label', () => {
    expect(app).toContain("$('#title').textContent = (NAV_LABELS[role] || {})[view] || titles[view];");
  });
});
