import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');

describe('authentication entry point', () => {
  it('uses one Supabase sign-in handler without a stale CAPTCHA gate', () => {
    expect(html).not.toContain('cf-turnstile');
    expect(html).not.toContain('captcha.js');
    expect(html).not.toContain('challenges.cloudflare.com');
    expect(app.match(/signInWithPassword/g)).toHaveLength(1);
    expect(app).toContain("$('#login').onsubmit=async");
  });

  it('does not allow the retired CAPTCHA provider through CSP', () => {
    expect(headers).not.toContain('challenges.cloudflare.com');
    expect(headers).toContain("frame-src 'none'");
  });
});
