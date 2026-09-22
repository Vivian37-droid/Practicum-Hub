import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

describe('stable authenticated actions', () => {
  it('refreshes and retries a transiently expired session without reloading the page', () => {
    expect(app).toContain('async function accessSession(forceRefresh = false)');
    expect(app).toContain('S.supabase.auth.refreshSession()');
    expect(app).toContain('if (response.status === 401)');
    expect(app).not.toContain("if (!session) { location.reload(); throw Error('Your session has expired. Please sign in again.'); }");
  });
});

describe('desktop navigation', () => {
  it('lets the category list scroll within the fixed-height sidebar', () => {
    expect(styles).toContain('#nav{flex:1;min-height:0;overflow-y:auto');
    expect(styles).toContain('.partner-mini,.foot{flex-shrink:0}');
  });
});
