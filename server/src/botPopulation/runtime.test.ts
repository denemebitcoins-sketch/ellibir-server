import {expect,it,vi} from 'vitest';
import {PopulationRuntime,defaultPopulationPlans} from './runtime';
import {PopulationStorage} from './storage';

it('ships bounded six-game plans with only two showcase tables',()=>{
  const plans=defaultPopulationPlans();
  expect(new Set(plans.map(p=>p.game)).size).toBe(6);
  expect(plans.filter(p=>p.kind==='showcase')).toHaveLength(2);
  expect(plans.reduce((n,p)=>n+(p.kind==='showcase'?(p.game==='tavla'?2:4):p.waitingBots!),3)).toBe(20);
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
