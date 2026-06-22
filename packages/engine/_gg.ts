import { createGame, applyMove } from './src/game';
import type { GameState } from './src/types';
function dig(s:GameState):string{
  const hands=s.players.map(p=>p.hand.map(c=>c.id).join('.')).join('/');
  const meta=[s.handNumber,s.phase,s.currentSeat,s.turnCount,s.stock.length,s.discard.length,(s.discard[s.discard.length-1]?.id??'-')].join(',');
  const pl=s.players.map(p=>`${p.hand.length}:${p.totalScore}:${p.hasOpened?1:0}:${p.isCift?1:0}`).join('|');
  return meta+' ['+pl+'] m'+s.melds.length;
}
let s=createGame({seed:999,dealerSeat:0});
const out:string[]=[dig(s)];
for(let i=0;i<40 && s.phase!=='handEnded' && s.phase!=='matchEnded';i++){
  if(s.phase==='draw'){ s=applyMove(s,{type:'drawStock'}); }
  else { const p=s.players[s.currentSeat]; const last=p.hand[p.hand.length-1]; s=applyMove(s,{type:'discard',cardId:last.id}); }
  out.push(dig(s));
}
out.forEach((l,i)=>console.log(i,l));
