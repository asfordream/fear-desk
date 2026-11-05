import {earningsLabel,type EarningsInfo} from './earnings-provider.ts';
import {GROUPS,type Score} from './engine.ts';

export const CARD_FORMAT_VERSION='2.0-compact-v1';
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

export function earningsCountdown(stock:ReportStock, tradeDate:string){
 const date=stock.earningsInfo ? stock.earningsInfo.date : stock.eventDate;
 if(!date)return '';
 const days=(Date.parse(date+'T00:00Z')-Date.parse(tradeDate+'T00:00Z'))/86400000;
 return days>=0&&days<=7 ? `财报 ${date}（距财报 ${days} 天）` : '';
}

const DISPLAY_NAMES:Record<string,string>={AAPL:'苹果',TSLA:'特斯拉',NVDA:'英伟达',MSFT:'微软',AMZN:'亚马逊',GOOG:'谷歌',GOOGL:'谷歌',NFLX:'奈飞',AVGO:'博通',QCOM:'高通',ORCL:'甲骨文',MU:'美光',INTC:'英特尔',BABA:'阿里巴巴',JD:'京东',PDD:'拼多多',APP:'AppLovin',ADBE:'Adobe',COHR:'Coherent'};
export function compactName(stock:ReportStock){const name=DISPLAY_NAMES[stock.symbol]??stock.name;return name&&name!==stock.symbol?name.replace(/[\r\n<>|]/g,' ').slice(0,24):'';}
export function changeArrow(value:number|null){if(value===null)return '—';const rounded=Math.round(Math.abs(value));return rounded===0?'→0':value>0?'↑'+rounded:'↓'+rounded;}
export function reportStocks(report:ReportSnapshot){return report.stocks.filter(x=>x.latest?.date===report.tradeDate&&x.latest.score!==null&&x.latest.total!==null).sort((a,b)=>b.latest!.score!-a.latest!.score!);}
export function reportChanges(report:ReportSnapshot){return reportStocks(report).filter(x=>x.previous?.date===report.previousDate&&stockDelta(x)!==null).sort((a,b)=>Math.abs(stockDelta(b)!)-Math.abs(stockDelta(a)!)).slice(0,3);}
export function transitionLabel(stock:ReportStock,report:ReportSnapshot){if(stock.latest?.score==null||stock.previous?.score==null||stock.previous.date!==report.previousDate||stock.latest.version!==stock.previous.version)return '';const next=fearBand(stock.latest.score);return next!==fearBand(stock.previous.score)?'进入'+next:'';}
export function candidateStocks(report:ReportSnapshot){return reportStocks(report).filter(x=>x.latest!.score!>=65&&x.latest!.score!<75);}
export function bottomCluster(report:ReportSnapshot){const rows=reportStocks(report).filter(x=>fearBand(x.latest!.score!)==='底部区');return rows.length?'⚠️ 底部区 '+rows.length+' 只：'+rows.slice(0,4).map(x=>x.symbol).join('/')+(rows.length>4?' 等':''):'';}
const escapeMarkdown=(value:string)=>value.replace(/[\\*_[\]<>`]/g,'');
export function renderCard(report:ReportSnapshot,base:string|null){
 const {summary:s}=report;const valid=reportStocks(report),changes=reportChanges(report),earnings=upcomingEarnings(report);
 const md=(content:string)=>({tag:'markdown',content});
 const coloredChange=(n:number|null)=>n===null||Math.round(Math.abs(n))===0?changeArrow(n):`<font color='${n>0?'red':'green'}'>${changeArrow(n)}</font>`;
 const stockText=(x:ReportStock)=>`★ **${x.symbol}**${compactName(x)?'('+escapeMarkdown(compactName(x))+')':''} | $${x.latest!.price.toFixed(2)} | **${x.latest!.score}** ${coloredChange(stockDelta(x))} ⚡收盘 · 形态：${escapeMarkdown(x.latest!.form)}${x.latest!.assessment==='通过公式筛选'?' · ✓筛选通过':''}${earningsCountdown(x,report.tradeDate)?' · '+earningsCountdown(x,report.tradeDate).replace('财报 ',"**<font color='red'>财报</font>** "):''}`;
 const candidates=candidateStocks(report);
 const elements:Record<string,unknown>[]=[md(`**🇺🇸 美股 · 整体 ${s.mean===null?'—':s.mean.toFixed(0)} ${coloredChange(s.delta)}**\n${s.bands.map(b=>b.icon+b.count+b.name).join(' · ')}\n有效 ${s.valid}/${s.total} · σ=${s.sigma===null?'—':s.sigma.toFixed(0)} · 极差=${s.range??'—'}`),md(`🕐 收盘截面 ${report.tradeDate} · FearDesk 引擎`),...(bottomCluster(report)?[md(bottomCluster(report))]:[]),md('**📈 最大变化**\n'+(changes.length?changes.map(x=>`**${x.symbol}** | ${x.latest!.score} ${coloredChange(stockDelta(x))} ⚡收盘${transitionLabel(x,report)?' | '+transitionLabel(x,report):''}`).join('\n'):'暂无可比较标的')),md('**📊 情绪分层**'),...BANDS.map(b=>{const rows=valid.filter(x=>fearBand(x.latest!.score!)===b.name);const candidate=b.name==='击球区'&&candidates.length?'**候选区（距击球≤10）**：'+candidates.map(x=>x.symbol+' '+x.latest!.score+'（差'+(75-x.latest!.score!)+')').join(' / '):'';return md(`**${b.icon} ${b.name}（${b.range}）· ${rows.length}只**\n${rows.length?rows.map(stockText).join('\n'):'暂无标的'}${candidate?'\n'+candidate:''}`);}),{tag:'hr'},md(`**📅 近期财报 · 未来7自然日**\n${earnings.length?earnings.map(x=>x.symbol+' | '+earningsLabel(x.earningsInfo,x.eventDate)+(x.earningsInfo?.sourceUrl?' | ['+(x.earningsInfo.source??'来源')+']('+x.earningsInfo.sourceUrl+')':'' )+(x.earningsInfo?.error?' · 来源待核对':'')).join('\n'):'暂无已知事件'}\n日期缺失 ${report.stocks.filter(x=>x.earningsInfo?!x.earningsInfo.date:!x.eventDate).length}只；未知不代表没有财报。`),md(`**数据状态**\n${s.complete?'行情截面齐全':'覆盖不足，禁止自动推送'} · 预热 ${s.warming}只 · 比较样本 ${s.paired}\n${s.stale.length?'旧截面/缺数：'+s.stale.join('/')+'\n':''}${s.failed.length?'更新未完成：'+s.failed.join('/')+'\n':''}恐慌值与形态独立；筛选通过标记独立展示。PCR待完善，含已知财报修正（3自然日窗口）。\nYahoo Finance · SPY基准 · 生成 BJ ${new Date(report.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`)];
 if(base)elements.push({tag:'button',text:{tag:'plain_text',content:'查看完整日报'},type:'primary',behaviors:[{type:'open_url',default_url:base+'/reports/'+report.id}]});
 return {schema:'2.0',config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'FearDesk · '+report.tradeDate+' · 收盘日报'},template:'blue'},body:{elements}};
}
export function nyCutoff(now:Date){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(now).map(p=>[p.type,p.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,ready:!['Sat','Sun'].includes(parts.weekday)&&Number(parts.hour)*60+Number(parts.minute)>=990};}

// Beijing 14:00 always corresponds to the previous US calendar day's close.
// Weekday gating plus exact SPY date verification in runDaily handles holidays.
export function beijingReportCutoff(now:Date){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
 const day=new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day))-86400000);
 return {date:day.toISOString().slice(0,10),ready:day.getUTCDay()>=1&&day.getUTCDay()<=5&&Number(parts.hour)*60+Number(parts.minute)>=840};
}


export const FORM_NOTES:Record<string,string>={
 '观察期':'形态样本不足20个交易日。',
 '常驻':'最近20个交易日中，至少11天恐慌值达到70。',
 '转换观察':'未归为常驻，且最近连续至少5个交易日恐慌值达到70。',
 '脉冲':'未归为前两类，最近20日内出现恐慌值达到70，随后最多10日内回落到55以下。',
 '中性':'最近20个交易日未满足常驻、转换观察或脉冲条件。'
};
