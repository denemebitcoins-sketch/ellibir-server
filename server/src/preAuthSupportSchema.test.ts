import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', '20260819_pre_auth_support_reports.sql'), 'utf8');
const index = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
const source = readFileSync(join(root, 'src', 'preAuthSupport.ts'), 'utf8');

describe('pre-auth support reports', () => {
  it('allows reports without an authenticated sender', () => {
    expect(migration).toMatch(/alter\s+table\s+public\.reports[\s\S]*alter\s+column\s+from_user\s+drop\s+not\s+null/i);
  });

  it('exposes an unauthenticated support endpoint with rate limiting', () => {
    expect(index).toMatch(/post\('\/support\/preauth\/report'/i);
    expect(source).toMatch(/type:\s*'baglanti'/i);
    expect(source).toMatch(/too_many_requests/i);
    expect(source).toMatch(/contact_email/i);
    expect(source).toMatch(/if\s*\(!validEmail\(contactEmail\)\)\s*throw\s+new\s+Error\('email_invalid'\)/i);
    expect(source).toMatch(/device_hash/i);
  });
});
