import {env} from 'cloudflare:workers';
import {refreshEarnings,editEarnings} from '@/lib/earnings';
import {ticker} from '@/lib/provider';
import {access,success,failure} from '@/lib/http';
export async function POST(req:Request){try{await access(req);const body=await req.json() as Record<string,unknown>;if(!body||typeof body!=='object'||body.force!==undefined&&typeof body.force!=='boolean')throw new Error('请求格式无效');return success(await refreshEarnings(env,body.symbol?ticker(body.symbol):undefined,body.force===true));}catch(e){return failure(e);}}
export async function PATCH(req:Request){try{await access(req);const body=await req.json() as Record<string,unknown>;if(!body||typeof body!=='object'||!['manual','auto'].includes(String(body.mode))||body.date!==null&&typeof body.date!=='string')throw new Error('请输入日期和获取模式');const symbol=ticker(body.symbol);const result=await editEarnings(symbol,body.date as string|null,body.mode as 'manual'|'auto');if(body.mode==='auto')await refreshEarnings(env,symbol,true);return success(result);}catch(e){return failure(e);}}
