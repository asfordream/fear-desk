import {getRawDb} from '@/db';
import {ensureInitial,syncAll} from './store';
import {refreshEarnings} from './earnings';
import {readEarnings} from './earnings-read';
import {VERSION,type Score} from './engine';
import {summarize,renderCard,CARD_FORMAT_VERSION,publicBase,beijingReportCutoff,type ReportStock,type ReportSnapshot} from './report';
import {postCard,validateWebhook,type BotConfig} from './feishu';

const db=()=>getRawDb();
async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
export async function generateReport(config:BotConfig={},expectedDate?:string){
 await ensureInitial();
 const dates=(await db().prepare('SELECT date FROM bars WHERE symbol=? AND (? IS NULL OR date<=?) ORDER BY date DESC LIMIT 2').bind('SPY',expectedDate??null,expectedDate??null).all<{date:string}>()).results;
 const tradeDate=dates[0]?.date;if(!tradeDate)throw new Error('SPY 尚未入库');if(expectedDate&&tradeDate!==expectedDate)throw new Error(`SPY 尚无 ${expectedDate} 收盘数据；休市或行情延迟，未生成当日日报`);
 const previousDate=dates[1]?.date??null;
 const items=(await db().prepare("SELECT symbol,name,status,event_date FROM instruments WHERE active=1 AND symbol!='SPY' ORDER BY symbol").all<{symbol:string;name:string;status:string;event_date:string|null}>()).results;
 const stocks:ReportStock[]=[];
 for(const item of items){const history=(await db().prepare('SELECT date,payload FROM scores WHERE symbol=? AND date IN (?,?) ORDER BY date DESC').bind(item.symbol,tradeDate,previousDate).all<{date:string;payload:string}>()).results;stocks.push({symbol:item.symbol,name:item.name,status:item.status,eventDate:item.event_date,earningsInfo:await readEarnings(item.symbol),latest:history.find(s=>s.date===tradeDate)?JSON.parse(history.find(s=>s.date===tradeDate)!.payload) as Score:null,previous:history.find(s=>s.date===previousDate)?JSON.parse(history.find(s=>s.date===previousDate)!.payload) as Score:null});}
 const watchlistHash=await digest(items.map(x=>({symbol:x.symbol,name:x.name,eventDate:x.event_date})));
 const facts={tradeDate,previousDate,version:VERSION,watchlistHash,stocks,summary:summarize(stocks,tradeDate,previousDate)};
 const base=publicBase(config.SITE_BASE_URL);const id=await digest({facts,base,cardFormatVersion:CARD_FORMAT_VERSION});
 const report:ReportSnapshot={id,generatedAt:new Date().toISOString(),...facts};const card=renderCard(report,base);
 await db().prepare('INSERT INTO reports(id,trade_date,created_at,payload,card,complete) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,tradeDate,report.generatedAt,JSON.stringify(report),JSON.stringify(card),report.summary.complete?1:0).run();
 return readReport(id);
}
export async function readReport(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('日报编号无效');const row=await db().prepare('SELECT payload,card FROM reports WHERE id=?').bind(id).first<{payload:string;card:string}>();if(!row)throw new Error('日报不存在');const delivery=await db().prepare('SELECT status,attempts,updated_at,message,occurrence_date FROM (SELECT status,attempts,updated_at,message,NULL AS occurrence_date FROM deliveries WHERE report_id=? UNION ALL SELECT status,attempts,updated_at,message,occurrence_date FROM scheduled_deliveries WHERE report_id=?) ORDER BY updated_at DESC LIMIT 1').bind(id,id).first();return {snapshot:JSON.parse(row.payload) as ReportSnapshot,card:JSON.parse(row.card),delivery};}
export async function reportStatus(config:BotConfig){
 const reports=(await db().prepare('SELECT id,trade_date,created_at,complete FROM reports ORDER BY created_at DESC LIMIT 20').all()).results;
 const jobs=(await db().prepare('SELECT id,started_at,finished_at,trade_date,report_id,status,message FROM job_runs ORDER BY started_at DESC LIMIT 8').all()).results;
 let webhookValid=false;try{webhookValid=!!config.FEISHU_WEBHOOK_URL&&!!validateWebhook(config.FEISHU_WEBHOOK_URL);}catch{/* Only expose validity, never credentials. */}
 return {reports,jobs,config:{webhookConfigured:webhookValid,signingConfigured:!!config.FEISHU_SIGNING_SECRET,sendEnabled:config.FEISHU_SEND_ENABLED==='true',publicLinks:!!publicBase(config.SITE_BASE_URL),earningsConfigured:true,earningsSource:'公司公告优先 / Yahoo免费预计日历',finnhubConfigured:!!config.FINNHUB_API_KEY,schedule:'北京时间周一至周六14:00；使用最近已收盘行情并标明实际交易日，每排程日推送一次；周日不生成、不推送',deployment:'关联Sites云端任务触发；实际结果以最近任务和发送状态为准'}};
}
export async function sendReport(id:string,config:BotConfig){
 if(config.FEISHU_SEND_ENABLED!=='true'||!config.FEISHU_WEBHOOK_URL)throw new Error('机器人尚未启用，当前仅提供预览');validateWebhook(config.FEISHU_WEBHOOK_URL);
 const saved=await readReport(id);if(!saved.snapshot.summary.complete)throw new Error('行情截面不齐，禁止发送此日报');
 const base=publicBase(config.SITE_BASE_URL);if(!base||!JSON.stringify(saved.card).includes(`${base}/reports/${id}`))throw new Error('请配置公网 HTTPS 网站地址后重新生成日报，发送卡片必须有冻结日报链接');
 const now=new Date().toISOString();
 await db().prepare("INSERT INTO deliveries(report_id,status,attempts,updated_at) VALUES (?,'failed',0,?) ON CONFLICT(report_id) DO NOTHING").bind(id,now).run();
 const claim=await db().prepare("UPDATE deliveries SET status='sending',attempts=attempts+1,updated_at=?,message='请求处理中，重复发送已阻断' WHERE report_id=? AND status='failed'").bind(now,id).run();
 if(!claim.meta.changes)return {status:saved.delivery?.status??'sending',message:'已发送、发送中或结果不确定；未重复提交'};
 // A crash after the claim leaves sending. It is intentionally not leased/retried:
 // the custom bot has no message idempotency API, so a second request could duplicate.
 let result;try{result=await postCard(saved.card,config);}catch(e){result={status:'failed' as const,message:e instanceof Error?e.message:'发送配置无效'};}
 await db().prepare('UPDATE deliveries SET status=?,updated_at=?,message=? WHERE report_id=?').bind(result.status,new Date().toISOString(),result.message,id).run();return result;
}
export async function runDaily(config:BotConfig,now=new Date()){
 const cutoff=beijingReportCutoff(now);if(!cutoff.ready)return {status:'skipped',message:'未到北京时间14:00，或前一天为美股周末；未更新'};
 const token=crypto.randomUUID(),startedAt=new Date().toISOString(),lease=Date.now()+14*60_000;
 const lock=await db().prepare("INSERT INTO workflow_locks(name,token,until) VALUES ('daily',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,until=excluded.until WHERE workflow_locks.until<?").bind(token,lease,Date.now()).run();if(!lock.meta.changes)return {status:'busy',message:'每日任务正在运行'};
 await markInterrupted(startedAt);
 await db().prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES (?,?,?,'running')").bind(token,startedAt,cutoff.date).run();
 const finish=async(status:string,message:string)=>{await db().prepare('UPDATE job_runs SET status=?,message=?,finished_at=? WHERE id=?').bind(status,message,new Date().toISOString(),token).run();return {status,message};};
 try{
  const existing=await db().prepare("SELECT reports.id FROM job_runs JOIN reports ON job_runs.report_id=reports.id WHERE job_runs.trade_date=? AND job_runs.status='ready' AND reports.complete=1 ORDER BY job_runs.started_at DESC LIMIT 1").bind(cutoff.date).first<{id:string}>();
  const autoSend=async(id:string)=>{const prior=await db().prepare("SELECT deliveries.status FROM deliveries JOIN reports ON reports.id=deliveries.report_id WHERE reports.trade_date=? AND deliveries.status IN ('sent','sending','unknown') LIMIT 1").bind(cutoff.date).first();return prior?'当日已发送或结果待核对，未重复提交':(await sendReport(id,config)).message;};
  if(existing){let saved=await readReport(existing.id);const base=publicBase(config.SITE_BASE_URL);if(base&&!JSON.stringify(saved.card).includes(`${base}/reports/${saved.snapshot.id}`))saved=await generateReport(config,cutoff.date);await db().prepare('UPDATE job_runs SET report_id=? WHERE id=?').bind(saved.snapshot.id,token).run();const message=config.FEISHU_SEND_ENABLED==='true'?await autoSend(saved.snapshot.id):'仅保存预览';return finish('ready',`当日任务已完成，复用冻结日报；${message}`);}
  const results=await syncAll();if(results.some(x=>x.status!=='success'))return finish('partial','行情更新未全部成功；保留原有截面，等待下一次触发');
  const latest=await db().prepare("SELECT MAX(date) AS date FROM bars WHERE symbol='SPY'").first<{date:string}>();if(latest?.date!==cutoff.date)return finish('skipped','SPY 无当天收盘日线；休市或数据尚未发布');
  const earningsResult=await refreshEarnings(config);const earnings=`财报更新：${earningsResult.filter(x=>x.status==='updated').length}只新数据 / ${earningsResult.filter(x=>['error','retained'].includes(x.status)).length}只需核对`;
  const owned=await db().prepare("SELECT name FROM workflow_locks WHERE name='daily' AND token=? AND until>?").bind(token,Date.now()).first();if(!owned)return finish('partial','任务锁已过期；未生成或发送日报');
  const saved=await generateReport(config,cutoff.date);if(!saved.snapshot.summary.complete)return finish('partial','当天行情不齐；预览已保存，自动发送已阻断');
  await db().prepare('UPDATE job_runs SET report_id=? WHERE id=?').bind(saved.snapshot.id,token).run();
  let delivery='仅保存预览';if(config.FEISHU_SEND_ENABLED==='true')delivery=await autoSend(saved.snapshot.id);
  return finish('ready',`${earnings}；${delivery}`);
 }catch{return finish('error','每日任务未完成；可在网页查看行情状态并重试，机器人配置请查服务器设置');}
 finally{await db().prepare("DELETE FROM workflow_locks WHERE name='daily' AND token=?").bind(token).run();}
}

async function markInterrupted(stamp:string){
 // Call only after claiming the exclusive global lease. No older invocation
 // can still own it; keep its audit row instead of showing running forever.
 await db().prepare("UPDATE job_runs SET status='interrupted',finished_at=?,message='前次请求已中断，任务锁已被后续运行接管' WHERE status='running'").bind(stamp).run();
}
export async function recoverLastIncomplete(config:BotConfig,now=new Date()){
 const target=beijingReportCutoff(now).date;
 const pending=await db().prepare("SELECT j.trade_date FROM job_runs j WHERE j.trade_date<? AND j.status IN ('running','interrupted','error','partial') AND NOT EXISTS (SELECT 1 FROM reports r JOIN deliveries d ON d.report_id=r.id WHERE r.trade_date=j.trade_date AND d.status IN ('sent','sending','unknown')) ORDER BY j.trade_date DESC LIMIT 1").bind(target).first<{trade_date:string}>();
 if(!pending)return {status:'skipped',message:'没有可安全补发的历史任务；当天任务仍按14:00执行'};
 const token=crypto.randomUUID(),stamp=new Date().toISOString();
 const claim=await db().prepare("INSERT INTO workflow_locks(name,token,until) VALUES ('daily',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,until=excluded.until WHERE workflow_locks.until<?").bind(token,Date.now()+14*60_000,Date.now()).run();
 if(!claim.meta.changes)return {status:'busy',message:'每日任务正在运行，未启动补发'};
 const finish=async(status:string,message:string)=>{await db().prepare('UPDATE job_runs SET status=?,message=?,finished_at=? WHERE id=?').bind(status,message,new Date().toISOString(),token).run();return {status,message};};
 try{
  await markInterrupted(stamp);
  await db().prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES (?,?,?,'running')").bind(token,stamp,pending.trade_date).run();
  // Use the already stored scores for this exact date. Do not rewrite historical
  // factors using today's earnings knowledge or substitute a newer SPY date.
  const saved=await generateReport(config,pending.trade_date);
  await db().prepare('UPDATE job_runs SET report_id=? WHERE id=?').bind(saved.snapshot.id,token).run();
  if(!saved.snapshot.summary.complete)return finish('partial','补发日期的行情或评分不齐，未发送');
  const prior=await db().prepare("SELECT d.status FROM deliveries d JOIN reports r ON r.id=d.report_id WHERE r.trade_date=? AND d.status IN ('sent','sending','unknown') LIMIT 1").bind(pending.trade_date).first();
  if(prior)return finish('ready','该日期已发送或结果待核对，未重复补发');
  const result=await sendReport(saved.snapshot.id,config);
  return finish(result.status==='sent'?'ready':'partial',`补发 ${pending.trade_date} 收盘日报；${result.message}`);
 }catch{return finish('error','历史日报补发未完成；未改写原有行情与评分，请核对截面及发送记录');}
 finally{await db().prepare("DELETE FROM workflow_locks WHERE name='daily' AND token=?").bind(token).run();}
}

export async function refreshDailyInputs(config:BotConfig){
 const stamp=new Date().toISOString(),token=crypto.randomUUID(),date=beijingReportCutoff(new Date()).date;
 const claim=await db().prepare("INSERT INTO workflow_locks(name,token,until) VALUES ('daily',?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,until=excluded.until WHERE workflow_locks.until<?").bind(token,Date.now()+14*60_000,Date.now()).run();
 if(!claim.meta.changes)return {status:'busy',message:'每日任务正在运行，未并行刷新'};
 const finish=async(status:string,message:string)=>{await db().prepare('UPDATE job_runs SET status=?,message=?,finished_at=? WHERE id=?').bind(status,message,new Date().toISOString(),token).run();return {status,message};};
 try{
  await markInterrupted(stamp);
  await db().prepare("INSERT INTO job_runs(id,started_at,trade_date,status) VALUES (?,?,?,'running')").bind(token,stamp,date).run();
  const results=await syncAll();if(results.some(x=>x.status!=='success'))return finish('partial','增量行情更新未全部成功；未发送');
  const earnings=await refreshEarnings(config);
  return finish('updated',`增量行情 ${results.length} 个标的完成；财报检查 ${earnings.length} 个；仅更新，未发送`);
 }catch{return finish('error','行情与财报刷新未完成；未发送');}
 finally{await db().prepare("DELETE FROM workflow_locks WHERE name='daily' AND token=?").bind(token).run();}
}
