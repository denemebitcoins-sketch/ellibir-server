import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {initialCharacters} from '../src/botPopulation/characters';

// Opt-in native test: always creates a NEW loopback-only cluster. No external DB URL.
const bin=process.env.BOT_POPULATION_NATIVE_BIN;
if(!bin) throw new Error('Set BOT_POPULATION_NATIVE_BIN to a PostgreSQL bin directory. No existing database is used.');
const exe=(name:string)=>join(resolve(bin),name+(process.platform==='win32'?'.exe':''));
const exec=promisify(execFile);
const owner='60000000-0000-4000-8000-000000000001',other='60000000-0000-4000-8000-000000000002';
const uid='60000000-0000-4000-8000-000000000003';
const token=(i:number)=>`61000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const chars=initialCharacters(),room='tavla:solo:1';
let port:number,root:string,data:string,password:string,started=false;
const evidence:any={checks:[],waits:[],sources:['https://www.postgresql.org/docs/16/app-initdb.html',
  'https://www.postgresql.org/docs/16/app-pg-ctl.html','https://www.postgresql.org/docs/16/explicit-locking.html']};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const env=(label:string)=>({...process.env,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:'postgres',PGDATABASE:'postgres',
  PGHOSTADDR:'127.0.0.1',PGSERVICE:undefined,PGSERVICEFILE:undefined,PGOPTIONS:undefined,PGSSLMODE:'disable',
  PGPASSWORD:password,PGAPPNAME:label,PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8'});
function session(label:string,vars:Record<string,unknown>={}) {
  const args=['-X','-q','-A','-t','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'];
  for(const [key,value] of Object.entries(vars)) {
    assert.match(key,/^[a-z][a-z0-9_]*$/i);
    args.push('-v',`${key}=${typeof value==='object'?JSON.stringify(value):String(value)}`);
  }
  const child=spawn(exe('psql'),args,{env:env(label),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';
  child.stdout.on('data',chunk=>{out+=chunk.toString('utf8');});
  child.stderr.on('data',chunk=>{err+=chunk.toString('utf8');});
  const done=new Promise<string>((ok,fail)=>{
    child.on('error',fail);
    child.on('close',code=>code===0?ok(out.trim()):fail(new Error(`${label}: ${err.trim()}`)));
  });
  void done.catch(()=>{});
  child.stdin.write("set request.jwt.claim.role='service_role';set statement_timeout='15s';set lock_timeout='10s';\n");
  return {child,done,output:()=>out};
}
async function sql(text:string,label='probe',vars:Record<string,unknown>={}) {
  const s=session(label,vars);s.child.stdin.end(text+'\n');return s.done;
}
async function value(text:string,vars:Record<string,unknown>={}) {return JSON.parse(await sql(text,'probe',vars));}
function rpc(name:string,args:Record<string,unknown>,label='rpc') {
  assert.match(name,/^bot_population_[a-z_]+$/);
  const vars:Record<string,unknown>={};
  const parameters=Object.entries(args).map(([key,v],i)=>{
    assert.match(key,/^p_[a-z_]+$/);if(v===null)return `${key}=>null`;
    vars[`v${i}`]=v;return `${key}=>:'v${i}'`;
  });
  return sql(`select public.${name}(${parameters.join(',')});`,label,vars).then(s=>JSON.parse(s));
}
async function barrier(table='control') {
  assert.ok(['control','social_control'].includes(table));
  const s=session('barrier');
  s.child.stdin.write(`begin;select 1 from bot_population.${table} where singleton for update;select '"HELD"'::jsonb;\n`);
  const end=Date.now()+5000;
  while(!s.output().includes('"HELD"')) {if(Date.now()>end)throw new Error('barrier was not acquired');await delay(20);}
  return async()=>{s.child.stdin.end('commit;\n');await s.done;};
}
async function waiting(labels:string[]) {
  const end=Date.now()+7000;
  while(Date.now()<end) {
    const rows=await value(`select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'name',application_name,
      'wait',wait_event_type,'blockers',pg_blocking_pids(pid))),'[]'::jsonb) from pg_stat_activity
      where application_name in (select jsonb_array_elements_text(:'names'::jsonb)) and wait_event_type='Lock';`,{names:labels});
    if(rows.length===labels.length) {
      assert.equal(new Set(rows.map((r:any)=>r.pid)).size,labels.length);
      assert.ok(rows.every((r:any)=>r.blockers.length>0));evidence.waits.push(rows);return;
    }
    await delay(20);
  }
  throw new Error('Workers did not demonstrably wait on native locks: '+labels.join(','));
}
async function race(jobs:Array<(label:string)=>Promise<any>>,table='control') {
  const release=await barrier(table);
  const labels=jobs.map((_,i)=>`race-${evidence.waits.length}-${i}`);
  const pending=jobs.map((job,i)=>job(labels[i]).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)})));
  try {await waiting(labels);} finally {await release();}
  return Promise.all(pending);
}
const claimRoom=(who=owner,t=token(90),label='claim-room')=>rpc('bot_population_claim_room',{
  p_room:room,p_owner:who,p_token:t,p_game:'tavla',p_team:false,p_table:1,p_bet:500},label);
const claim=(i:number,who=owner,label='claim')=>rpc('bot_population_claim',{
  p_character:chars[i].id,p_owner:who,p_token:token(i),p_room:null,p_seat:null,p_game:null,p_bet:null},label);
const finish=(winner:number|null,label='finish')=>rpc('bot_population_finish_match',{p_match:'match',p_owner:owner,p_winner:winner},label);
const roster=[{seat:0,kind:'bot',id:chars[0].id,token:token(0)},{seat:1,kind:'human',id:uid}];
const begin=(label='begin')=>rpc('bot_population_begin_match',{
  p_match:'match',p_owner:owner,p_room:room,p_game:'tavla',p_bet:500,p_team:false,p_roster:roster},label);
async function setupMatch() {
  await claimRoom();
  await rpc('bot_population_claim',{p_character:chars[0].id,p_owner:owner,p_token:token(0),p_room:room,p_seat:0,p_game:'tavla',p_bet:500});
  await sql('insert into public.profiles(id,chips) values(:\'uid\',20000);','fixture',{uid});
}
async function balances() {return value(`select jsonb_build_object('human',(select chips from public.profiles where id=:'uid'),
  'bot',(select chips from bot_population.characters where id=:'bot'),
  'house',(select coalesce(sum(house_amount),0) from bot_population.matches),
  'entries',(select count(*) from bot_population.match_wallet_entries where phase='entry'),
  'credits',(select count(*) from bot_population.match_wallet_entries where phase<>'entry'));`,{uid,bot:chars[0].id});}
async function reset() {
  await sql(`truncate bot_population.social_events,bot_population.social_seen,bot_population.progression_outbox,
    bot_population.match_wallet_entries,bot_population.match_seats,bot_population.matches,bot_population.leases,
    bot_population.ledger,bot_population.characters,bot_population.control_events,bot_population.room_hosts,
    bot_population.room_host_events,bot_population.runtime_health,public.profiles,public.presence;
    update bot_population.control set mode='off',max_active=24,revision=0;
    update bot_population.social_control set next_event_at=now(),next_chat_at=now()+interval '8 minutes';`);
  await rpc('bot_population_seed',{p_characters:chars});
  await rpc('bot_population_control',{p_expected_revision:0,p_mode:'running',p_max_active:24,p_actor:'native-test'});
}
async function check(name:string,body:()=>Promise<void>) {
  await reset();
  try {await body();evidence.checks.push({name,passed:true});}
  catch(error) {evidence.checks.push({name,passed:false,error:String(error)});}
}
async function main() {
  root=await mkdtemp(join(tmpdir(),'codex-population-native-'));data=join(root,'data');
  password=randomBytes(24).toString('hex');const pw=join(root,'init-password');
  await writeFile(pw,password+'\n',{mode:0o600});
  evidence.directory=root;
  evidence.version=(await exec(exe('postgres'),['--version'],{windowsHide:true})).stdout.trim();
  await exec(exe('initdb'),['-D',data,'--encoding=UTF8','--locale=C','--username=postgres','--auth-host=scram-sha-256','--auth-local=scram-sha-256','--pwfile='+pw],{windowsHide:true,timeout:60000});
  await unlink(pw);
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));
  port=(listener.address() as any).port;await new Promise<void>((r,j)=>listener.close(e=>e?j(e):r()));evidence.port=port;
  started=true;
  await exec(exe('pg_ctl'),['-D',data,'-l',join(root,'postgres.log'),'-w','-t','30','-o',`-h 127.0.0.1 -p ${port} -c shared_buffers=32MB`,'start'],{windowsHide:true,timeout:40000});
  const actual=await value("select to_json(current_setting('data_directory'));");
  assert.equal(resolve(actual).toLowerCase(),resolve(data).toLowerCase());
  await sql(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    create table public.profiles(id uuid primary key,chips bigint not null);
    create table public.presence(user_id uuid primary key,last_seen timestamptz,status text);
    create table public.lobby_chat_clear_audit(id bigint primary key);
    create function public.record_match_stats(p_user_id text,p_won boolean,p_winnings bigint) returns void language sql as $$select$$;
    create function public.grant_account_xp(p_user_id text,p_source text,p_event_key text,p_base_xp integer,p_game text,p_context jsonb)
      returns jsonb language sql as $$select '{"ok":true}'::jsonb$$;`);
  for(const name of ['01_bot_population_storage','02_bot_population_matches','03_bot_population_room_hosts',
    '04_bot_population_admin','05_bot_population_presence','06_bot_population_progression','07_bot_population_social','08_bot_population_lock_time'])
    await sql(await readFile(resolve(__dirname,`../migrations/20260917_${name}.sql`),'utf8'),'migration');
  await check('two owners cannot publish the same logical room',async()=>{
    const r=await race([label=>claimRoom(owner,token(90),label),label=>claimRoom(other,token(91),label)]);
    assert.equal(r.filter(x=>x.ok).length,1);assert.equal(await value('select to_json(count(*)) from bot_population.room_hosts;'),1);
  });
  await check('simultaneous allocation obeys the global cap',async()=>{
    await rpc('bot_population_control',{p_expected_revision:1,p_mode:'running',p_max_active:1,p_actor:'native-test'});
    const r=await race([label=>claim(0,owner,label),label=>claim(1,other,label)]);
    assert.equal(r.filter(x=>x.ok).length,1);assert.equal(await value('select to_json(count(*)) from bot_population.leases;'),1);
  });
  await check('duplicate entry charges each wallet only once',async()=>{
    await setupMatch();const r=await race([begin,begin]);assert.ok(r.every(x=>x.ok));
    assert.deepEqual(await balances(),{human:19500,bot:chars[0].initial_chips-500,house:0,entries:2,credits:0});
  });
  await check('duplicate payout credits the human winner once',async()=>{
    await setupMatch();await begin();const r=await race([label=>finish(1,label),label=>finish(1,label)]);
    assert.ok(r.every(x=>x.ok));assert.deepEqual(await balances(),{human:20400,bot:chars[0].initial_chips-500,house:100,entries:2,credits:1});
  });
  await check('conflicting payout/refund cannot both settle',async()=>{
    await setupMatch();await begin();const r=await race([label=>finish(1,label),label=>finish(null,label)]);
    assert.equal(r.filter(x=>x.ok).length,1);const b=await balances();
    assert.equal(b.human+b.bot+b.house,20000+chars[0].initial_chips);
    assert.ok(b.human===20000 || b.human===20400);
  });
  await check('concurrent daily refill issues one credit',async()=>{
    await sql("update bot_population.characters set chips=90000 where id=:'bot';",'fixture',{bot:chars[0].id});
    const job=(label:string)=>rpc('bot_population_refill',{p_character:chars[0].id},label);
    const r=await race([job,job]);assert.ok(r.every(x=>x.ok));assert.equal(r.filter(x=>x.value?.refilled).length,1);
    assert.equal(await value("select to_json(count(*)) from bot_population.ledger where reason='daily_refill';"),1);
  });
  await check('social publishers do not duplicate the same arrival',async()=>{
    await claim(0);const job=(label:string)=>rpc('bot_population_process_social',{},label);
    const r=await race([job,job],'social_control');assert.ok(r.every(x=>x.ok));
    assert.equal(r.reduce((n,x)=>n+x.value.emitted,0),1);
  });
  await check('room renewal rejects authority that expires while waiting for a lock',async()=>{
    await claimRoom();await sql("update bot_population.room_hosts set expires_at=clock_timestamp()+interval '1 second';");
    const release=await barrier();const pending=claimRoom(owner,token(90),'expiry-wait').then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));
    try {
      await waiting(['expiry-wait']);
      while(!(await value('select to_json(bool_and(expires_at<clock_timestamp())) from bot_population.room_hosts;')))await delay(40);
    } finally {await release();}
    const result=await pending;assert.equal(result.ok,false,'Expired host was renewed using a pre-lock timestamp');
    assert.match('error' in result?result.error:'',/room_lease_lost/);
  });
  await check('character heartbeat rejects authority that expires while waiting for a lock',async()=>{
    await claim(0);await sql("update bot_population.leases set expires_at=clock_timestamp()+interval '1 second';");
    const release=await barrier();
    const pending=rpc('bot_population_heartbeat',{p_character:chars[0].id,p_owner:owner,p_token:token(0)},'character-expiry')
      .then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));
    try {
      await waiting(['character-expiry']);
      while(!(await value('select to_json(bool_and(expires_at<clock_timestamp())) from bot_population.leases;')))await delay(40);
    } finally {await release();}
    const result=await pending;assert.equal(result.ok,false,'Expired character heartbeat resurrected its lease');
    assert.match('error' in result?result.error:'',/lease_lost/);
  });
  await check('orphan recovery racing settlement conserves human and bot funds',async()=>{
    await setupMatch();await begin();
    await sql("update bot_population.leases set expires_at=now()-interval '1 second';update bot_population.room_hosts set expires_at=now()-interval '1 second';");
    const r=await race([label=>claimRoom(other,token(91),label),label=>finish(1,label)]);
    assert.ok(r[0].ok);const b=await balances();assert.equal(b.human+b.bot+b.house,20000+chars[0].initial_chips);
    assert.ok(b.human===20000 || b.human===20400);assert.equal(b.entries,2);
    assert.equal(await value('select to_json(count(*)) from bot_population.leases;'),0);
  });
}
void main().catch(error=>{evidence.fatal=String(error);}).finally(async()=>{
  if(started && data) {
    try {await exec(exe('pg_ctl'),['-D',data,'-m','immediate','-w','-t','30','stop'],{windowsHide:true,timeout:40000});evidence.stopped=true;}
    catch(error){evidence.stopError=String(error);}
  }
  evidence.passed=evidence.checks.filter((c:any)=>c.passed).length;
  evidence.failed=evidence.checks.filter((c:any)=>!c.passed).length;
  const report=resolve(__dirname,'../../bot-native-concurrency-results.json');
  await writeFile(report,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({report,version:evidence.version,passed:evidence.passed,failed:evidence.failed,fatal:evidence.fatal,stopped:evidence.stopped}));
  process.exitCode=evidence.fatal || evidence.failed || !evidence.stopped?1:0;
});
