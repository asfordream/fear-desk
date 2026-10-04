import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const sql=new DatabaseSync(':memory:');
for(const f of readdirSync(path.join(root,'drizzle')).filter(x=>x.endsWith('.sql')).sort())sql.exec(readFileSync(path.join(root,'drizzle',f),'utf8'));
const prepare=(text,values=[])=>({bind(...args){return prepare(text,args);},async first(){return sql.prepare(text).get(...values)??null;},async all(){return {results:sql.prepare(text).all(...values)};},async run(){const r=sql.prepare(text).run(...values);return {meta:{changes:r.changes}};}});
globalThis.__dailyDb={prepare,batch:async statements=>Promise.all(statements.map(s=>s.run()))};let syncs=0,sends=0;
globalThis.__dailySync=async()=>{syncs++;return [{status:'success'}];};
const hook=registerHooks({resolve(specifier,context,next){
 if(specifier==='@/db')return {url:'data:text/javascript,export function getRawDb(){return globalThis.__dailyDb}',shortCircuit:true};
 if(context.parentURL?.endsWith('/lib/daily.ts')&&specifier==='./store')return {url:'data:text/javascript,export async function ensureInitial(){};export async function syncAll(){return globalThis.__dailySync()}',shortCircuit:true};
 if(context.parentURL?.endsWith('/lib/daily.ts')&&specifier==='./earnings')return {url:'data:text/javascript,export async function refreshEarnings(){return []}',shortCircuit:true};
 if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const url=new URL(specifier,context.parentURL);if(!path.extname(fileURLToPath(url))&&existsSync(fileURLToPath(url)+'.ts'))return {url:pathToFileURL(fileURLToPath(url)+'.ts').href,shortCircuit:true};}return next(specifier,context);
}});
const {runDaily,generateReport,readReport,recoverLastIncomplete,refreshDailyInputs}=await import('../lib/daily.ts');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).hostname,'open.feishu.cn');assert.equal(options.redirect,'manual');sends++;return Response.json({code:0});};
const config={FEISHU_SEND_ENABLED:'true',FEISHU_WEBHOOK_URL:'https://open.feishu.cn/open-apis/bot/v2/hook/test-only',SITE_BASE_URL:'https://desk.example.com'};
const seed=(date)=>{sql.exec("DELETE FROM reports; DELETE FROM deliveries; DELETE FROM job_runs; DELETE FROM workflow_locks; DELETE FROM bars; DELETE FROM scores; DELETE FROM instruments;");syncs=0;sends=0;
 sql.prepare("INSERT INTO instruments(symbol,name,active,status) VALUES ('AAA','Test',1,'ready')").run();
 for(const day of ['2026-09-28',date])sql.prepare('INSERT INTO bars(symbol,date,open,high,low,close,volume,raw_close,factor) VALUES (?,?,?,?,?,?,?,?,?)').run('SPY',day,100,100,100,100,100,100,1);
 for(const day of ['2026-09-28',date])sql.prepare('INSERT INTO scores(symbol,date,score,payload,version) VALUES (?,?,?,?,?)').run('AAA',day,60,JSON.stringify({date:day,score:60,total:60,base:60,groups:[60,60,60,60],price:100,form:'中性',assessment:'未进入评估',version:'v1'}),'v1');
};
after(()=>{globalThis.fetch=originalFetch;hook.deregister();delete globalThis.__dailyDb;delete globalThis.__dailySync;sql.close();});
// Exercise the real store with deterministic providers; keep the daily runner's
// existing mocked store separate so these tests measure persistence/concurrency.
const budgetHook=registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/lib/store.ts')){
  const modules={'./engine':'export const VERSION="v1";export function calculate(rows){return rows.map(b=>({date:b.date,score:61,total:61,base:61,groups:[61,61,61,61],price:b.rawClose,form:"中性",assessment:"未进入评估",version:"v1"}))}',
   './provider':'export function fetchMarket(symbol,start){return globalThis.__budgetFetch(symbol,start)};export function parseMarket(){throw new Error("unexpected initializer")}',
   './initial-market.json':'export default {}'};
  if(modules[specifier])return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
 }return next(specifier,context);
}});
const realStore=await import('../lib/store.ts');
after(()=>{budgetHook.deregister();delete globalThis.__budgetFetch;});

test('未到14点及北京时间周一不访问行情和机器人',async()=>{seed('2026-09-29');assert.equal((await runDaily(config,new Date('2026-09-30T05:59Z'))).status,'skipped');assert.equal((await runDaily(config,new Date('2026-10-05T06:00Z'))).status,'skipped');assert.equal(syncs,0);assert.equal(sends,0);});
test('SPY未达到目标日期时跳过，不把旧数据当作新交易日',async()=>{seed('2026-09-29');const r=await runDaily(config,new Date('2026-10-01T06:00Z'));assert.equal(r.status,'skipped');assert.equal(sends,0);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reports').get().n,0);});
test('14点发送冻结日报，14点10分重试复用且不重复发',async()=>{seed('2026-09-29');assert.equal((await runDaily(config,new Date('2026-09-30T06:00Z'))).status,'ready');assert.equal(sends,1);assert.equal(sql.prepare('SELECT status FROM deliveries').get().status,'sent');assert.equal((await runDaily(config,new Date('2026-09-30T06:10Z'))).status,'ready');assert.equal(sends,1);assert.equal(syncs,1);});
test('缺股票当天评分时只保存不完整预览，不自动发送',async()=>{seed('2026-09-29');sql.prepare("DELETE FROM scores WHERE date='2026-09-29'").run();assert.equal((await runDaily(config,new Date('2026-09-30T06:00Z'))).status,'partial');assert.equal(sends,0);assert.equal(sql.prepare('SELECT complete FROM reports').get().complete,0);});

test('卡片格式升级生成新快照，保留已发送旧卡片且重复生成复用新快照',async()=>{
 seed('2026-09-29');const current=await generateReport(config);
 const {id,generatedAt,...facts}=current.snapshot;
 const legacyId=createHash('sha256').update(JSON.stringify({facts,base:config.SITE_BASE_URL})).digest('hex');
 const legacyCard={schema:'2.0',body:{elements:[{tag:'collapsible_panel',expanded:false}]}};
 sql.prepare('DELETE FROM reports WHERE id=?').run(id);
 sql.prepare('INSERT INTO reports(id,trade_date,created_at,payload,card,complete) VALUES (?,?,?,?,?,1)').run(legacyId,facts.tradeDate,generatedAt,JSON.stringify({...current.snapshot,id:legacyId}),JSON.stringify(legacyCard));
 const next=await generateReport(config);assert.notEqual(next.snapshot.id,legacyId);assert.equal(next.snapshot.id,id);
 assert.doesNotMatch(JSON.stringify(next.card),/collapsible_panel/);assert.deepEqual((await readReport(legacyId)).card,legacyCard);
 assert.equal((await generateReport(config)).snapshot.id,id);
});

const seedMarket=(symbols=['AAA'])=>{seed('2026-09-29');sql.exec('DELETE FROM bars; DELETE FROM scores; DELETE FROM instruments;');const old=[];
 for(let i=1;i<=8;i++)old.push({date:'2026-09-'+String(i).padStart(2,'0'),open:100,high:101,low:99,close:100,volume:100,rawClose:100,factor:1});
 for(const symbol of ['SPY',...symbols]){sql.prepare('INSERT INTO instruments(symbol,name,active,status,origin) VALUES (?,?,?, ?,?)').run(symbol,symbol,symbol==='SPY'?0:1,'ready',old[0].date);
  for(const b of old){sql.prepare('INSERT INTO bars(symbol,date,open,high,low,close,volume,raw_close,factor) VALUES (?,?,?,?,?,?,?,?,?)').run(symbol,b.date,b.open,b.high,b.low,b.close,b.volume,b.rawClose,b.factor);if(symbol!=='SPY')sql.prepare('INSERT INTO scores(symbol,date,score,payload,version) VALUES (?,?,?,?,?)').run(symbol,b.date,60,JSON.stringify({date:b.date,score:60,version:'v1',marker:'original'}),'v1');}
 }return old;};
test('普通增量更新仅写重叠与新评分，历史修订仍完整重算',async()=>{const old=seedMarket();let revise=false;globalThis.__budgetFetch=async(symbol,start)=>({symbol,name:symbol,fetchedAt:new Date().toISOString(),bars:[...old.filter(b=>!start||b.date>=start).map(b=>revise?{...b,close:101,rawClose:101}:b),{...old[0],date:'2026-09-09'}]});
 assert.equal((await realStore.syncOne('AAA')).status,'success');assert.equal(JSON.parse(sql.prepare('SELECT payload FROM scores WHERE symbol=? AND date=?').get('AAA',old[0].date).payload).marker,'original');assert.equal(sql.prepare('SELECT score FROM scores WHERE symbol=? AND date=?').get('AAA','2026-09-09').score,61);
 revise=true;assert.equal((await realStore.syncOne('AAA')).status,'success');assert.equal(sql.prepare('SELECT score FROM scores WHERE symbol=? AND date=?').get('AAA',old[0].date).score,61);});
test('SPY先完成，股票更新并发数限制为4且结果不丢失',async()=>{const symbols=['AAA','BBB','CCC','DDD','EEE','FFF'],old=seedMarket(symbols);let active=0,peak=0,spyDone=false;globalThis.__budgetFetch=async(symbol)=>{if(symbol!=='SPY')assert.equal(spyDone,true);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;if(symbol==='SPY')spyDone=true;return {symbol,name:symbol,fetchedAt:new Date().toISOString(),bars:old};};const results=await realStore.syncAll();assert.equal(results.length,7);assert.equal(results[0].symbol,'SPY');assert.ok(results.every(x=>x.status==='success'));assert.ok(peak>1);assert.ok(peak<=4);});
test('接管已过期任务后旧运行记录标为中断，而非永久运行中',async()=>{seed('2026-09-29');sql.prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES ('dead','2026-09-29T06:00Z','2026-09-28','running')").run();assert.equal((await runDaily(config,new Date('2026-09-30T06:00Z'))).status,'ready');assert.equal(sql.prepare("SELECT status FROM job_runs WHERE id='dead'").get().status,'interrupted');});

test('补发已中断的历史日报使用精确截面，不提前发送今天且不重复',async()=>{seed('2026-09-29');
 sql.prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES ('old','2026-09-30T06:00Z','2026-09-29','running')").run();
 sql.prepare('INSERT INTO bars(symbol,date,open,high,low,close,volume,raw_close,factor) VALUES (?,?,?,?,?,?,?,?,?)').run('SPY','2026-09-30',100,100,100,100,100,100,1);
 const result=await recoverLastIncomplete(config,new Date('2026-10-01T05:00Z'));assert.equal(result.status,'ready');assert.match(result.message,/2026-09-29/);assert.equal(sends,1);assert.equal(syncs,0);const saved=JSON.parse(sql.prepare('SELECT payload FROM reports').get().payload);assert.equal(saved.tradeDate,'2026-09-29');assert.equal(saved.previousDate,'2026-09-28');
 assert.equal((await recoverLastIncomplete(config,new Date('2026-10-01T05:01Z'))).status,'skipped');assert.equal(sends,1);});
test('历史缺数据和不确定发送结果不盲目补发',async()=>{seed('2026-09-29');sql.prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES ('old','2026-09-30T06:00Z','2026-09-29','running')").run();sql.prepare("DELETE FROM scores WHERE date='2026-09-29'").run();assert.equal((await recoverLastIncomplete(config,new Date('2026-10-01T05:00Z'))).status,'partial');assert.equal(sends,0);});

test('云端刷新完整检查行情和财报，但不提前发送或伪造完成日报',async()=>{seed('2026-09-29');const r=await refreshDailyInputs(config);assert.equal(r.status,'updated');assert.equal(syncs,1);assert.equal(sends,0);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reports').get().n,0);assert.equal(sql.prepare('SELECT status FROM job_runs').get().status,'updated');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM workflow_locks').get().n,0);});
test('发送结果不确定的历史任务不重新提交',async()=>{seed('2026-09-29');sql.prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES ('old','2026-09-30T06:00Z','2026-09-29','error')").run();const saved=await generateReport(config,'2026-09-29');sql.prepare("INSERT INTO deliveries(report_id,status,attempts,updated_at,message) VALUES (?,'unknown',1,?,'响应不明')").run(saved.snapshot.id,new Date().toISOString());assert.equal((await recoverLastIncomplete(config,new Date('2026-10-01T05:00Z'))).status,'skipped');assert.equal(sends,0);});

test('SPY历史行情发生修订时，所有股票的历史评分也完整重算',async()=>{const old=seedMarket();globalThis.__budgetFetch=async symbol=>({symbol,name:symbol,fetchedAt:new Date().toISOString(),bars:old.map(b=>symbol==='SPY'?{...b,close:101,rawClose:101}:b)});const r=await realStore.syncAll();assert.equal(r[0].revised,true);assert.equal(sql.prepare('SELECT score FROM scores WHERE symbol=? AND date=?').get('AAA',old[0].date).score,61);});
