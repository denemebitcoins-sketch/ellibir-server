import { expect, it } from 'vitest';
import type { Client } from '@colyseus/core';
import { PopulationClientSupport, populationAdoptionPlan } from './roomBinding';

const client = (sessionId: string) => ({sessionId} as Client);
it('keeps join capability through a reserved reconnect while another client joins', () => {
  const support = new PopulationClientSupport(), first = client('a'), second = client('b');
  support.observe(first, {populationVersion:1}, [first]);
  support.observe(second, {populationVersion:1}, [second], ['a']);
  expect(support.ready([client('a'), second])).toBe(true);
  support.observe(second, {populationVersion:1}, [second]);
  expect(support.ready([client('a'), second])).toBe(false);
});
it('requires explicit support from every connected client and never accepts an empty room', () => {
  const support = new PopulationClientSupport(), first = client('a'), spectator = client('s');
  support.observe(first, {populationVersion:1}, [first]);
  expect(support.ready([])).toBe(false);
  support.observe(spectator, {populationVersion:'1'}, [first, spectator]);
  expect(support.ready([first, spectator])).toBe(false);
  expect(support.ready([first])).toBe(true);
  support.observe(first, {}, [first]);
  expect(support.ready([first])).toBe(false);
});
it('keeps a supported table identity and does not silently normalize a disallowed bet', () => {
  expect(populationAdoptionPlan('banko',true,7,2500)).toEqual({
    key:'banko:team:7',game:'banko',team:true,table:7,bet:2500,kind:'waiting',waitingBots:1,
  });
  for(const bet of [100,250,750,5500,NaN])expect(populationAdoptionPlan('ihale',false,7,bet)).toBeNull();
  expect(populationAdoptionPlan('ihale',false,0,500)).toBeNull();
});
