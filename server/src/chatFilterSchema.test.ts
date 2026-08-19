import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', '20260819_chat_filter_management.sql'), 'utf8');

describe('central chat filter schema', () => {
  it('creates a managed word list with safe defaults', () => {
    expect(migration).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.chat_banned_words/i);
    expect(migration).toMatch(/match_mode\s+text\s+not\s+null\s+default\s+'word'/i);
    expect(migration).toMatch(/check\s+\(match_mode\s+in\s+\('word',\s*'contains'\)\)/i);
    expect(migration).toMatch(/active\s+boolean\s+not\s+null\s+default\s+true/i);
    expect(migration).toMatch(/alter\s+table\s+public\.chat_banned_words\s+enable\s+row\s+level\s+security/i);
  });

  it('filters lobby chat and direct messages before insert', () => {
    expect(migration).toMatch(/function\s+public\.apply_chat_filter\(p_text\s+text\)/i);
    expect(migration).toMatch(/regexp_replace\(v_text,\s*v_pattern,\s*'\\1\*\*\*\\3',\s*'gi'\)/i);
    expect(migration).toMatch(/create\s+trigger\s+trg_lobby_chat_filter_text[\s\S]*before\s+insert\s+on\s+public\.lobby_chat/i);
    expect(migration).toMatch(/create\s+trigger\s+trg_direct_messages_filter_text[\s\S]*before\s+insert\s+on\s+public\.direct_messages/i);
  });

  it('exposes admin-only list, upsert and delete RPCs', () => {
    expect(migration).toMatch(/function\s+public\.admin_list_chat_filter_words\(\)/i);
    expect(migration).toMatch(/function\s+public\.admin_upsert_chat_filter_word\(/i);
    expect(migration).toMatch(/select\s+id[\s\S]*from\s+public\.chat_banned_words[\s\S]*where\s+term\s+=\s+v_term/i);
    expect(migration).toMatch(/function\s+public\.admin_delete_chat_filter_word\(p_id\s+bigint\)/i);
    expect(migration).toMatch(/not\s+public\.is_current_user_admin\(\)/i);
    expect(migration).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_list_chat_filter_words\(\)\s+to\s+authenticated/i);
    expect(migration).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_upsert_chat_filter_word\(bigint,\s*text,\s*text,\s*boolean\)\s+to\s+authenticated/i);
    expect(migration).toMatch(/grant\s+execute\s+on\s+function\s+public\.admin_delete_chat_filter_word\(bigint\)\s+to\s+authenticated/i);
  });
});
