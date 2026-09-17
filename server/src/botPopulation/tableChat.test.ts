import {expect,it} from 'vitest';
import {PopulationTableChat} from './tableChat';
it('keeps greetings sparse, fixed, human-facing and idempotent',()=>{
  let now=0; const chat=new PopulationTableChat(()=>now,()=>0);
  expect(chat.message('a','start',false)).toBeNull();
  expect(chat.message('a','start',true)).toBe('Iyi oyunlar.');
  expect(chat.message('a','finish',true)).toBeNull();
  now=90000;
  expect(chat.message('a','start',true)).toBeNull();
  expect(chat.message('a','finish',true)).toBe('Tebrikler.');
  now=180000;
  expect(chat.message('b','start',true)).toBe('Iyi oyunlar.');
});
