import {expect,it,vi} from 'vitest';
import {PopulationRuntime,defaultPopulationPlans} from './runtime';
import {PopulationStorage} from './storage';
import {PopulationDirector} from './director';

it('covers six games with rotating table quotas, not a fixed always-full table number',()=>{
  const plans=defaultPopulationPlans();
  expect(new Set(plans.map(p=>p.game)).size).toBe(6);
  expect(plans.filter(p=>p.kind==='showcase')).toHaveLength(6);
  expect(plans.reduce((n,p)=>n+(p.kind==='showcase'?(p.game==='tavla'?2:4):p.waitingBots!),3)).toBe(38);
  expect(plans.every(p => p.tablePool?.length === 8)).toBe(true);
  expect(new Set(plans.map(p => p.key)).size).toBe(12);
  expect(plans.filter(p=>p.kind==='waiting' && p.waitingBots===3).map(p=>p.game)).toEqual(['51','duz']);
  expect(plans.filter(p=>p.kind==='waiting' && p.waitingBots===2)).toHaveLength(3);
  expect(plans.every(p=>p.kind==='showcase' || p.waitingBots! < (p.game==='tavla'?2:4))).toBe(true);
  expect(plans.every(p=>p.bet===500)).toBe(true);
});
it('off startup seeds and recovers but never provisions, then permanently stops ticks',async()=>{
  const rpc=vi.fn(async(name:string)=>{
    if(name==='bot_population_snapshot') return {control:{mode:'off'},characters:[],leases:[]};
    if(name==='bot_population_process_progression') return {processed:0,failed:0,pending:0};
    return true;
  });
  const factory=vi.fn(); const runtime=new PopulationRuntime(new PopulationStorage(rpc),undefined,factory);
  await runtime.tick(); await runtime.tick();
  expect(rpc.mock.calls.filter(c=>c[0]==='bot_population_seed')).toHaveLength(1);
  expect(rpc.mock.calls.some(c=>c[0]==='bot_population_recover_expired')).toBe(true);
  expect(factory).not.toHaveBeenCalled();
  expect(runtime.status().error).toBe('');
  await runtime.stop();rpc.mockClear();await runtime.tick();runtime.start();
  expect(rpc).not.toHaveBeenCalled();
  await expect(runtime.invite('uid','b0700000-0000-4000-8000-000000000001')).rejects.toThrow('population_stopping');
});
it('fails closed and redacts database failures from exposed runtime health',async()=>{
  const rpc=vi.fn(async(name:string)=>{
    if(name==='bot_population_seed') throw new Error('secret backend token');
    return true;
  });
  const factory=vi.fn();const runtime=new PopulationRuntime(new PopulationStorage(rpc),undefined,factory);
  await expect(runtime.tick()).rejects.toThrow('secret backend token');
  expect(JSON.stringify(runtime.status())).not.toContain('secret');
  expect(factory).not.toHaveBeenCalled();
  expect(rpc.mock.calls.some(c=>c[0]==='bot_population_runtime_health')).toBe(true);
});
it('coalesces pending refreshes and waits for them before stopped maintenance finishes',async()=>{
  let release!: () => void;
  const pendingSeed = new Promise<void>(resolve => { release=resolve; });
  const rpc=vi.fn(async(name:string)=>{
    if(name==='bot_population_seed') { await pendingSeed; return true; }
    if(name==='bot_population_snapshot') return {control:{mode:'off'},characters:[],leases:[]};
    if(name==='bot_population_process_progression') return {processed:0,failed:0,pending:0};
    return true;
  });
  const factory=vi.fn();
  const runtime=new PopulationRuntime(new PopulationStorage(rpc),undefined,factory);
  const first=runtime.tick(), duplicate=runtime.tick();
  expect(duplicate).toBe(first);
  expect(rpc).toHaveBeenCalledTimes(1);
  let stopped=false;
  const stopping=runtime.stop().then(()=>{stopped=true;});
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await first; await stopping;
  expect(stopped).toBe(true);
  expect(factory).not.toHaveBeenCalled();
  expect(rpc.mock.calls.filter(c=>c[0]==='bot_population_seed')).toHaveLength(1);
  expect(rpc.mock.calls.filter(c=>c[0]==='bot_population_process_progression')).toHaveLength(1);
  const completedCalls=rpc.mock.calls.length;
  await runtime.tick(); runtime.start(); await runtime.stop();
  expect(rpc).toHaveBeenCalledTimes(completedCalls);
});
it('reports optional social failure without failing maintenance or leaking service errors',async()=>{
  const rpc=vi.fn(async(name:string)=>{
    if(name==='bot_population_snapshot') return {control:{mode:'off'},characters:[],leases:[]};
    if(name==='bot_population_process_progression') return {processed:0,failed:0,pending:0};
    if(name==='bot_population_process_social') throw new Error('secret service response');
    return true;
  });
  const runtime=new PopulationRuntime(new PopulationStorage(rpc));
  await expect(runtime.tick()).resolves.toBeUndefined();
  expect(rpc).toHaveBeenCalledWith('bot_population_process_social',{},3000);
  const health=rpc.mock.calls.find(c=>c[0]==='bot_population_runtime_health')!;
  expect(JSON.stringify(health)).toContain('population_social_retry');
  expect(JSON.stringify(health)).not.toContain('secret');
  expect(runtime.status().error).toBe('');
  await runtime.stop();
});
it('routes verified invite identities through the serialized director adoption path',async()=>{
  const rpc=vi.fn(async(name:string)=>{
    if(name==='bot_population_snapshot')return {control:{mode:'running',max_active:0},characters:[],leases:[]};
    if(name==='bot_population_process_progression')return {processed:0,failed:0,pending:0};
    return true;
  });
  const provider={open:vi.fn(async()=>null),close:vi.fn(async()=>{})};
  const runtime=new PopulationRuntime(new PopulationStorage(rpc),undefined,()=>provider);
  const invite=vi.spyOn(PopulationDirector.prototype,'inviteHuman').mockResolvedValue();
  try {
    await runtime.invite('verified-user','b0700000-0000-4000-8000-000000000001');
    expect(invite).toHaveBeenCalledExactlyOnceWith('verified-user','b0700000-0000-4000-8000-000000000001');
    await expect(runtime.invite('verified-user','not-a-character')).rejects.toThrow('population_invite_invalid');
    expect(invite).toHaveBeenCalledTimes(1);
  } finally {invite.mockRestore();await runtime.stop();}
});
