import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
// Only deployment infrastructure and external network are substituted.
// Production calendar/store logic and every SQL statement execute unchanged.
const root=fileURLToPath(new URL('../',import.meta.url));
const sql=new DatabaseSync(':memory:');for(const file of readdirSync(path.join(root,'drizzle')).filter(x=>x.endsWith('.sql')).sort())sql.exec(readFileSync(path.join(root,'drizzle',file),'utf8'));
let failScores=false;
const prepare=(text,values=[])=>({bind(...args){return prepare(text,args);},async first(){return sql.prepare(text).get(...values)??null;},async all(){return {results:sql.prepare(text).all(...values)};},async run(){if(failScores&&text.startsWith('INSERT INTO scores')){failScores=false;throw new Error('Synthetic interrupted score write');}const result=sql.prepare(text).run(...values);return {meta:{changes:result.changes},success:true};}});
globalThis.__earningsTestDb={prepare,async batch(statements){sql.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const hook=registerHooks({resolve(specifier,context,next){if(specifier==='@/db')return {url:'data:text/javascript,export function getRawDb(){return globalThis.__earningsTestDb}',shortCircuit:true};if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const url=new URL(specifier,context.parentURL);if(!path.extname(fileURLToPath(url))&&existsSync(fileURLToPath(url)+'.ts'))return {url:pathToFileURL(fileURLToPath(url)+'.ts').href,shortCircuit:true};}return next(specifier,context);},load(url,context,next){if(url.endsWith('/lib/initial-market.json'))return {format:'module',source:'export default '+readFileSync(fileURLToPath(url),'utf8'),shortCircuit:true};return next(url,context);}});
const {ensureInitial}=await import('../lib/store.ts');const {refreshSymbolEarnings,editEarnings,readEarnings}=await import('../lib/earnings.ts');const {nyDate}=await import('../lib/earnings-provider.ts');await ensureInitial();
const originalFetch=globalThis.fetch;
const day=nyDate();const future=n=>new Date(Date.parse(day+'T00:00Z')+n*86400000).toISOString().slice(0,10);
const human=day=>new Date(day+'T00:00Z').toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
const yahoo=(date,end)=>`<title>Tesla (TSLA) Stock Price</title><p>Earnings Date ${human(date)}${end?' - '+human(end):''} Forward Dividend --</p>`;
let fetchCount=0;
const network=(date,end)=>async url=>{fetchCount++;return String(url).includes('ir.tesla.com')?new Response('',{status:403}):new Response(yahoo(date,end));};
const row=()=>sql.prepare("SELECT * FROM earnings_calendar WHERE symbol='TSLA'").get();const eventCount=()=>sql.prepare("SELECT COUNT(*) AS n FROM earnings_events WHERE symbol='TSLA'").get().n;
after(()=>{globalThis.fetch=originalFetch;hook.deregister();delete globalThis.__earningsTestDb;sql.close();});
test('自动精确日期写入日历和决策历史，24小时缓存重复不抓取、不追加',async()=>{globalThis.fetch=network(future(14));const result=await refreshSymbolEarnings('TSLA',{},true);assert.equal(result.status,'updated');assert.equal(row().date,future(14));assert.equal(row().status,'estimated');assert.equal(row().needs_recompute,0);const last=sql.prepare("SELECT * FROM earnings_events WHERE symbol='TSLA' ORDER BY id DESC LIMIT 1").get();assert.equal(last.date,future(14));assert.equal(last.confidence,'estimated');const n=eventCount(),calls=fetchCount;assert.equal((await refreshSymbolEarnings('TSLA')).status,'cached');assert.equal(eventCount(),n);assert.equal(fetchCount,calls);});
test('预计区间写入日历，但不挑第一天进入计算决策',async()=>{globalThis.fetch=network(future(20),future(25));await refreshSymbolEarnings('TSLA',{},true);assert.equal(row().end_date,future(25));assert.equal(sql.prepare("SELECT date FROM earnings_events WHERE symbol='TSLA' ORDER BY id DESC LIMIT 1").get().date,null);});
test('失败保留未来日期并设置15分钟缓存，成功空响应清除过时决定',async()=>{const saved=row().date,n=eventCount();globalThis.fetch=async()=>new Response('',{status:429});assert.equal((await refreshSymbolEarnings('TSLA',{},true)).status,'retained');assert.equal(row().date,saved);assert.equal(eventCount(),n);assert.match(row().error,/HTTP 429/);assert.ok(row().next_check>Date.now());globalThis.fetch=async url=>String(url).includes('ir.tesla.com')?new Response('<p>No announced earnings</p>'):new Response('<title>Tesla (TSLA) Stock</title>Earnings Date -- Forward Dividend --');assert.equal((await refreshSymbolEarnings('TSLA',{},true)).status,'unavailable');assert.equal(row().date,null);});
test('自动抓取尚未结束时人工纠错胜出，不追加过期自动决策',async()=>{await editEarnings('TSLA',null,'auto');const entered=Promise.withResolvers(),resume=Promise.withResolvers();globalThis.fetch=async url=>{if(String(url).includes('ir.tesla.com'))return new Response('',{status:403});entered.resolve();await resume.promise;return new Response(yahoo(future(35)));};const pending=refreshSymbolEarnings('TSLA',{},true);await entered.promise;await editEarnings('TSLA',future(31),'manual');const n=eventCount();resume.resolve();assert.equal((await pending).status,'superseded');assert.equal(row().date,future(31));assert.equal(row().mode,'manual');assert.equal(eventCount(),n);assert.equal((await refreshSymbolEarnings('TSLA',{},true)).status,'manual');});
test('自动恢复后优先采纳官方确认，第三方预计不能降级或改写',async()=>{await editEarnings('TSLA',null,'auto');globalThis.fetch=async()=>new Response(`<script type="application/ld+json">{"@type":"Event","name":"Quarterly earnings call","startDate":"${future(40)}"}</script>`);await refreshSymbolEarnings('TSLA',{},true);assert.equal(row().status,'confirmed');globalThis.fetch=network(future(41));await refreshSymbolEarnings('TSLA',{},true);assert.equal(row().date,future(40));assert.equal(row().status,'confirmed');assert.match(row().error,/未替代/);});
test('重算中断后缓存命中仍会修复，不产生重复财报决策',async()=>{await editEarnings('TSLA',null,'auto');globalThis.fetch=network(future(45));failScores=true;await assert.rejects(refreshSymbolEarnings('TSLA',{},true),/interrupted/);assert.equal(row().needs_recompute,1);assert.equal((await readEarnings('TSLA')).calculationPending,true);const n=eventCount();assert.equal((await refreshSymbolEarnings('TSLA')).status,'cached');assert.equal(row().needs_recompute,0);assert.equal(eventCount(),n);});


test('一个请求的初始化等待未完成时，新的行情读取不能复用该请求的Promise',async()=>{
 const originalDb=globalThis.__earningsTestDb,entered=Promise.withResolvers(),resume=Promise.withResolvers();let hold=true;
 globalThis.__earningsTestDb={...originalDb,prepare(text){const statement=originalDb.prepare(text);return {...statement,bind(...args){const bound=statement.bind(...args);if(text==='SELECT * FROM instruments WHERE symbol=?')return {...bound,async first(){if(hold){hold=false;entered.resolve();await resume.promise;}return bound.first();}};return bound;}};}};
 const first=ensureInitial();await entered.promise;let finished=false;const second=ensureInitial().then(()=>{finished=true;});
 try{await Promise.race([second,new Promise(resolve=>setTimeout(resolve,200))]);assert.equal(finished,true,'后续请求被先前请求的初始化Promise阻塞');}
 finally{resume.resolve();await Promise.all([first,second]);globalThis.__earningsTestDb=originalDb;}
});


const {clientApi}=await import('../lib/client-api.ts');
test('行情读取超时明确报错，不会无限等待',async()=>{await assert.rejects(clientApi('/api/desk','GET',undefined,async(url,options)=>new Promise((resolve,reject)=>{const keep=setTimeout(resolve,1000);options.signal.addEventListener('abort',()=>{clearTimeout(keep);reject(options.signal.reason);},{once:true});}),10),/请求超时/);});
test('客户端校验登录、异常响应与正常数据',async()=>{assert.deepEqual(await clientApi('/api/desk','GET',undefined,async()=>Response.json({data:[{symbol:'TSLA'}]})),[{symbol:'TSLA'}]);await assert.rejects(clientApi('/api/desk','GET',undefined,async()=>new Response('<html>Login</html>',{status:401})),/登录/);await assert.rejects(clientApi('/api/desk','GET',undefined,async()=>new Response('<html>Error</html>')),/服务响应异常/);});
