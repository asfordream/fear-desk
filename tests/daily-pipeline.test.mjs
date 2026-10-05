import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {readFileSync, readdirSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runWithExecutionContext, getRequestExecutionContext} from 'vinext/shims/request-context';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=mkdtempSync(path.join(tmpdir(),'feardesk-a1-'));
const filename=path.join(directory,'persisted.sqlite');
let sql=new DatabaseSync(filename);
sql.exec('PRAGMA foreign_keys=ON');
const files=readdirSync(path.join(root,'drizzle')).filter(f=>f.endsWith('.sql')).sort();
for(const file of files.filter(f=>f.slice(0,4)<'0005'))sql.exec(readFileSync(path.join(root,'drizzle',file),'utf8'));
sql.exec("INSERT INTO job_runs(id,started_at,status) VALUES ('legacy-job','2026-09-30','running'); INSERT INTO instruments(symbol,name,active,status) VALUES ('AAA','Test',1,'ready')");
for(const file of files.filter(f=>f.slice(0,4)>='0005'))sql.exec(readFileSync(path.join(root,'drizzle',file),'utf8'));
const prepare=(text,values=[])=>({
  bind(...args){return prepare(text,args);},
  async first(){return sql.prepare(text).get(...values)??null;},
  async all(){return {results:sql.prepare(text).all(...values)};},
  _run(){if(/^SELECT/i.test(text.trim()))return {results:sql.prepare(text).all(...values)};const result=sql.prepare(text).run(...values);return {meta:{changes:Number(result.changes)}};},
  async run(){return this._run();},
});
const database={prepare,async batch(statements){sql.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s._run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
globalThis.__pipelineDb=database;
let allowed=true;
globalThis.__pipelineAccess=async req=>{if(!allowed)throw new Error('AUTH_REQUIRED');if(req.method!=='GET'&&req.headers.get('origin')&&req.headers.get('origin')!==new URL(req.url).origin)throw new Error('拒绝跨站写入');};
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='@/db')return {url:'data:text/javascript,export function getRawDb(){return globalThis.__pipelineDb}',shortCircuit:true};
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env={}',shortCircuit:true};
  if(specifier==='@/lib/http')return {url:'data:text/javascript,export const access=globalThis.__pipelineAccess;export const success=data=>Response.json({data});export const failure=error=>Response.json({error:error.message},{status:error.message==="AUTH_REQUIRED"?401:400})',shortCircuit:true};
  if(specifier==='@/lib/daily')return {url:'data:text/javascript,export async function reportStatus(){return {reports:[],jobs:[],config:{}}}',shortCircuit:true};
  if(specifier.startsWith('@/lib/'))return {url:pathToFileURL(path.join(root,specifier.slice(2)+'.ts')).href,shortCircuit:true};
  if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const url=new URL(specifier,context.parentURL);if(!path.extname(fileURLToPath(url))&&existsSync(fileURLToPath(url)+'.ts'))return {url:pathToFileURL(fileURLToPath(url)+'.ts').href,shortCircuit:true};}
  return next(specifier,context);
},load(url,context,next){if(url.endsWith('/lib/initial-market.json'))return {format:'module',source:'export default '+readFileSync(fileURLToPath(url),'utf8'),shortCircuit:true};return next(url,context);}});
const {DailyRepository}=await import('../lib/daily-repository.ts');
const {admitManual,runFirstSlice,scheduleFirstSlice,runSlice,drainJob,resumeExisting,admitScheduled,originalScheduledDelivery}=await import('../lib/daily-pipeline.ts');
const {latestClosedTradingDay,scheduledReportWindow}=await import('../lib/trading-calendar.ts');
const {GET,POST}=await import('../app/api/reports/route.ts');
const repo=new DailyRepository(database);
const now=new Date('2026-10-03T03:00:00Z');
const id=n=>'request-00000000-'+n;
after(()=>{hooks.deregister();sql.close();rmSync(directory,{recursive:true,force:true});delete globalThis.__pipelineDb;delete globalThis.__pipelineAccess;});

test('增量迁移保留旧running历史，旧任务不参与新扫描',async()=>{
  assert.equal(sql.prepare("SELECT pipeline_version,status FROM job_runs WHERE id='legacy-job'").get().pipeline_version,1);
  assert.deepEqual(await repo.existing(),[]);
});
test('手动受理不受14点窗口影响；并发兼容请求仅创建一项任务并保留映射',async()=>{
  const results=await Promise.all(Array.from({length:12},(_,n)=>admitManual(id(n),repo,now)));
  assert.equal(new Set(results.map(r=>r.job.id)).size,1);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_requests').get().n,12);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM job_runs WHERE pipeline_version=2').get().n,1);
  assert.equal(results[0].job.requestedClosedDay,'2026-10-02');
  assert.ok(results.every(r=>r.sendIntent==='none'));
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
});
test('持久受理后关闭并重新打开磁盘数据库，任务仍可扫描；终态同编号返回原结果',async()=>{
  const first=await admitManual(id(0),repo,now);
  sql.close();sql=new DatabaseSync(filename);sql.exec('PRAGMA foreign_keys=ON');
  assert.equal((await repo.existing())[0].id,first.job.id);
  sql.prepare("UPDATE job_runs SET status='ready',report_id='test-only-report',active_key=NULL WHERE id=?").run(first.job.id);
  const retry=await admitManual(id(0),repo,new Date('2030-01-01'));
  assert.equal(retry.job.id,first.job.id);assert.equal(retry.job.status,'ready');assert.equal(retry.job.reportId,'test-only-report');
});
test('真实请求级ExecutionContext登记首片，丢失浏览器上下文仍完成池检查点；无ctx不启动裸Promise',async()=>{
  const admitted=await admitManual(id(20),repo,now);const pending=[];
  const context={waitUntil:promise=>pending.push(promise)};
  const registered=runWithExecutionContext(context,()=>{assert.equal(getRequestExecutionContext(),context);return scheduleFirstSlice(admitted.job.id,()=>runFirstSlice(admitted.job.id,repo));});
  assert.equal(registered,true);assert.equal(pending.length,1);
  assert.equal(getRequestExecutionContext(),null);
  await Promise.all(pending);
  const job=await repo.job(admitted.job.id);assert.equal(job.stage,'resolveSPY');assert.equal(job.checkpoint,1);assert.equal(job.failed_attempts,0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_inputs WHERE job_id=?').get(job.id).n,1);
  assert.equal((await runFirstSlice(job.id,repo)).advanced,false);
  let starts=0;assert.equal(scheduleFirstSlice(job.id,async()=>{starts++;},null),false);await Promise.resolve();assert.equal(starts,0);
});
test('GET与失效租约状态推导零写，响应不暴露token/输入正文',async()=>{
  const job=(await repo.existing())[0];sql.prepare("UPDATE job_runs SET status='running',active_token='private-test-token',lease_until=1 WHERE id=?").run(job.id);
  const before=sql.prepare('SELECT total_changes() n').get().n;
  const response=await GET(new Request('https://desk.example/api/reports'));
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.data.pipeline.jobs.find(j=>j.id===job.id).status,'interrupted');
  assert.doesNotMatch(JSON.stringify(body),/private-test-token|active_token|scope_hash|payload/);
  assert.equal(sql.prepare('SELECT total_changes() n').get().n,before);
  assert.equal((await repo.job(job.id)).status,'running');
});
test('手动路由严格白名单，身份和同源保护，202只持久受理不发送',async()=>{
  const request=(body,origin)=>new Request('https://desk.example/api/reports',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
  const before=sql.prepare('SELECT COUNT(*) n FROM daily_requests').get().n;
  for(const body of [{},{action:'run'},{action:'generate',requestId:id(50),source:'schedule'},{action:'generate',requestId:'bad'}])assert.equal((await POST(request(body))).status,400);
  assert.equal((await POST(request({action:'generate',requestId:id(50)},'https://evil.example'))).status,400);
  allowed=false;assert.equal((await POST(request({action:'generate',requestId:id(50)}))).status,401);allowed=true;
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_requests').get().n,before);
  const response=await POST(request({action:'generate',requestId:id(50)}));assert.equal(response.status,202);
  assert.equal((await response.json()).data.sendIntent,'none');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
});
test('已失效旧owner不能保存候选或推进检查点；CHECK断言失败回滚整个batch',async()=>{
  const admitted=await admitManual(id(60),repo,new Date('2026-10-06T03:00Z'));
  const claim=await repo.claim(admitted.job.id,'freezePool');
  sql.prepare('UPDATE job_runs SET lease_until=1 WHERE id=?').run(admitted.job.id);
  await assert.rejects(repo.checkpoint(claim.fence,'resolveSPY','{}','hash',1),/CHECK constraint/);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_inputs WHERE job_id=?').get(admitted.job.id).n,0);
  assert.equal((await repo.job(admitted.job.id)).checkpoint,0);
  sql.prepare("UPDATE job_runs SET active_token='new-owner',lease_epoch=lease_epoch+1 WHERE id=?").run(admitted.job.id);
  assert.equal(await repo.checkpoint(claim.fence,'resolveSPY','{}','hash',1),false);
});
test('NYSE闭市日历处理夏令时、节假日、提前收盘和范围外年份',()=>{
  assert.equal(latestClosedTradingDay(new Date('2026-10-02T19:59Z')).date,'2026-10-01');
  assert.equal(latestClosedTradingDay(new Date('2026-10-02T20:00Z')).date,'2026-10-02');
  assert.equal(latestClosedTradingDay(new Date('2026-11-27T17:59Z')).date,'2026-11-25');
  assert.equal(latestClosedTradingDay(new Date('2026-11-27T18:00Z')).date,'2026-11-27');
  assert.equal(latestClosedTradingDay(new Date('2028-01-03T21:00Z')).date,'2028-01-03');
  assert.throws(()=>latestClosedTradingDay(new Date('2029-01-03T22:00Z')),/calendar_unavailable/);
});
test('受理后观察池变化不冻结混合池，任务及attempt一致失败并允许新请求',async()=>{
  const admitted=await admitManual(id(70),repo,new Date('2026-10-07T03:00Z'));
  sql.prepare("UPDATE instruments SET name='Changed' WHERE symbol='AAA'").run();
  assert.equal((await runFirstSlice(admitted.job.id,repo)).advanced,false);
  const job=await repo.job(admitted.job.id);assert.equal(job.status,'failed');assert.equal(job.active_token,null);
  assert.equal(sql.prepare('SELECT status FROM daily_attempts WHERE id=?').get(job.attempt_id).status,'failed');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_inputs WHERE job_id=?').get(job.id).n,0);
  const next=await admitManual(id(71),repo,new Date('2026-10-07T03:00Z'));assert.notEqual(next.job.id,job.id);
});

const target='2026-10-02';
function reset(symbols=['AAA']){
 sql.exec('DELETE FROM scheduled_deliveries;DELETE FROM daily_commits;DELETE FROM report_current;DELETE FROM daily_requests;DELETE FROM daily_inputs;DELETE FROM daily_attempts;DELETE FROM daily_events;DELETE FROM job_runs;DELETE FROM reports;DELETE FROM deliveries;DELETE FROM bars;DELETE FROM scores;DELETE FROM earnings_events;DELETE FROM earnings_calendar;DELETE FROM instruments;DELETE FROM daily_resources;');
 for(const symbol of ['SPY',...symbols])sql.prepare("INSERT INTO instruments(symbol,name,active,status) VALUES (?,?,?,'ready')").run(symbol,symbol,symbol==='SPY'?0:1);
}
function barsAt(date=target,count=510){const days=[];let time=Date.parse(date+'T00:00Z');while(days.length<count){const d=new Date(time);if(d.getUTCDay()>0&&d.getUTCDay()<6)days.unshift(d.toISOString().slice(0,10));time-=86400000;}return days.map((date,i)=>({date,open:100+i/10,high:102+i/10,low:98+i/10,close:100+i/10+Math.sin(i),volume:10000+i*20,rawClose:100+i/10+Math.sin(i),factor:1}));}

const fakeSource={market:async symbol=>{return {symbol,name:symbol,bars:barsAt(),fetchedAt:new Date().toISOString()};},earnings:async()=>({candidate:null,error:null})};
const fullConfig={SITE_BASE_URL:'https://desk.example.com',FEISHU_SEND_ENABLED:'true',FEISHU_WEBHOOK_URL:'https://open.feishu.cn/open-apis/bot/v2/hook/test-only'};
async function finish(jobId,source=fakeSource){for(let i=0;i<300;i++){const job=await repo.job(jobId);if(['ready','reused','partial','failed'].includes(job.status))return job;const result=await runSlice(jobId,repo,fullConfig,source);if(!result.advanced)throw new Error('unexpected stop '+JSON.stringify(await repo.job(jobId)));}throw new Error('did not finish');}

test('周一及休市按最新已收盘日受理；北京时间周日及14点前业务零写',async()=>{
 reset();const before=sql.prepare('SELECT total_changes() n').get().n;
 for(const stamp of ['2026-10-04T06:00Z','2026-10-05T05:59Z'])assert.equal((await admitScheduled(fullConfig,repo,new Date(stamp))).status,'skipped');
 assert.equal(sql.prepare('SELECT total_changes() n').get().n,before);
 assert.deepEqual(scheduledReportWindow(new Date('2026-10-05T06:00Z')),{date:'2026-10-05',ready:true});
 const monday=await admitScheduled(fullConfig,repo,new Date('2026-10-05T06:00Z'));
 assert.equal(monday.job.requestedClosedDay,'2026-10-02');assert.equal(monday.requestId,'scheduled-2026-10-05');
 const retry=await admitScheduled(fullConfig,repo,new Date('2026-10-05T06:10Z'));assert.equal(retry.job.id,monday.job.id);
 assert.equal(sql.prepare('SELECT schedule_occurrence FROM daily_requests WHERE request_id=?').get(monday.requestId).schedule_occurrence,'2026-10-05');
 const holiday=await admitScheduled(fullConfig,repo,new Date('2026-11-27T06:00Z'));
 assert.equal(holiday.job.requestedClosedDay,'2026-11-25');assert.equal(holiday.requestId,'scheduled-2026-11-27');
});
test('周六与周一同报告各推一次；同排程日并发、重试与unknown不重复提交',async()=>{
 for(const response of ['sent','unknown']){
  reset();const saturday=await admitScheduled(fullConfig,repo,new Date('2026-10-03T06:00Z'));const first=await finish(saturday.job.id);
  const generatedAt=sql.prepare('SELECT created_at FROM reports WHERE id=?').get(first.report_id).created_at;
  const originalFetch=globalThis.fetch;let sends=0;
  globalThis.fetch=async url=>{assert.equal(new URL(url).hostname,'open.feishu.cn');sends++;if(response==='unknown')throw new Error('mock network failure');return Response.json({code:0});};
  try{
   const deliveries=await Promise.all(Array.from({length:8},()=>originalScheduledDelivery(saturday.requestId,fullConfig,repo,new Date('2026-10-03T06:00Z'))));
   assert.ok(deliveries.some(r=>r.status===response));assert.equal(sends,1);
   const monday=await admitScheduled(fullConfig,repo,new Date('2026-10-05T06:00Z'));assert.notEqual(monday.requestId,saturday.requestId);
   const reused=await finish(monday.job.id);assert.equal(reused.status,'reused');assert.equal(reused.report_id,first.report_id);
   assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,1);
   assert.equal(sql.prepare('SELECT created_at FROM reports').get().created_at,generatedAt);
   assert.equal((await originalScheduledDelivery(monday.requestId,fullConfig,repo,new Date('2026-10-05T06:00Z'))).status,response);
   assert.equal(sends,2);assert.equal(sql.prepare('SELECT COUNT(*) n FROM scheduled_deliveries').get().n,2);
   assert.ok(sql.prepare('SELECT attempts FROM scheduled_deliveries').all().every(r=>r.attempts===1));
   assert.equal((await originalScheduledDelivery(monday.requestId,fullConfig,repo,new Date('2026-10-05T06:10Z'))).status,response);
   assert.equal((await originalScheduledDelivery(saturday.requestId,fullConfig,repo,new Date('2026-10-05T06:10Z'))).status,'not_requested');
   assert.equal((await originalScheduledDelivery(monday.requestId,fullConfig,repo,new Date('2026-10-11T06:00Z'))).status,'not_requested');
   await resumeExisting(repo,fullConfig,fakeSource);assert.equal(sends,2);
   assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
  }finally{globalThis.fetch=originalFetch;}
 }
});
test('同排程日修订出不同报告仍只发送一次；新增迁移保留旧报告和投递记录',async()=>{
 reset();const stamp=new Date('2026-10-05T06:00Z'),first=await admitScheduled(fullConfig,repo,stamp);await finish(first.job.id);
 const originalFetch=globalThis.fetch;let sends=0;globalThis.fetch=async()=>{sends++;return Response.json({code:0});};
 try{
  await originalScheduledDelivery(first.requestId,fullConfig,repo,stamp);
  const next=await admitScheduled(fullConfig,repo,stamp,id(910));
  const revised={...fakeSource,market:async symbol=>{const value=await fakeSource.market(symbol);value.bars.at(-1).close+=1;value.bars.at(-1).rawClose+=1;return value;}};
  const second=await finish(next.job.id,revised);assert.notEqual(second.report_id,(await repo.job(first.job.id)).report_id);
  assert.equal((await originalScheduledDelivery(next.requestId,fullConfig,repo,stamp)).status,'sent');assert.equal(sends,1);
 }finally{globalThis.fetch=originalFetch;}
 const legacy=new DatabaseSync(':memory:');try{
  for(const file of files.filter(f=>f.slice(0,4)<'0007'))legacy.exec(readFileSync(path.join(root,'drizzle',file),'utf8'));
  legacy.exec("INSERT INTO reports(id,trade_date,created_at,payload,card,complete) VALUES ('legacy','2026-10-02','2026-10-03','immutable-payload','immutable-card',1); INSERT INTO deliveries VALUES ('legacy','unknown',1,'2026-10-03','do not resend');");
  for(const file of files.filter(f=>f.slice(0,4)>='0007'))legacy.exec(readFileSync(path.join(root,'drizzle',file),'utf8'));
  assert.equal(legacy.prepare('SELECT payload FROM reports').get().payload,'immutable-payload');assert.equal(legacy.prepare('SELECT status FROM deliveries').get().status,'unknown');assert.equal(legacy.prepare('SELECT COUNT(*) n FROM scheduled_deliveries').get().n,0);
 }finally{legacy.close();}
});

test('完整分片流水线发布真实公式冻结日报并更新行情；相同业务内容复用首次生成时间',async()=>{
 reset();const first=await admitManual(id(100),repo,now);const ready=await finish(first.job.id);
 assert.equal(ready.status,'ready');assert.equal(ready.failed_attempts,0);assert.ok(ready.lease_epoch>3);
 const report=sql.prepare('SELECT * FROM reports WHERE id=?').get(ready.report_id),snapshot=JSON.parse(report.payload);
 assert.equal(snapshot.tradeDate,target);assert.equal(snapshot.summary.complete,true);assert.equal(snapshot.stocks[0].latest.version,'classroom-v7-no-pcr-1');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_commits').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM bars').get().n,1020);assert.equal(sql.prepare('SELECT COUNT(*) n FROM scores').get().n,510);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
 const next=await admitManual(id(101),repo,now);const reused=await finish(next.job.id);
 assert.equal(reused.status,'reused');assert.equal(reused.report_id,ready.report_id);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,1);
 assert.equal(sql.prepare('SELECT created_at FROM reports').get().created_at,report.created_at);
});
test('SPY有D而股票缺D时不退旧共同日、不发布、不发飞书',async()=>{
 reset();const source={...fakeSource,market:async symbol=>({...await fakeSource.market(symbol),bars:barsAt(symbol==='SPY'?target:'2026-10-01')})};
 const accepted=await admitManual(id(110),repo,now);let job;
 for(let i=0;i<6;i++){await runSlice(accepted.job.id,repo,fullConfig,source);job=await repo.job(accepted.job.id);if(job.status==='partial')break;}
 assert.equal(job.status,'partial');assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
});
test('人工与定时按两种顺序并发受理合并生成，意图分别保存；恢复永不发送',async()=>{
 for(const reverse of [false,true]){reset();const scheduleNow=new Date('2026-10-03T06:00Z');
  const calls=[()=>admitManual(id(120),repo,scheduleNow),()=>admitScheduled(fullConfig,repo,scheduleNow,id(121))];if(reverse)calls.reverse();
  const accepted=await Promise.all(calls.map(f=>f()));assert.equal(accepted[0].job.id,accepted[1].job.id);
  assert.deepEqual(sql.prepare('SELECT source,send_intent FROM daily_requests ORDER BY source').all().map(r=>({...r})),[{source:'manual',send_intent:'none'},{source:'schedule',send_intent:'original_schedule'}]);
  for(let i=0;i<20;i++){await resumeExisting(repo,fullConfig,fakeSource);if((await repo.job(accepted[0].job.id)).status==='ready')break;}
  assert.equal((await repo.job(accepted[0].job.id)).status,'ready');assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
  assert.equal((await originalScheduledDelivery(id(120),fullConfig,repo)).status,'not_requested');
 }
});
test('进程中断租约回收保留检查点、预留预算计费、not-before生效，旧owner零写',async()=>{
 reset();const accepted=await admitManual(id(130),repo,now);await runSlice(accepted.job.id,repo,{},fakeSource);
 const job=await repo.job(accepted.job.id),claimed=await repo.claim(job.id,job.stage);
 sql.prepare('UPDATE job_runs SET lease_until=1,slice_until=1 WHERE id=?').run(job.id);
 await resumeExisting(repo,fullConfig,fakeSource);const interrupted=await repo.job(job.id);
 assert.equal(interrupted.status,'retry_wait');assert.equal(interrupted.checkpoint,1);assert.equal(interrupted.failed_attempts,1);assert.ok(interrupted.active_budget_ms>=25000);assert.ok(interrupted.next_eligible_at>Date.now());
 assert.equal(await repo.checkpoint(claimed.fence,'fetchMarket','{}','hash',1),false);
 sql.prepare('UPDATE job_runs SET next_eligible_at=0 WHERE id=?').run(job.id);const ready=await finish(job.id);assert.equal(ready.status,'ready');assert.equal(ready.failed_attempts,1);
});
test('最后提交断言失败回滚行情、报告、latest、任务和因果计数；随后重试只发布一次',async()=>{
 reset();const accepted=await admitManual(id(140),repo,now);
 while((await repo.job(accepted.job.id)).stage!=='publish')await runSlice(accepted.job.id,repo,fullConfig,fakeSource);
 const before=await repo.revision();
 sql.exec("CREATE TRIGGER sabotage_job BEFORE UPDATE OF status ON job_runs WHEN NEW.status IN ('ready','reused') BEGIN SELECT RAISE(IGNORE); END;");
 const result=await runSlice(accepted.job.id,repo,fullConfig,fakeSource);assert.equal(result.advanced,false);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM bars').get().n,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM report_current').get().n,0);assert.equal(await repo.revision(),before);
 sql.exec('DROP TRIGGER sabotage_job');sql.prepare('UPDATE job_runs SET next_eligible_at=0 WHERE id=?').run(accepted.job.id);
 const ready=await finish(accepted.job.id);assert.equal(ready.status,'ready');assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,1);
});
test('晚完成旧交易日只存历史，latest不倒退；输入基线变化重新冻结而不按时间强排',async()=>{
 reset();const newJob=await admitManual(id(150),repo,now);const ready=await finish(newJob.job.id);
 const oldNow=new Date('2026-10-02T03:00Z'),oldJob=await admitManual(id(151),repo,oldNow);
 const oldSource={...fakeSource,market:async symbol=>({...await fakeSource.market(symbol),bars:barsAt('2026-10-01')})};
 const oldReady=await finish(oldJob.job.id,oldSource);assert.equal(oldReady.status,'ready');assert.equal(sql.prepare('SELECT report_id FROM report_current').get().report_id,ready.report_id);
 const pending=await admitManual(id(152),repo,now);await runSlice(pending.job.id,repo,fullConfig,fakeSource);
 sql.prepare("UPDATE daily_resources SET accepted_revision=accepted_revision+1 WHERE name='market'").run();
 while((await repo.job(pending.job.id)).stage!=='publish')await runSlice(pending.job.id,repo,fullConfig,fakeSource);
 await runSlice(pending.job.id,repo,fullConfig,fakeSource);const reconciled=await repo.job(pending.job.id);
 assert.equal(reconciled.stage,'freezePool');assert.match(reconciled.message,/重新核对/);assert.equal(reconciled.failed_attempts,0);
});
test('小时空扫描不创建日报、任务、请求或发送；累计预算耗尽明确失败',async()=>{
 reset();const before=sql.prepare('SELECT total_changes() n').get().n;assert.equal((await resumeExisting(repo,fullConfig,fakeSource)).advanced,0);assert.equal(sql.prepare('SELECT total_changes() n').get().n,before);
 const accepted=await admitManual(id(160),repo,now);sql.prepare('UPDATE job_runs SET active_budget_ms=1800000 WHERE id=?').run(accepted.job.id);
 await resumeExisting(repo,fullConfig,fakeSource);assert.equal((await repo.job(accepted.job.id)).status,'failed');assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,0);
});

test('小时恢复在预算内连续推进已有任务，不再每小时仅保存一个检查点',async()=>{
 reset();const accepted=await admitManual(id(161),repo,now);
 const result=await resumeExisting(repo,fullConfig,fakeSource);
 assert.equal((await repo.job(accepted.job.id)).status,'ready');assert.ok(result.advanced>1);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_requests').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
});

test('手动续跑只接受已有人工请求，保存同一任务且不新建、不发送',async()=>{
 reset();const accepted=await admitManual(id(162),repo,now),pending=[];
 sql.prepare("UPDATE job_runs SET status='ready',active_key=NULL WHERE id=?").run(accepted.job.id);
 const post=body=>POST(new Request('https://desk.example/api/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 const response=await runWithExecutionContext({waitUntil:p=>pending.push(p)},()=>post({action:'continue',requestId:accepted.requestId}));
 assert.equal(response.status,202);assert.equal((await response.json()).data.job.id,accepted.job.id);assert.equal(pending.length,1);
 await Promise.all(pending);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_requests').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
 assert.equal((await post({action:'continue',requestId:id(999)})).status,400);
 const scheduled=await admitScheduled(fullConfig,repo,new Date('2026-10-05T06:00Z'),id(163));
 assert.equal((await post({action:'continue',requestId:scheduled.requestId})).status,400);
});


test('46只观察池完整两年历史分片容量与20秒drain，复核所有股票并只发布一次',async()=>{
 reset(Array.from({length:46},(_,i)=>'S'+String(i).padStart(2,'0')));
 const accepted=await admitManual(id(170),repo,now),started=performance.now();
 let drains=0;while(drains++<20){await drainJob(accepted.job.id,repo,fullConfig,fakeSource);if((await repo.job(accepted.job.id)).status==='ready')break;}
 const job=await repo.job(accepted.job.id);assert.equal(job.status,'ready');assert.equal(job.failed_attempts,0);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM bars').get().n,47*510);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM scores').get().n,46*510);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM reports').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM daily_commits').get().n,1);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM deliveries').get().n,0);
 assert.ok(sql.prepare('SELECT MAX(length(CAST(payload AS BLOB))) n FROM daily_inputs').get().n<131072);
 const snapshot=JSON.parse(sql.prepare('SELECT payload FROM reports').get().payload);
 assert.equal(snapshot.summary.total,46);assert.equal(snapshot.summary.complete,true);
 console.log('46-symbol fixture:',JSON.stringify({elapsedMs:Math.round(performance.now()-started),drains,inputsBytes:sql.prepare('SELECT SUM(length(CAST(payload AS BLOB))) n FROM daily_inputs').get().n,workBudgetUsedMs:job.active_budget_ms}));
});

test('retry末尾断言失败时回滚attempt和job，旧owner不能部分结束attempt',async()=>{
 reset();const accepted=await admitManual(id(180),repo,now);const claim=await repo.claim(accepted.job.id,'freezePool');
 sql.exec("CREATE TRIGGER sabotage_retry BEFORE UPDATE OF status ON job_runs WHEN NEW.status='retry_wait' BEGIN SELECT RAISE(IGNORE); END;");
 await assert.rejects(repo.retry(claim.fence,'test-only'),/CHECK constraint/);
 assert.equal((await repo.job(accepted.job.id)).status,'running');
 assert.equal(sql.prepare('SELECT status FROM daily_attempts WHERE id=?').get(claim.job.attempt_id).status,'running');
 sql.exec('DROP TRIGGER sabotage_retry');await repo.retry(claim.fence,'test-only');assert.equal((await repo.job(accepted.job.id)).status,'retry_wait');
});
