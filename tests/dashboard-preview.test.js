import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('dashboard preview metrics', () => {
  it('maps the calculated at-risk count to the API metric name', () => {
    const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(source).toContain('at_risk:atRisk');
    expect(source).not.toMatch(/metrics:\{[^}]*\bat_risk\s*\}/);
  });

  it('deduplicates weekly sessions across cases, activity logs and appointments', () => {
    const source = fs.readFileSync(new URL('../functions/api/_handlers.js', import.meta.url), 'utf8');
    expect(source).toContain("select('intern_profile_id,work_date,hours,service_type,component_code')");
    expect(source).toContain('s._activity_sessions += Math.max(1, Math.round(Number(h.hours || 0) / sessionHoursByIntern[h.intern_profile_id]))');
    expect(source).toContain('s.attended_week = Math.max(s._encounter_attended, s._activity_sessions, s._appointment_attended)');
    expect(source).not.toContain('s.attended_week += Math.max(1');
  });
});
