import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const handlers = fs.readFileSync(new URL('../functions/api/_handlers.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/0011_expand_practicum_activity_types.sql', import.meta.url), 'utf8');

const activityTypes = [
  'Individual counselling',
  'Group counselling',
  'Family counselling',
  'Community talk / psychoeducation',
  'Public health / advocacy',
  'Preparation / documentation',
  'Training',
  'Supervision',
  'Psychological assessment',
  'Ethical / professional activity',
  'Other professional activity'
];

describe('practicum activity types', () => {
  it.each(activityTypes)('offers, accepts and stores %s', type => {
    expect(app).toContain(`'${type}'`);
    expect(handlers).toContain(`'${type}'`);
    expect(migration).toContain(`'${type}'`);
  });

  it('uses the same options for logging and correcting an activity', () => {
    expect(app).toContain('practicumActivityTypeOptions()');
    expect(app).toContain("practicumActivityTypeOptions(x.service_type || 'Other professional activity')");
  });

  it('renames legacy Other activity rows before enforcing the new constraint', () => {
    expect(migration.indexOf("where service_type = 'Other activity'"))
      .toBeLessThan(migration.indexOf('alter table hours add constraint'));
  });
});
