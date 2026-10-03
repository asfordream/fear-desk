import {getRawDb} from '@/db';
import {recompute,instrument,ensureInitial} from './store';
import {fetchEarnings,nyDate,visibleDate,validDate,type EarningsCandidate} from './earnings-provider';
import {calendar,type CalendarRow} from './earnings-read';
export {readEarnings} from './earnings-read';
const db=()=>getRawDb();
async function writeAuto(symbol:string,prior:CalendarRow,candidate:EarningsCandidate|null,error:string|null,token:string,now:Date){
 const day=nyDate(now),stamp=now.toISOString();
 // A failing provider cannot erase a saved future date. A successful empty response can.
 const keep=!candidate&&!!error&&!!prior.date&&(prior.end_date??prior.date)>=day;
 let value=candidate??(keep?{date:prior.date,endDate:prior.end_date,status:prior.status,timing:prior.timing,source:prior.source,sourceUrl:prior.source_url}:{date:null,endDate:null,status:'unavailable',timing:'unknown',source:'公开财报日历',sourceUrl:null});
 if(candidate?.status==='estimated'&&prior.status==='confirmed'&&prior.date&&prior.date>=day){value={date:prior.date,endDate:prior.end_date,status:prior.status,timing:prior.timing,source:prior.source,sourceUrl:prior.source_url};error=[error,'第三方预计日期未替代已确认公告，请核对原来源'].filter(Boolean).join('；');}
 const effective=value.endDate?null:value.date;const previousEffective=prior.end_date?null:prior.date;
 const changed=effective!==previousEffective||value.status!==prior.status;
 const ttl=candidate?24*3600_000:error?15*60_000:6*3600_000;
 const statements=[db().prepare("UPDATE earnings_calendar SET date=?,end_date=?,status=?,timing=?,source=?,source_url=?,checked_at=?,next_check=?,error=?,needs_recompute=CASE WHEN ?=1 THEN 1 ELSE needs_recompute END,revision=revision+1,write_token=? WHERE symbol=? AND mode='auto' AND revision=? AND EXISTS(SELECT 1 FROM workflow_locks WHERE name=? AND token=? AND until>?)").bind(value.date,value.endDate,value.status,value.timing,value.source,value.sourceUrl,stamp,now.getTime()+ttl,error,changed?1:0,token,symbol,prior.revision,'earnings:'+symbol,token,Date.now())];
 if(changed)statements.push(db().prepare('INSERT INTO earnings_events(symbol,date,known_at,source,recorded_at,confidence,source_url,timing) SELECT symbol,?,?,?,?,?,?,? FROM earnings_calendar WHERE symbol=? AND write_token=? AND revision=?').bind(effective,visibleDate(now),value.source,stamp,value.status,value.sourceUrl,value.timing,symbol,token,prior.revision+1),db().prepare('UPDATE instruments SET event_date=?,event_known_at=? WHERE symbol=? AND EXISTS(SELECT 1 FROM earnings_calendar WHERE symbol=? AND write_token=? AND revision=?)').bind(value.date,visibleDate(now),symbol,symbol,token,prior.revision+1));
 const result=await db().batch(statements);if(!result[0].meta.changes)return {symbol,status:'superseded',message:'人工修改或更新令牌已变化，自动结果未覆盖'};
 if(changed){await recompute(symbol);await db().prepare('UPDATE earnings_calendar SET needs_recompute=0 WHERE symbol=? AND write_token=? AND revision=?').bind(symbol,token,prior.revision+1).run();}
 return {symbol,status:candidate?'updated':keep?'retained':error?'error':'unavailable',message:candidate?'财报日期已自动入库':keep?'获取失败，保留已有日期':error?'来源暂不可用':'尚无下一次财报日期'};
}
export async function refreshSymbolEarnings(symbol:string,config:{FINNHUB_API_KEY?:string}={},force=false){
 if(symbol==='SPY')return {symbol,status:'skipped',message:'SPY不适用公司财报'};const item=await instrument(symbol);if(!item||!item.active)throw new Error('标的不在观察池');
 await db().prepare('INSERT INTO earnings_calendar(symbol) VALUES (?) ON CONFLICT(symbol) DO NOTHING').bind(symbol).run();const now=new Date(),prior=(await calendar(symbol))!;if(prior.needs_recompute){await recompute(symbol);await db().prepare('UPDATE earnings_calendar SET needs_recompute=0 WHERE symbol=? AND revision=?').bind(symbol,prior.revision).run();}
 if(prior.mode==='manual')return {symbol,status:'manual',message:'人工纠错优先，可恢复自动获取'};
 if(!force&&prior.next_check>now.getTime())return {symbol,status:'cached',message:'使用已入库财报日历'};
 const token=crypto.randomUUID(),name='earnings:'+symbol;const lock=await db().prepare('INSERT INTO workflow_locks(name,token,until) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,until=excluded.until WHERE workflow_locks.until<?').bind(name,token,Date.now()+90_000,Date.now()).run();if(!lock.meta.changes)return {symbol,status:'busy',message:'财报日历正在更新'};
 try{const result=await fetchEarnings(symbol,nyDate(now),config);return await writeAuto(symbol,prior,result.candidate,result.error,token,now);}finally{await db().prepare('DELETE FROM workflow_locks WHERE name=? AND token=?').bind(name,token).run();}
}
export async function refreshEarnings(config:{FINNHUB_API_KEY?:string}={},symbol?:string,force=false){
 await ensureInitial();const symbols=symbol?[symbol]:(await db().prepare("SELECT symbol FROM instruments WHERE active=1 AND symbol!='SPY' ORDER BY symbol").all<{symbol:string}>()).results.map(x=>x.symbol);
 const results:Awaited<ReturnType<typeof refreshSymbolEarnings>>[]=[];
 // Bound parallel network requests; each provider is fetched at most once per symbol per cache period.
 for(let i=0;i<symbols.length;i+=4){const rows=await Promise.all(symbols.slice(i,i+4).map(async s=>{try{return await refreshSymbolEarnings(s,config,force);}catch{return {symbol:s,status:'error',message:'财报更新未完成，请重试'};}}));results.push(...rows);}return results;
}
export async function editEarnings(symbol:string,date:string|null,mode:'manual'|'auto'){
 const item=await instrument(symbol);if(!item||symbol==='SPY')throw new Error('未知标的');if(date!==null&&!validDate(date))throw new Error('财报日期格式无效');
 const now=new Date(),stamp=now.toISOString(),token=crypto.randomUUID();const effective=mode==='manual'?date:null;
 await db().batch([db().prepare("INSERT INTO earnings_calendar(symbol,date,status,source,mode,checked_at,write_token,revision,needs_recompute) VALUES (?,?,?,?,?,?,?,1,1) ON CONFLICT(symbol) DO UPDATE SET date=excluded.date,end_date=NULL,status=excluded.status,timing='unknown',source=excluded.source,source_url=NULL,mode=excluded.mode,checked_at=excluded.checked_at,next_check=0,error=NULL,needs_recompute=1,revision=earnings_calendar.revision+1,write_token=excluded.write_token").bind(symbol,effective,effective?'confirmed':'unavailable',mode==='manual'?'人工登记':'公开财报日历',mode,stamp,token),db().prepare('INSERT INTO earnings_events(symbol,date,known_at,source,recorded_at,confidence,timing) VALUES (?,?,?,?,?,?,?)').bind(symbol,effective,visibleDate(now),mode==='manual'?'manual':'auto-reset',stamp,effective?'confirmed':'unavailable','unknown'),db().prepare('UPDATE instruments SET event_date=?,event_known_at=? WHERE symbol=?').bind(effective,visibleDate(now),symbol)]);
 await recompute(symbol);await db().prepare('UPDATE earnings_calendar SET needs_recompute=0 WHERE symbol=? AND write_token=?').bind(symbol,token).run();return {symbol,date:effective,mode};
}
