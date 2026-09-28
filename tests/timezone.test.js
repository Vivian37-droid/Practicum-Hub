import { describe, expect, it } from 'vitest';
import { dateInTimeZone, monthInTimeZone } from '../functions/_shared/util.js';

describe('South African calendar dates', () => {
  it('uses the Johannesburg date during the UTC midnight boundary', () => {
    const instant = new Date('2026-09-27T22:30:00Z');
    expect(dateInTimeZone(instant)).toBe('2026-09-28');
    expect(monthInTimeZone(instant)).toBe('2026-09');
  });
});
