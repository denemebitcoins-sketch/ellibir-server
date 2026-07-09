import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(__dirname, '..', 'social-schema.sql'), 'utf8');

describe('chip economy RPC schema contract', () => {
  it('defines the service-role RPCs used by Colyseus economy flows', () => {
    expect(schema).toMatch(/create\s+or\s+replace\s+function\s+public\.add_chips\s*\(\s*p_user_id\s+text\s*,\s*p_amount\s+bigint\s*\)/i);
    expect(schema).toMatch(/create\s+or\s+replace\s+function\s+public\.deduct_chips\s*\(\s*p_user_id\s+text\s*,\s*p_amount\s+bigint\s*\)/i);
    expect(schema).toMatch(/revoke\s+execute\s+on\s+function\s+public\.add_chips\(text,\s*bigint\)\s+from\s+public,\s*anon,\s*authenticated/i);
    expect(schema).toMatch(/revoke\s+execute\s+on\s+function\s+public\.deduct_chips\(text,\s*bigint\)\s+from\s+public,\s*anon,\s*authenticated/i);
    expect(schema).toMatch(/grant\s+execute\s+on\s+function\s+public\.add_chips\(text,\s*bigint\)\s+to\s+service_role/i);
    expect(schema).toMatch(/grant\s+execute\s+on\s+function\s+public\.deduct_chips\(text,\s*bigint\)\s+to\s+service_role/i);
  });
});