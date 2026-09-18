import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./supabase',()=>({ onlineAuthRequired:()=>true,supabaseConfigured:()=>true,rpcService:vi.fn() }));
import { rpcService } from './supabase';
import { giftRecipientsAllowed } from './gifts';
afterEach(()=>vi.clearAllMocks());
describe('gift privacy before charging',()=>{
  it('checks human recipients, deduplicates, and fails closed',async()=>{
    vi.mocked(rpcService).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('offline'));
    expect(await giftRecipientsAllowed(['human','human','bot:test',undefined])).toBe(false);
    expect(rpcService).toHaveBeenCalledWith('gift_recipients_allowed',{p_users:['human']},5000);
    expect(await giftRecipientsAllowed(['human'])).toBe(true);
    expect(await giftRecipientsAllowed(['human'])).toBe(false);
  });
  it('does not require a profile for local bot seats',async()=>{
    expect(await giftRecipientsAllowed([undefined,'bot:test'])).toBe(true);
    expect(rpcService).not.toHaveBeenCalled();
  });
});
