import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('dashboard preview metrics', () => {
  it('maps the calculated at-risk count to the API metric name', () => {
    const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(source).toContain('at_risk:atRisk');
    expect(source).not.toMatch(/metrics:\{[^}]*\bat_risk\s*\}/);
  });

  it('includes manually logged individual counselling in weekly sessions', () => {
    const source = fs.readFileSync(new URL('../functions/api/_handlers.js', import.meta.url), 'utf8');
    expect(source).toContain("select('intern_profile_id,work_date,hours,service_type,component_code')");
    expect(source).toContain("Math.round(Number(h.hours || 0) / sessionHoursByIntern[h.intern_profile_id])");
  });
});
