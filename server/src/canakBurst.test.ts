import { afterEach, describe, expect, it, vi } from 'vitest';

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const textResponse = (body: string, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
});

describe('canakBurst ödeme güvenliği', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('çanak alındıktan sonra çip ödemesi başarısızsa tutarı çanağa geri ekler', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/canak_events?')) return jsonResponse([]);
      if (url.includes('/rpc/canak_take')) return textResponse('500');
      if (url.includes('/rpc/add_chips')) return textResponse('false');
      if (url.includes('/rpc/canak_add')) return textResponse('500');
      throw new Error(`unexpected fetch ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { canakBurst } = await import('./supabase');
    const amount = await canakBurst('okey', 'user-1', 'Samet');

    expect(amount).toBe(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/canak_add'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/lobby_chat'))).toBe(false);
  });
});
