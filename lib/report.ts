import {earningsLabel,type EarningsInfo} from './earnings-provider.ts';
import {GROUPS,type Score} from './engine.ts';

export const BANDS=[{name:'击球区',min:75,range:'≥75',icon:'⚾'},{name:'底部区',min:60,range:'60–74',icon:'🔻'},{name:'恐慌区',min:50,range:'50–59',icon:'😰'},{name:'贪婪区',min:0,range:'<50',icon:'🟢'}] as const;
export function fearBand(score:number){return BANDS.find(b=>score>=b.min)!.name;}
export type ReportStock={symbol:string;name:string;status:string;eventDate:string|null;earningsInfo?:EarningsInfo|null;latest:Score|null;previous:Score|null};
export function summarize(stocks:ReportStock[],tradeDate:string,previousDate:string|null){
 const valid=stocks.filter(s=>s.latest?.date===tradeDate&&s.latest.score!==null&&s.latest.total!==null);
 const paired=valid.filter(s=>s.previous?.date===previousDate&&s.previous?.score!=null&&s.previous.total!==null&&s.previous.version===s.latest!.version);
 const mean=valid.length?valid.reduce((a,s)=>a+s.latest!.total!,0)/valid.length:null;
 const integerMean=valid.length?valid.reduce((a,s)=>a+s.latest!.score!,0)/valid.length:null;
 return {mean,delta:paired.length?paired.reduce((a,s)=>a+s.latest!.total!-s.previous!.total!,0)/paired.length:null,valid:valid.length,total:stocks.length,paired:paired.length,
  sigma:valid.length>1?Math.sqrt(valid.reduce((a,s)=>a+(s.latest!.score!-integerMean!)**2,0)/valid.length):null,
  range:valid.length?Math.max(...valid.map(s=>s.latest!.score!))-Math.min(...valid.map(s=>s.latest!.score!)):null,
  bands:BANDS.map(b=>({...b,count:valid.filter(s=>fearBand(s.latest!.score!)===b.name).length})),
  complete:stocks.length>0&&stocks.every(s=>s.status==='ready'&&s.latest?.date===tradeDate&&!s.earningsInfo?.calculationPending),
  warming:stocks.filter(s=>s.latest?.date===tradeDate&&s.latest.score===null).length,
  stale:stocks.filter(s=>s.latest?.date!==tradeDate).map(s=>s.symbol),failed:stocks.filter(s=>s.status!=='ready'||s.earningsInfo?.calculationPending).map(s=>s.symbol)};
}
export type ReportSnapshot={id:string;tradeDate:string;previousDate:string|null;generatedAt:string;version:string;watchlistHash:string;stocks:ReportStock[];summary:ReturnType<typeof summarize>};
const signed=(n:number|null)=>n===null?'—':`${n>0?'+':''}${n.toFixed(0)}`;
export function stockDelta(s:ReportStock){return s.latest?.score!=null&&s.previous?.score!=null&&s.latest.version===s.previous.version?s.latest.score-s.previous.score:null;}
export function contributionReasons(s:ReportStock){if(stockDelta(s)===null)return '缺少同版本前一交易日';return GROUPS.map((g,i)=>({name:g.name,value:(s.latest!.groups[i]!-s.previous!.groups[i]!)*g.weight})).filter(x=>Number.isFinite(x.value)&&Math.abs(x.value)>.05).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)).slice(0,2).map(x=>`${x.name} ${x.value>0?'+':''}${x.value.toFixed(1)}`).join(' / ')||'因子变化较小';}
export function publicBase(value:string|undefined){if(!value)return null;try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!u.hostname.includes('.')||/^(localhost|127\.|0\.|192\.168\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)||/\.(local|internal|test)$/.test(u.hostname))return null;return u.origin;}catch{return null;}}
export function upcomingEarnings(report:ReportSnapshot){const end=new Date(Date.parse(report.tradeDate+'T00:00Z')+7*86400000).toISOString().slice(0,10);return report.stocks.filter(x=>{const date=x.earningsInfo?.date??(x.earningsInfo?null:x.eventDate);const last=x.earningsInfo?.endDate??date;return !!date&&date<=end&&!!last&&last>=report.tradeDate;}).sort((a,b)=>(a.earningsInfo?.date??a.eventDate!).localeCompare(b.earningsInfo?.date??b.eventDate!));}
export function renderCard(report:ReportSnapshot,base:string|null){
 const {summary:s}=report;const valid=report.stocks.filter(x=>x.latest?.date===report.tradeDate&&x.latest.score!==null).sort((a,b)=>b.latest!.score!-a.latest!.score!);
 const stockText=(x:ReportStock)=>`${x.symbol} · $${x.latest!.price.toFixed(2)} · **${x.latest!.score}** ${signed(stockDelta(x))}\n形态：${x.latest!.form} / 筛选：${x.latest!.assessment}`;
 const md=(content:string)=>({tag:'markdown',content});
 const changes=[...valid].filter(x=>stockDelta(x)!==null).sort((a,b)=>Math.abs(stockDelta(b)!)-Math.abs(stockDelta(a)!)).slice(0,3);
 const earnings=upcomingEarnings(report);
 const elements:Record<string,unknown>[]=[md(`**美股观察池 · ${s.mean===null?'—':s.mean.toFixed(0)} ${signed(s.delta)}**\n有效 ${s.valid}/${s.total} · 比较样本 ${s.paired} · σ ${s.sigma===null?'—':s.sigma.toFixed(0)} · 极差 ${s.range??'—'}`),md(s.bands.map(b=>`${b.icon}${b.count}${b.name}`).join(' · ')),{tag:'hr'},md('**📈 最大变化**'),...changes.map(x=>md(`${stockText(x)}\n贡献：${contributionReasons(x)}`)),...BANDS.map(b=>{const rows=valid.filter(x=>fearBand(x.latest!.score!)===b.name);return {tag:'collapsible_panel',expanded:false,header:{title:{tag:'plain_text',content:`${b.icon} ${b.name}（${b.range}）· ${rows.length}只`}},elements:[md(rows.length?rows.slice(0,10).map(stockText).join('\n\n'):'暂无标的'),...(rows.length>10?[md(`另 ${rows.length-10} 只，见完整日报`)]:[])]};}),{tag:'hr'},md(`**📅 未来7自然日财报**\n${earnings.length?earnings.map(x=>`${x.symbol} · ${earningsLabel(x.earningsInfo,x.eventDate)} · ${x.earningsInfo?.sourceUrl?'['+(x.earningsInfo.source??'来源')+']('+x.earningsInfo.sourceUrl+')':x.earningsInfo?.source??'旧登记'}${x.earningsInfo?.checkedAt?' · 获取 BJ '+new Date(x.earningsInfo.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):''}${x.earningsInfo?.error?' · 来源待核对':''}`).join('\n'):'暂无已知事件'}\n日期缺失 ${report.stocks.filter(x=>x.earningsInfo?!x.earningsInfo.date:!x.eventDate).length} 只；缺失不代表没有财报。`),md(`**数据质量**\n${s.complete?'行情截面齐全':'覆盖不足，禁止自动推送'} · 预热 ${s.warming} 只\n${s.stale.length?'旧截面/缺数：'+s.stale.join('/')+'\n':''}${s.failed.length?'更新未完成：'+s.failed.join('/')+'\n':''}PCR规则待完善；当前为基础分含已知财报修正。形态与公式筛选独立。\n财报窗口暂按3自然日。来源 Yahoo Finance，基准 SPY。\n生成 BJ ${new Date(report.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`)];
 if(base)elements.push({tag:'button',text:{tag:'plain_text',content:'查看完整日报'},type:'primary',behaviors:[{type:'open_url',default_url:`${base}/reports/${report.id}`} ]});
 return {schema:'2.0',config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:`FearDesk · ${report.tradeDate} · 收盘日报`},template:'blue'},body:{elements}};
}
export function nyCutoff(now:Date){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now).map(p=>[p.type,p.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,ready:!['Sat','Sun'].includes(parts.weekday)&&Number(parts.hour)*60+Number(parts.minute)>=990};}
