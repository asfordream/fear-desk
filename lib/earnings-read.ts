import {getRawDb} from '@/db';
import {nyDate,type EarningsInfo} from './earnings-provider';
export type CalendarRow={symbol:string;date:string|null;end_date:string|null;status:EarningsInfo['status'];timing:EarningsInfo['timing'];source:string;source_url:string|null;mode:EarningsInfo['mode'];checked_at:string|null;next_check:number;error:string|null;revision:number;write_token:string|null;needs_recompute:number};
const db=()=>getRawDb();
export async function calendar(symbol:string){return db().prepare('SELECT * FROM earnings_calendar WHERE symbol=?').bind(symbol).first<CalendarRow>();}
export function calendarInfo(row:CalendarRow|null,day=nyDate()):EarningsInfo|null{
 if(!row)return null;const future=!!row.date&&(row.end_date??row.date)>=day;
 return {date:future?row.date:null,endDate:future?row.end_date:null,status:future?row.status:'unavailable',timing:row.timing,source:row.source,sourceUrl:row.source_url,mode:row.mode,checkedAt:row.checked_at,error:row.needs_recompute?[row.error,'财报修正重算待恢复'].filter(Boolean).join('；'):row.error,calculationPending:!!row.needs_recompute};
}
export async function readEarnings(symbol:string){return calendarInfo(await calendar(symbol));}
