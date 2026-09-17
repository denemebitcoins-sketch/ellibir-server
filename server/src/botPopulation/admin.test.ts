import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { PopulationStorage } from './storage';
import { populationAdminRouter } from './admin';

const auth = vi.hoisted(() => ({ configured: true, uid: 'real-admin-id', role: 'admin' }));
vi.mock('../supabase', () => ({
  rpcService: vi.fn(), supabaseConfigured: () => auth.configured,
  verifyToken: vi.fn(async (token: string) => token === 'valid' ? auth.uid : null),
  resolveClientProfileMeta: vi.fn(async () => ({ role: auth.role })),
}));
const rpc = vi.fn(), refresh = vi.fn(async () => {});
let server: Server, base: string;
let now = 0;
beforeAll(async () => {
  const app = express(); app.use(express.json({limit:'8kb'}));
  app.use('/admin/bots', populationAdminRouter(new PopulationStorage(rpc),refresh, () => now));
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/bots`;
});
beforeEach(() => { now += 10000; auth.configured=true; auth.uid='real-admin-id'; auth.role='admin'; rpc.mockReset(); refresh.mockClear(); });
afterAll(async () => { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); });
function get(token='valid') { return fetch(base,{headers: {authorization: 'Bearer '+token}}); }
function post(body: any) { return fetch(base+'/control',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify(body)}); }
describe('population admin HTTP trust boundary', () => {
  it('requires a valid session before querying bot data', async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await get('invalid')).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('checks the server profile role and ignores claimed client admin role', async () => {
    auth.role='vip';
    expect((await post({role:'admin',mode:'running',revision:0,max_active:24})).status).toBe(403);
    expect((await get()).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('fails closed when server credentials are unavailable', async () => {
    auth.configured=false;
    expect((await get()).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('returns private reports only after auth', async () => {
    rpc.mockResolvedValue({ok:true,summary:{active:0}});
    expect(await (await get()).json()).toEqual({ok:true,summary:{active:0}});
    expect(rpc).toHaveBeenCalledWith('bot_population_admin_report',{});
  });
  it('uses server identity for the compare-and-swap audit and wakes runtime', async () => {
    rpc.mockResolvedValue({mode:'running',revision:8,max_active:24});
    const r = await post({mode:'running',revision:7,max_active:24,actor:'forged'});
    expect(r.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('bot_population_control',{
      p_expected_revision:7,p_mode:'running',p_max_active:24,p_actor:'real-admin-id',
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('rejects force-off, invalid limits, revisions and modes', async () => {
    for (const body of [
      {mode:'off',revision:0,max_active:24}, {mode:'running',revision:0,max_active:101},
      {mode:'running',revision:-1,max_active:24}, {mode:'running',revision:0,max_active:'24'},
    ]) expect((await post(body)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('exposes revision conflicts but not database error bodies or credentials', async () => {
    rpc.mockRejectedValueOnce(new Error('control_revision_conflict'));
    expect((await post({mode:'draining',revision:3,max_active:24})).status).toBe(409);
    rpc.mockRejectedValueOnce(new Error('secret service token HTTP-body'));
    const r = await get();
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ok:false,error:'population_service_unavailable'});
  });
  it('throttles report refreshes before the database and permits the expiry boundary', async () => {
    rpc.mockResolvedValue({ok:true});
    expect((await get()).status).toBe(200);
    const denied = await get();
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('1');
    expect(await denied.json()).toEqual({ok:false,error:'too_many_requests'});
    expect(rpc).toHaveBeenCalledTimes(1);
    now += 999;
    expect((await get()).status).toBe(429);
    now++;
    expect((await get()).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('admits only one concurrent activation and does not repeat the runtime wake', async () => {
    rpc.mockResolvedValue({mode:'running',revision:1,max_active:24});
    const body = {mode:'running',revision:0,max_active:24};
    const results = await Promise.all([post(body), post({...body,actor:'different-client-claim'})]);
    expect(results.map(r => r.status).sort()).toEqual([200,429]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    now += 2000;
    expect((await post({...body,revision:1})).status).toBe(200);
  });
  it('allows immediate draining and report after activation without sharing their budgets', async () => {
    rpc.mockResolvedValue({ok:true});
    expect((await get()).status).toBe(200);
    expect((await post({mode:'running',revision:0,max_active:24})).status).toBe(200);
    expect((await get()).status).toBe(200);
    const body = {mode:'draining',revision:1,max_active:24};
    expect((await post(body)).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect((await post(body)).status).toBe(429);
    expect(rpc).toHaveBeenCalledTimes(5);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('keys limits by verified administrator and always rechecks authorization', async () => {
    rpc.mockResolvedValue({ok:true});
    expect((await get()).status).toBe(200);
    auth.role='vip';
    expect((await get()).status).toBe(403);
    auth.role='admin'; auth.uid='another-real-admin';
    expect((await get()).status).toBe(200);
    auth.uid='real-admin-id';
    expect((await get()).status).toBe(429);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('bounds failed service attempts without swallowing their original error', async () => {
    rpc.mockRejectedValue(new Error('control_revision_conflict'));
    const body = {mode:'running',revision:0,max_active:24};
    expect((await post(body)).status).toBe(409);
    expect((await post(body)).status).toBe(429);
    expect(refresh).not.toHaveBeenCalled();
    now += 2000;
    expect((await post(body)).status).toBe(409);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('bounds actor storage without letting report saturation prevent draining', async () => {
    rpc.mockResolvedValue({ok:true});
    for (let i=0;i<1000;i++) {
      auth.uid=`verified-admin-${i}`;
      expect((await get()).status).toBe(200);
    }
    auth.uid='verified-admin-over-cap';
    expect((await get()).status).toBe(429);
    expect((await post({mode:'draining',revision:0,max_active:24})).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1001);
    now += 1000;
    expect((await get()).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1002);
  });
});
