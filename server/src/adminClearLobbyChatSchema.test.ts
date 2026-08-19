import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', '20260819_admin_clear_lobby_chat.sql'), 'utf8');

describe('admin lobby chat clearing', () => {
  it('creates an audit table that regular clients cannot read or write', () => {
    expect(migration).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.lobby_chat_clear_audit/i);
    expect(migration).toMatch(/alter\s+table\s+public\.lobby_chat_clear_audit\s+enable\s+row\s+level\s+security/i);
    expect(migration).toMatch(/revoke\s+all\s+on\s+public\.lobby_chat_clear_audit\s+from\s+public,\s*anon,\s*authenticated/i);
    expect(migration).toMatch(/grant\s+all\s+on\s+public\.lobby_chat_clear_audit\s+to\s+service_role/i);
  });

  it('exposes a server-side admin RPC that deletes lobby chat and logs the action', () => {
    expect(migration).toMatch(/function\s+public\.admin_clear_lobby_chat\(\)/i);
    expect(migration).toMatch(/security\s+definer/i);
    expect(migration).toMatch(/not\s+public\.is_current_user_admin\(\)/i);
    expect(migration).toMatch(/delete\s+from\s+public\.lobby_chat\s+where\s+id\s+is\s+not\s+null/i);
    expect(migration).toMatch(/insert\s+into\s+public\.lobby_chat_clear_audit/i);
    expect(migration).toMatch(/jsonb_build_object\('ok',\s*true,\s*'cleared_count',\s*v_count\)/i);
    expect(migration).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_clear_lobby_chat\(\)\s+to\s+authenticated/i);
  });
});
