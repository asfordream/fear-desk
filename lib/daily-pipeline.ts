import {getRequestExecutionContext} from 'vinext/shims/request-context';
import {VERSION,calculate,type EventDecision} from './engine';
import {CARD_FORMAT_VERSION,summarize,renderCard,publicBase,type ReportSnapshot,type ReportStock} from './report';
import {hashFacts,jobDto,validRequestId,TERMINAL_STATUSES,type DailyJobRow} from './daily-contract';
import {DailyRepository} from './daily-repository';
import {latestClosedTradingDay,scheduledReportWindow} from './trading-calendar';
import {fetchMarket,type Market} from './provider';
import {fetchEarnings,nyDate,visibleDate,type EarningsInfo} from './earnings-provider';
import {calendarInfo} from './earnings-read';
import {sendScheduledReport} from './scheduled-delivery';
import type {BotConfig} from './feishu';

export type PipelineConfig=BotConfig&{FINNHUB_API_KEY?:string};
type ReportPart={stock:ReportStock;fingerprint:{symbol:string;market:string;earnings:string};earnings:FrozenEarnings};
type Manifest={pool:Awaited<ReturnType<DailyRepository['pool']>>;requestedClosedDay:string;inputRevision:number};
export type FrozenEarnings={info:EarningsInfo|null;events:EventDecision[];newEvent:EventDecision|null};
export type PipelineProviders={market:(symbol:string,signal:AbortSignal)=>Promise<Market>;earnings:typeof fetchEarnings};
const providers:PipelineProviders={market:(symbol,signal)=>fetchMarket(symbol,undefined,signal),earnings:fetchEarnings};
class Incomplete extends Error{}

async function admitted(requestId:unknown,source:'manual'|'schedule',sendIntent:'none'|'original_schedule',repository:DailyRepository,now:Date,scheduleOccurrence:string|null=null){
 if(!validRequestId(requestId))throw new Error('请求编号无效');
 const existing=await repository.request(requestId);
 if(existing){if(existing.source!==source||existing.send_intent!==sendIntent)throw new Error('请求编号已被不同来源使用');const job=await repository.job(existing.job_id);if(!job)throw new Error('任务映射不完整');return {requestId,job:jobDto(job),sendIntent};}
 const target=latestClosedTradingDay(now);let pool=await repository.pool();
 if(!pool.length){const {ensureInitial}=await import('./store');await ensureInitial();pool=await repository.pool();}
 const poolVersion=await hashFacts(pool),revision=await repository.revision();
 const scopeHash=await hashFacts({day:target.date,poolVersion,revision,algorithm:VERSION,card:CARD_FORMAT_VERSION});
 return repository.admit({requestId,source,sendIntent,scopeHash,scheduleOccurrence},target.date,poolVersion,VERSION,CARD_FORMAT_VERSION,target.calendarVersion,revision);
}
export function admitManual(requestId:unknown,repository=new DailyRepository(),now=new Date()){return admitted(requestId,'manual','none',repository,now);}
export async function admitScheduled(config:PipelineConfig,repository=new DailyRepository(),now=new Date(),requestId?:unknown){
 const occurrence=scheduledReportWindow(now);
 if(!occurrence.ready)return {status:'skipped',message:'未到北京时间周一至周六14:00窗口；未新建任务'} as const;
 return admitted(requestId??`scheduled-${occurrence.date}`,'schedule',config.FEISHU_SEND_ENABLED==='true'?'original_schedule':'none',repository,now,occurrence.date);
}
async function encoded(symbol:string,kind:string,value:unknown){return {symbol,kind,payload:JSON.stringify(value),hash:await hashFacts(value)};}
const closed=(market:Market,target:string)=>({...market,bars:market.bars.filter(b=>b.date<=target).sort((a,b)=>a.date.localeCompare(b.date))});

export async function runSlice(jobId:string,repository=new DailyRepository(),config:PipelineConfig={},source=providers,signal=AbortSignal.timeout(20_000)){
 await repository.recoverExpired(jobId);
 const before=await repository.job(jobId);if(!before||TERMINAL_STATUSES.includes(before.status as typeof TERMINAL_STATUSES[number]))return {advanced:false};
 const claimed=await repository.claim(jobId,before.stage);if(!claimed)return {advanced:false};
 const {job,fence}=claimed;const started=performance.now();
 const saved=async(stage:DailyJobRow['stage'],inputs:Awaited<ReturnType<typeof encoded>>[]=[],patch:{tradeDate?:string;validationHash?:string}={})=>{
  signal.throwIfAborted();return repository.saveStep(fence,stage,inputs,performance.now()-started,patch);
 };
 try{
  if(job.algorithm_version!==VERSION||job.card_version!==CARD_FORMAT_VERSION)throw new Incomplete('算法或卡片版本已变化；请重新请求');
  if(job.stage==='freezePool'){
   const pool=await repository.pool();if(await hashFacts(pool)!==job.pool_version){await repository.fail(fence,'观察池在受理后发生变化；请重新请求，不使用混合观察池');return {advanced:false};}
   if(await repository.revision()!==job.input_revision){await repository.reconcile(fence);return {advanced:false};}
   return {advanced:await saved('resolveSPY',[await encoded('__pool__','manifest',{pool,requestedClosedDay:job.requested_closed_day,inputRevision:job.input_revision})])};
  }
  const manifest=await repository.input<Manifest>(job,'__pool__','manifest');if(!manifest?.pool.length)throw new Incomplete('观察池为空或冻结清单缺失');
  if(job.stage==='resolveSPY'){
   const market=closed(await source.market('SPY',signal),job.requested_closed_day),date=market.bars.at(-1)?.date;
   if(!date)throw new Incomplete('SPY 没有目标范围内的已收盘日线');
   return {advanced:await saved('fetchMarket',[await encoded('SPY','market',market)],{tradeDate:date})};
  }
  if(!job.trade_date)throw new Incomplete('目标交易日尚未确定');
  if(job.stage==='fetchMarket'){
   const done=await repository.saved(job,'market'),item=manifest.pool.find(p=>!done.includes(p.symbol));
   if(!item)return {advanced:await saved('earnings')};
   const market=closed(await source.market(item.symbol,signal),job.trade_date);
   if(market.bars.at(-1)?.date!==job.trade_date)throw new Incomplete(`${item.symbol} 缺少 ${job.trade_date} 行情；不退回旧共同日期`);
   return {advanced:await saved('fetchMarket',[await encoded(item.symbol,'market',market)])};
  }
  if(job.stage==='earnings'){
   const done=await repository.saved(job,'earnings'),item=manifest.pool.find(p=>!done.includes(p.symbol));
   if(!item)return {advanced:await saved('calculate')};
   const {calendar,events}=await repository.earningsState(item.symbol),stamp=new Date(),day=nyDate(stamp);
   let info=calendarInfo(calendar,day),newEvent:EventDecision|null=null;
   if(calendar?.mode!=='manual'&&(!calendar||calendar.next_check<=Date.now())){
    const fetcher:typeof fetch=(url,options={})=>fetch(url,{...options,signal:options.signal?AbortSignal.any([options.signal,signal]):signal});
    const result=await source.earnings(item.symbol,day,config,fetcher);signal.throwIfAborted();
    const priorFuture=calendar?.date&&(calendar.end_date??calendar.date)>=day;
    const keepConfirmed=result.candidate?.status==='estimated'&&calendar?.status==='confirmed'&&priorFuture;
    const value=keepConfirmed||(!result.candidate&&result.error&&priorFuture)?info:result.candidate;
    info=value?{...value,mode:'auto',checkedAt:stamp.toISOString(),error:result.error,calculationPending:false}:{date:null,endDate:null,status:'unavailable',timing:'unknown',source:'公开财报日历',sourceUrl:null,mode:'auto',checkedAt:stamp.toISOString(),error:result.error,calculationPending:false};
    const effective=info.endDate?null:info.date,prior=calendar?.end_date?null:calendar?.date??null;
    if(effective!==prior||info.status!==calendar?.status){newEvent={date:effective,knownAt:visibleDate(stamp),confidence:info.status};events.push(newEvent);}
   }
   if(info)info={...info,calculationPending:false}; // Pure recomputation follows before any publication.
   return {advanced:await saved('earnings',[await encoded(item.symbol,'earnings',{info,events,newEvent})])};
  }
  if(job.stage==='calculate'){
   const done=await repository.saved(job,'scores'),item=manifest.pool.find(p=>!done.includes(p.symbol));
   if(!item)return {advanced:await saved('validate')};
   const market=await repository.input<Market>(job,item.symbol,'market'),spy=await repository.input<Market>(job,'SPY','market'),earnings=await repository.input<FrozenEarnings>(job,item.symbol,'earnings');
   if(!market||!spy||!earnings)throw new Incomplete('冻结输入不完整，禁止计算混合截面');
   const rows=calculate(market.bars,spy.bars,earnings.events);signal.throwIfAborted();
   const previousDate=spy.bars.at(-2)?.date??null;
   const stock:ReportStock={symbol:item.symbol,name:item.name,status:'ready',eventDate:earnings.info?.date??null,earningsInfo:earnings.info,
     latest:rows.find(r=>r.date===job.trade_date)??null,previous:rows.find(r=>r.date===previousDate)??null};
   if(!stock.latest||stock.latest.version!==VERSION)throw new Incomplete('目标评分行缺失或版本不一致');
   const semantic=earnings.info?{date:earnings.info.date,endDate:earnings.info.endDate,status:earnings.info.status,timing:earnings.info.timing,source:earnings.info.source,sourceUrl:earnings.info.sourceUrl,mode:earnings.info.mode}:null;
   const part:ReportPart={stock,fingerprint:{symbol:item.symbol,market:await hashFacts(market.bars),earnings:await hashFacts({semantic,events:earnings.events})},earnings};
   return {advanced:await saved('calculate',[await encoded(item.symbol,'scores',rows),await encoded(item.symbol,'report',part)])};
  }
  const bundle=await repository.bundle(job),spy=await repository.input<Market>(job,'SPY','market');if(!spy)throw new Incomplete('SPY 冻结输入缺失');
  const previousDate=spy.bars.at(-2)?.date??null,stocks:ReportStock[]=[],earningsValues:{symbol:string;value:FrozenEarnings}[]=[],fingerprints:ReportPart['fingerprint'][]=[];
  for(const item of manifest.pool){
   const part=bundle.get(item.symbol+':report') as ReportPart|undefined;
   if(!part||part.stock.latest?.date!==job.trade_date||part.stock.latest.version!==VERSION)throw new Incomplete('行情、财报或重算清单缺失；未发布');
   stocks.push(part.stock);earningsValues.push({symbol:item.symbol,value:part.earnings});fingerprints.push(part.fingerprint);
  }
  const summary=summarize(stocks,job.trade_date,previousDate);if(!summary.complete)throw new Incomplete('完整性校验未通过；保留原日报');
  const base=publicBase(config.SITE_BASE_URL);
  const facts={tradeDate:job.trade_date,previousDate,version:VERSION,watchlistHash:job.pool_version,stocks,summary};
  const businessStocks=stocks.map(({earningsInfo,...stock})=>({...stock,earnings:earningsInfo?{date:earningsInfo.date,endDate:earningsInfo.endDate,status:earningsInfo.status,timing:earningsInfo.timing,source:earningsInfo.source,sourceUrl:earningsInfo.sourceUrl,mode:earningsInfo.mode}:null}));
  const hash=await hashFacts({tradeDate:job.trade_date,previousDate,version:VERSION,pool:job.pool_version,stocks:businessStocks,fingerprints,spy:spy.bars,base,cardVersion:CARD_FORMAT_VERSION});
  if(job.stage==='validate')return {advanced:await saved('publish',[],{validationHash:hash})};
  if(job.validation_hash!==hash)throw new Incomplete('冻结清单校验不一致；未发布');
  if(await repository.revision()!==job.input_revision){await repository.reconcile(fence);return {advanced:false};}
  const snapshot:ReportSnapshot={id:hash,generatedAt:new Date().toISOString(),...facts};signal.throwIfAborted();
  await repository.publish(fence,snapshot,renderCard(snapshot,base),[{symbol:'SPY',fetchedAt:spy.fetchedAt},...manifest.pool.map(p=>({symbol:p.symbol,fetchedAt:snapshot.generatedAt}))],hash,earningsValues);
  return {advanced:true};
 }catch(error){
  if(error instanceof Incomplete){await repository.fail(fence,error.message,'partial');}
  else if(job.stage==='publish'&&await repository.revision()!==job.input_revision){await repository.reconcile(fence);}
  else await repository.retry(fence,'本次分片未完成；检查点已保留，等待后台重试');
  return {advanced:false};
 }
}
export async function runFirstSlice(jobId:string,repository=new DailyRepository()){const job=await repository.job(jobId);return job?.stage==='freezePool'?runSlice(jobId,repository):{advanced:false};}
export async function drainJob(jobId:string,repository=new DailyRepository(),config:PipelineConfig={},source=providers,budgetMs=20_000){
 const start=performance.now(),signal=AbortSignal.timeout(Math.max(1,budgetMs));let advanced=0;
 while(performance.now()-start<budgetMs-1500){const result=await runSlice(jobId,repository,config,source,signal);if(!result.advanced)break;advanced++;}
 return {advanced,job:await repository.job(jobId)};
}
export async function resumeExisting(repository=new DailyRepository(),config:PipelineConfig={},source=providers,budgetMs=20_000){
 await repository.expireBudget();const start=performance.now(),signal=AbortSignal.timeout(budgetMs);let advanced=0;
 for(const item of await repository.existing(8)){if(performance.now()-start>budgetMs-1500)break;await repository.recoverExpired(item.id);if((await runSlice(item.id,repository,config,source,signal)).advanced)advanced++;}
 return {advanced,status:await repository.status()}; // No admission or delivery capability.
}
export async function originalScheduledDelivery(requestId:string,config:PipelineConfig,repository=new DailyRepository(),now=new Date()){
 const original=await repository.originalDelivery(requestId);if(!original)return {status:'not_requested',message:'没有本轮原定时发送意图或完整日报'};
 return sendScheduledReport(original.report_id,original.schedule_occurrence,config,now);
}
export function scheduleFirstSlice(jobId:string,execute:()=>Promise<unknown>=()=>drainJob(jobId),context=getRequestExecutionContext()){
 if(!context)return false;
 context.waitUntil(Promise.resolve().then(execute).catch(()=>console.error('FearDesk slice incomplete; retained durable job')));return true;
}
