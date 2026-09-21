import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('dashboard preview metrics', () => {
  it('maps the calculated at-risk count to the API metric name', () => {
    const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(source).toContain('at_risk:atRisk');
    expect(source).not.toMatch(/metrics:\{[^}]*\bat_risk\s*\}/);
  });
});
