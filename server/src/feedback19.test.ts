import { afterEach, describe, expect, it, vi } from 'vitest';
import { bankoPlayerMultOf, createOkeyGame } from '../../packages/engine/src/okey';
import { createTavlaGame } from '../../packages/engine/src/tavla';
import { TavlaRoom } from './rooms/TavlaRoom';
import { TavlaPresentationGate } from './tavlaPresentation';

afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('September 19 regressions',()=>{
  it('banko is individual in teams; a winning partner does not cross-double',()=>{
    const s=createOkeyGame({seed:7,rules:{variant:'banko',teamMode:true} as any});
    s.gosterge={id:'g',color:'K',rank:1,isFalseJoker:false} as any;
    for(const winner of [0,1,2,3]) for(const own of [false,true]) for(const partner of [false,true]) {
      const other=(winner+2)%4;
      s.bankoThisEl=[false,false,false,false];s.bankoThisEl[winner]=own;s.bankoThisEl[other]=partner;
      expect(bankoPlayerMultOf(s,winner,winner)).toBe(5*(own?2:1));
      expect(bankoPlayerMultOf(s,winner,other)).toBe(5*(partner?2:1));
      expect(bankoPlayerMultOf(s,winner,(winner+1)%4)).toBe(5*(own?2:1));
    }
    s.bankoThisEl=[true,true,false,false];
    expect(bankoPlayerMultOf(s,0,1)).toBe(20); // opposing individual bankos still compound
    expect(bankoPlayerMultOf(s,-1,2)).toBe(5);
  });
  it('opening is fenced once; no bot move or turn budget starts under the dice',()=>{
    vi.useFakeTimers();
    const room:any=new TavlaRoom();
    room.game=createTavlaGame({seed:7,botSeats:[0,1]});room.pushViews=vi.fn();
    room.afterChange();
    const initial=room.game.points.slice();
    vi.advanceTimersByTime(3000);room.afterChange();
    expect(room.game.points).toEqual(initial);expect(room.botTimer).toBeNull();expect(room.turnDeadlineAt).toBe(0);
    vi.advanceTimersByTime(100);expect(room.botTimer).not.toBeNull();
    vi.advanceTimersByTime(900);expect(room.game.points).not.toEqual(initial);
    room.pausePopulationTimers();
  });
  it('gele holds only the new turn; ordinary rolls do not extend the turn deadline',()=>{
    const gate=new TavlaPresentationGate(),s=createTavlaGame({seed:7});
    expect(gate.observe(s,0)).toBe(3100);expect(gate.observe(s,3000)).toBe(100);
    expect(gate.observe(s,3100)).toBe(0);
    s.rollCount+=2;expect(gate.observe(s,5000)).toBe(0);
    s.rollCount+=2;s.turn=1-s.turn;
    expect(gate.observe(s,6000)).toBe(1400);expect(gate.observe(s,7000)).toBe(400);
    expect(gate.observe(s,7400)).toBe(0);
  });
});
