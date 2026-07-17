import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(resolve(__dirname, '../migrations/20260716_push_notifications.sql'), 'utf8');
const worker = readFileSync(resolve(__dirname, './pushWorker.ts'), 'utf8');

describe('push notification schema', () => {
  it('keeps device tokens private and registration authenticated', () => {
    expect(sql).toContain('alter table public.push_devices enable row level security');
    expect(sql).toContain('revoke all on public.push_devices from public, anon, authenticated');
    expect(sql).toContain('grant execute on function public.register_push_device(text, text, text) to authenticated');
  });

  it('queues privacy-safe DM notifications through an outbox', () => {
    expect(sql).toContain('after insert on public.direct_messages');
    expect(sql).toContain("' sana mesaj gönderdi.'");
    expect(sql).not.toMatch(/new\.text/i);
    expect(sql).toContain('for update skip locked');
  });

  it('restricts claim, completion and system broadcasts to service role', () => {
    expect(sql).toContain("current_user not in ('service_role', 'postgres')");
    expect(sql).toContain('grant execute on function public.claim_push_outbox(integer) to service_role');
    expect(sql).toContain('grant execute on function public.enqueue_system_push(text, text, jsonb) to service_role');
  });

  it('uses the RFC 7523 JWT bearer grant for Firebase OAuth', () => {
    expect(worker).toContain('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(worker).not.toContain('urn:ietf:params:oauth2:grant-type:jwt-bearer');
  });
});
