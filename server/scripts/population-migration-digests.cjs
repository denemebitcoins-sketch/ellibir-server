const {PGlite} = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
(async()=>{
  const db=await PGlite.create();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql as $$select null::text$$;
    create table public.profiles(id uuid primary key,chips bigint);`);
  const root=path.resolve(__dirname,'../migrations');
  for(const f of fs.readdirSync(root).filter(f=>/^20260917_0[1-6]_/.test(f)).sort()) await db.exec(fs.readFileSync(path.join(root,f),'utf8'));
  const result=await db.query(`select n.nspname||'.'||p.proname name,
    md5(regexp_replace(regexp_replace(prosrc,'--[^\\n]*','','g'),'[[:space:]]','','g')) hash
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='bot_population' or p.proname like 'bot_population_%' order by 1`);
  console.log(JSON.stringify(result.rows));
  await db.close();
})().catch(e=>{console.error(e.message);process.exitCode=1;});
