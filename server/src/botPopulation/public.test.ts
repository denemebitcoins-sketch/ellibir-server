import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { populationPublicRouter } from './public';

vi.mock('../supabase',()=>({supabaseConfigured:()=>true,verifyToken:async(token:string)=>token==='valid'?'verified-user':null}));
let server:Server, base:string;
const invite=vi.fn(async()=>{}), character='b0700000-0000-4000-8000-000000000001';
beforeAll(async()=>{
  const app=express(); app.use(express.json()); app.use('/bots',populationPublicRouter(invite));
  server=createServer(app); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/bots/invite`;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
function send(body:any,token='valid'){return fetch(base,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});}
describe('authenticated bot invitations',()=>{
  it('rejects unauthenticated and non-character identities',async()=>{
    expect((await send({character},'wrong')).status).toBe(401);
    expect((await send({character:'human-uuid'})).status).toBe(400);
    expect(invite).not.toHaveBeenCalled();
  });
  it('ignores client room/seat/user claims and limits repeated invitations',async()=>{
    expect((await send({character,uid:'forged',room:'victim-room',seat:0})).status).toBe(200);
    expect(invite).toHaveBeenCalledWith('verified-user',character);
    expect((await send({character})).status).toBe(429);
    expect(invite).toHaveBeenCalledOnce();
  });
  it('accepts the other two bots from the same select-all burst, not a fourth',async()=>{
    const id=(n:number)=>`b0700000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const replies=await Promise.all([send({character:id(2)}),send({character:id(3)})]);
    expect(replies.map(r=>r.status)).toEqual([200,200]);
    expect(invite).toHaveBeenCalledTimes(3);
    expect((await send({character:id(4)})).status).toBe(429);
    expect((await send({character:id(2)})).status).toBe(429);
  });
});
