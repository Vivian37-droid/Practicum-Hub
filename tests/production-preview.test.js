import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

describe('production preview protection', () => {
  it('limits demo mode to localhost and removes production preview parameters', () => {
    const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(source).toContain("pr=isLocal?(window.__AUTO_PREVIEW__||qp.get('preview')):null");
    expect(source).toContain("if(!isLocal&&qp.has('preview'))");
    expect(source).not.toContain("||pr!==null");
  });
});
