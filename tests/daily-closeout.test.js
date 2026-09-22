import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const handlers = fs.readFileSync(new URL('../functions/api/_handlers.js', import.meta.url), 'utf8');
const router = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

describe('How was today? daily close-out', () => {
  it('is available to interns and derives its summary from existing records', () => {
    expect(app).toContain("daily: 'How was today?'");
    expect(app).toContain('No duplicate capture:');
    expect(router).toContain("path === 'daily-summary'");
    expect(handlers).toContain('export async function dailySummary');
    expect(handlers).toContain("admin.from('encounters')");
    expect(handlers).toContain("admin.from('hours')");
  });

  it('covers the required daily statistics', () => {
    for (const field of ['booked', 'attended', 'did_not_attend', 'female', 'male', 'intake_sessions', 'follow_up_sessions']) {
      expect(handlers).toContain(`${field}:`);
    }
  });

  it('offers individual, group and family counselling in one activity selector', () => {
    expect(app).toContain("'Individual counselling'");
    expect(app).toContain("'Group counselling'");
    expect(app).toContain("'Family counselling'");
    expect(app).toContain('Includes Individual, Group and Family counselling.');
  });
});
