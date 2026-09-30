export type EarningsStatus='confirmed'|'estimated'|'unavailable';
export type EarningsTiming='bmo'|'amc'|'dmh'|'unknown';
export type EarningsCandidate={date:string|null;endDate:string|null;status:EarningsStatus;timing:EarningsTiming;source:string;sourceUrl:string|null};
export type EarningsInfo=EarningsCandidate&{mode:'auto'|'manual';checkedAt:string|null;error:string|null;calculationPending?:boolean};
export const OFFICIAL_SOURCES:Record<string,string>={
 AAPL:'https://investor.apple.com/investor-relations/default.aspx',
 MSFT:'https://www.microsoft.com/en-us/Investor',
 NVDA:'https://nvidianews.nvidia.com/rss.xml',
 TSLA:'https://ir.tesla.com/',
 NFLX:'https://ir.netflix.net/rss/events.xml',
 CRDO:'https://investors.credosemi.com/rss/events.xml',
};
const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const datePattern='(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}';
export function validDate(value:string){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function nyDate(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
// Newly collected information enters calculations from the next NY calendar day.
// This conservative rule also covers early closes without rewriting an already closed day.
export function visibleDate(now=new Date()){
 return new Date(Date.parse(nyDate(now)+'T00:00Z')+86400000).toISOString().slice(0,10);
}
function englishDate(text:string){const m=text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);if(!m)return null;const month=months.indexOf(m[1].slice(0,3).toLowerCase());if(month<0)return null;const day=`${m[3]}-${String(month+1).padStart(2,'0')}-${m[2].padStart(2,'0')}`;return validDate(day)?day:null;}
export function plainText(html:string){return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|#160);/gi,' ').replace(/&amp;/gi,'&').replace(/&(?:lt|#60);/gi,'<').replace(/&(?:gt|#62);/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();}
function upcoming(day:string,from:string){return day>=from&&day<=new Date(Date.parse(from+'T00:00Z')+120*86400000).toISOString().slice(0,10);}
function timing(text:string):EarningsTiming{return /(?:after (?:the )?market close|after (?:the )?close of (?:the )?market)/i.test(text)?'amc':/(?:before (?:the )?market open|before (?:the )?opening of (?:the )?market)/i.test(text)?'bmo':'unknown';}
export function parseYahoo(html:string,symbol:string,from:string):EarningsCandidate|null{
 // Only the quote summary label is accepted, never a date in news or embedded scripts.
 const title=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??'';
 if(!new RegExp(`\\(${symbol.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\)`).test(title))throw new Error('报价页标的不匹配');
 const text=plainText(html);const value=text.match(/Earnings Date\s*(?:\(est\.\)\s*)?(.{0,110})/i)?.[1];if(!value)throw new Error('报价页缺少财报日期字段');
 const dates=[...value.matchAll(new RegExp(datePattern,'gi'))].slice(0,2).map(m=>englishDate(m[0])).filter((x):x is string=>!!x);
 // The next quote field terminates the date/range. Dates elsewhere are never used.
 const block=value.split(/Forward Dividend|Ex-Dividend|Dividend|1y Target/i)[0];
 const bounded=[...block.matchAll(new RegExp(datePattern,'gi'))].map(m=>englishDate(m[0])).filter((x):x is string=>!!x);
 if(!dates.length||!bounded.length)return null;
 const date=bounded[0],endDate=bounded[1]??null;if(!upcoming(date,from)||endDate&&(!upcoming(endDate,from)||endDate<date))return null;
 return {date,endDate,status:'estimated',timing:'unknown',source:'Yahoo Finance',sourceUrl:`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`};
}
export function parseOfficial(html:string,url:string,from:string):EarningsCandidate|null{
 const candidates:EarningsCandidate[]=[];
 // JSON-LD must describe an earnings event, not an article's publication date.
 for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const visit=(x:any)=>{if(Array.isArray(x)){x.forEach(visit);return;}if(!x||typeof x!=='object')return;
   if((x['@type']==='Event'||Array.isArray(x['@type'])&&x['@type'].includes('Event'))&&/earnings|financial results/i.test(x.name??'')){
    const day=String(x.startDate??'').slice(0,10);if(validDate(day)&&upcoming(day,from))candidates.push({date:day,endDate:null,status:'confirmed',timing:timing(x.description??''),source:'公司官方公告',sourceUrl:url});
   }if(x['@graph'])visit(x['@graph']);};visit(JSON.parse(m[1]));}catch{/* malformed structured data is ignored */}
 }
 // RSS is split by item so unrelated articles cannot supply a date.
 const items=[...html.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
 for(const item of items.length?items:[html]){
  const text=plainText(item.replace(/<!\[CDATA\[|\]\]>/g,''));
  const re=new RegExp(`(?:will (?:announce|report|release)|to (?:announce|report|release))[^.]{0,180}?(?:financial results|quarter(?:ly)? (?:results|earnings)|earnings)[^.]{0,100}?\\bon\\s+(?:[A-Za-z]+,?\\s+)?(${datePattern})`,'gi');
  for(const m of text.matchAll(re)){const day=englishDate(m[1]);if(day&&upcoming(day,from)){
   const link=item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim();let sourceUrl=url;try{if(link&&new URL(link).origin===new URL(url).origin)sourceUrl=link;}catch{}
   candidates.push({date:day,endDate:null,status:'confirmed',timing:timing(text),source:'公司官方公告',sourceUrl});
  }}
 }
 return candidates.sort((a,b)=>a.date!.localeCompare(b.date!))[0]??null;
}
async function readPublic(url:string,fetcher:typeof fetch,timeoutMs=8000){
 const r=await fetcher(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'manual',headers:{Accept:'text/html,application/rss+xml,application/json'}});
 if(!r.ok)throw new Error(`来源暂不可用（HTTP ${r.status}）`);
 const reader=r.body?.getReader();if(!reader)throw new Error('来源响应为空');let size=0;const decoder=new TextDecoder();let text='';
 try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>2_500_000)throw new Error('来源响应超过读取限制');text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();}finally{await reader.cancel();}
}
function failureReason(error:unknown){const text=error instanceof Error?error.message:'';return text.match(/HTTP \d{3}/)?.[0]??(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'请求超时':'网络或页面格式异常');}
export async function fetchEarnings(symbol:string,from:string,config:{FINNHUB_API_KEY?:string}={},fetcher:typeof fetch=fetch):Promise<{candidate:EarningsCandidate|null;error:string|null}>{
 const errors:string[]=[];const official=OFFICIAL_SOURCES[symbol];
 if(official)try{const candidate=parseOfficial(await readPublic(official,fetcher,6000),official,from);if(candidate)return {candidate,error:null};}catch(e){errors.push(`公司官网未能自动读取（${failureReason(e)}）`);}
 const yahoo=`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
 try{const candidate=parseYahoo(await readPublic(yahoo,fetcher,12000),symbol,from);if(candidate)return {candidate,error:errors.join('；')||null};}catch(e){errors.push(`Yahoo 财报日期获取失败（${failureReason(e)}）`);}
 if(config.FINNHUB_API_KEY)try{const url=new URL('https://finnhub.io/api/v1/calendar/earnings');url.search=new URLSearchParams({from,to:new Date(Date.parse(from+'T00:00Z')+90*86400000).toISOString().slice(0,10),symbol}).toString();const r=await fetcher(url,{headers:{'X-Finnhub-Token':config.FINNHUB_API_KEY},signal:AbortSignal.timeout(6000),redirect:'manual'});if(!r.ok)throw new Error();const data=await r.json() as {earningsCalendar?:{symbol:string;date:string;hour?:string}[]};if(!Array.isArray(data.earningsCalendar))throw new Error();const event=data.earningsCalendar.filter(x=>x.symbol===symbol&&validDate(x.date)&&upcoming(x.date,from)).sort((a,b)=>a.date.localeCompare(b.date))[0];if(event)return {candidate:{date:event.date,endDate:null,status:'estimated',timing:['bmo','amc','dmh'].includes(event.hour??'')?event.hour as EarningsTiming:'unknown',source:'Finnhub',sourceUrl:'https://finnhub.io/docs/api/earnings-calendar'},error:errors.join('；')||null};}catch{errors.push('Finnhub 财报日期获取失败');}
 return {candidate:null,error:errors.join('；')||null};
}
export function earningsLabel(info:EarningsInfo|null|undefined,fallback?:string|null){
 if(!info)return fallback?`${fallback} · 旧登记`:'日期待获取';
 if(!info.date)return info.error?'日期未知 · 获取失败':'日期尚未公布';
 const state=info.mode==='manual'?'人工确认':info.status==='confirmed'?'官方确认':'预计';
 const hour={bmo:'盘前',amc:'盘后',dmh:'盘中',unknown:'时段未知'}[info.timing];
 return `${info.date}${info.endDate?'–'+info.endDate:''} · ${state} · ${hour}`;
}
