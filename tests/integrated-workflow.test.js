import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/0012_integrated_placement_workflow.sql', import.meta.url), 'utf8');
const handlers = readFileSync(new URL('../functions/api/_handlers.js', import.meta.url), 'utf8');
const router = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('integrated referral-to-case workflow', () => {
  it('links each referral to at most one case', () => {
    expect(migration).toMatch(/add column if not exists referral_id/i);
    expect(migration).toMatch(/unique index[\s\S]*cases\(referral_id\)/i);
  });

  it('creates or updates a case when a referral reaches clinical stages', () => {
    expect(migration).toContain('create or replace function sync_referral_case()');
    expect(migration).toContain("when new.status = 'Booked' then 'Booked'");
    expect(migration).toContain("when new.status = 'Intake completed' then 'Intake'");
    expect(migration).toContain("when new.status in ('Active', 'Awaiting feedback') then 'Active'");
    expect(migration).toMatch(/on conflict \(referral_id\)/i);
  });
});

describe('whole-placement oversight', () => {
  it('provides an authorised intern overview endpoint', () => {
    expect(handlers).toContain('export async function internOverview');
    expect(handlers).toMatch(/internOverview[\s\S]*assertInternAccess\(ctx, id, env\)/);
    expect(router).toContain("path === 'intern-overview'");
  });

  it('provides supervised milestone updates', () => {
    expect(migration).toContain('create table if not exists placement_milestones');
    expect(handlers).toContain("requireRole(ctx, ['programme_lead', 'supervisor'])");
    expect(router).toContain("path === 'milestones'");
  });

  it('surfaces the overview, read-only intern preview and supervision agenda', () => {
    expect(app).toContain("overview: 'Intern overview'");
    expect(app).toContain('Read-only intern preview:');
    expect(app).toContain('Suggested supervision agenda');
    expect(app).toContain('Referral saved · available in Case Workflow');
  });
});
