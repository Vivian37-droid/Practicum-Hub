import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const captcha=readFileSync(new URL('../public/captcha.js',import.meta.url),'utf8');
const headers=readFileSync(new URL('../public/_headers',import.meta.url),'utf8');

describe('Turnstile authentication protection',()=>{
  it('loads the public widget using the configured site key',()=>{
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).toContain('data-sitekey="0x4AAAAAAFEIVqVboXF4FLZG"');
    expect(html).toContain('src="/captcha.js"');
  });
  it('passes the CAPTCHA token to sign-in and password reset',()=>{
    expect(captcha).toContain('options:{captchaToken}');
    expect(captcha).toContain('captchaToken});');
    expect(captcha).toContain('Complete the security check before continuing.');
  });
  it('allows Turnstile through the content security policy',()=>{
    expect(headers).toContain("script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com");
    expect(headers).toContain('frame-src https://challenges.cloudflare.com');
  });
});
