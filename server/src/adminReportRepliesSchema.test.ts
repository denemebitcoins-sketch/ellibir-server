import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', '20260819_admin_report_replies.sql'), 'utf8');

describe('admin report replies', () => {
  it('adds system metadata to direct messages without breaking old rows', () => {
    expect(migration).toMatch(/alter table public\.direct_messages add column if not exists kind text not null default 'msg'/i);
    expect(migration).toMatch(/alter table public\.direct_messages add column if not exists system_sender_name text/i);
    expect(migration).toMatch(/alter table public\.direct_messages add column if not exists reply_locked boolean not null default false/i);
    expect(migration).toMatch(/alter table public\.direct_messages add column if not exists report_id bigint/i);
  });

  it('creates an admin-only RPC that stores the reply as OK management DM', () => {
    expect(migration).toMatch(/function public\.admin_reply_to_report\(/i);
    expect(migration).toMatch(/not public\.is_current_user_admin\(\)/i);
    expect(migration).toMatch(/'OK - Yönetim'/);
    expect(migration).toMatch(/kind, system_sender_name,[\s\S]*reply_locked, report_id, report_type, report_excerpt/i);
    expect(migration).toMatch(/v_body := 'Bildirim türü: '/i);
    expect(migration).toMatch(/'Orijinal içerik: '/i);
    expect(migration).toMatch(/update public\.reports[\s\S]*set status = 'closed'/i);
    expect(migration).toMatch(/grant execute on function public\.admin_reply_to_report\(bigint, text, boolean\) to authenticated/i);
  });

  it('keeps system replies out of user DM quota and uses neutral push text', () => {
    expect(migration).toMatch(/coalesce\(new\.kind, 'msg'\) = 'admin_reply' and public\.is_current_user_admin\(\)/i);
    expect(migration).toMatch(/new\.reply_locked := true/i);
    expect(migration).toMatch(/'OK - Yönetim sana cevap gönderdi\.'/);
    expect(migration).toMatch(/jsonb_build_object\('type', 'dm', 'from_user', new\.from_user::text, 'system', true\)/i);
  });
});
