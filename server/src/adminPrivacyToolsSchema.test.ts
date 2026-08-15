import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../migrations/20260815_admin_privacy_tools.sql'), 'utf8');
const supabaseTs = readFileSync(resolve(__dirname, 'supabase.ts'), 'utf8');
const roomSources = [
  'rooms/EllibirRoom.ts',
  'rooms/OkeyRoom.ts',
  'rooms/TavlaRoom.ts',
].map((file) => readFileSync(resolve(__dirname, file), 'utf8')).join('\n');

describe('admin privacy/search tools schema', () => {
  it('stores admin badge hiding separately from the authoritative role', () => {
    expect(sql).toMatch(/alter table public\.profiles[\s\S]*admin_badge_hidden boolean not null default false/i);
    expect(sql).toMatch(/alter table public\.presence[\s\S]*admin_badge_hidden boolean not null default false/i);
    expect(sql).toMatch(/new\.role := case[\s\S]*when p\.role = 'admin' then 'admin'/i);
    expect(sql).toMatch(/new\.admin_badge_hidden := p\.role = 'admin' and coalesce\(p\.admin_badge_hidden, false\)/i);
  });

  it('lets only backend-verified admins toggle the visible badge', () => {
    const body = sql.match(/function public\.set_admin_badge_hidden[\s\S]*?\$\$;/i)?.[0] ?? '';
    expect(body).toMatch(/if not public\.is_current_user_admin\(\) then/i);
    expect(body).toMatch(/'admin_required'/i);
    expect(body).toMatch(/where id::text = auth\.uid\(\)::text[\s\S]*and role = 'admin'/i);
    expect(sql).toMatch(/grant execute on function public\.set_admin_badge_hidden\(boolean\) to authenticated/i);
  });

  it('records ordinary profile views but ignores administrator views', () => {
    const body = sql.match(/function public\.record_profile_view[\s\S]*?\$\$;/i)?.[0] ?? '';
    expect(body).toMatch(/if public\.is_current_user_admin\(\) then/i);
    expect(body).toMatch(/'admin_view'/i);
    expect(body).toMatch(/insert into public\.profile_views\(viewer_id, target_id\)/i);
    expect(sql).toMatch(/grant execute on function public\.record_profile_view\(text\) to authenticated/i);
  });

  it('keeps admin search behind an admin RPC with Turkish and consonant-tolerant normalization', () => {
    const body = sql.match(/function public\.admin_search_profiles[\s\S]*?\$\$;/i)?.[0] ?? '';
    expect(sql).toMatch(/function public\.ok_search_norm\(p_text text\)/i);
    expect(sql).toMatch(/function public\.ok_search_consonants\(p_text text\)/i);
    expect(sql).toMatch(/'ı', 'i'\).*'ç', 'c'.*'ğ', 'g'.*'ö', 'o'.*'ş', 's'.*'ü', 'u'/is);
    expect(body).toMatch(/if not public\.is_current_user_admin\(\) then\s*return;/i);
    expect(body).toMatch(/public\.ok_search_norm\(p\.name\) like '%' \|\| q_norm \|\| '%'/i);
    expect(body).toMatch(/public\.ok_search_consonants\(p\.name\) like '%' \|\| q_cons \|\| '%'/i);
    expect(sql).toMatch(/grant execute on function public\.admin_search_profiles\(text\) to authenticated/i);
  });

  it('passes hidden admin badge state to game views without weakening server admin authority', () => {
    expect(supabaseTs).toContain('select=name,gender,role,vip_until,admin_badge_hidden');
    expect(supabaseTs).toMatch(/adminBadgeHidden:\s*role === 'admin' && row\?\.admin_badge_hidden === true/i);
    expect(supabaseTs).toMatch(/displayProfileRole\(role: string, adminBadgeHidden: boolean\)/i);
    expect(roomSources).toMatch(/role !== 'admin'/i);
    expect(roomSources).toMatch(/s\.role = m\.role; s\.gender = m\.gender; s\.admin_badge_hidden = m\.adminBadgeHidden === true;/i);
    expect(roomSources).toMatch(/displayProfileRole\(m\?\.role \?\? 'normal', m\?\.adminBadgeHidden === true\)/i);
  });
});
