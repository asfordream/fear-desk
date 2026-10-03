import {env} from 'cloudflare:workers';
import * as daily from '@/lib/daily';

// This shared writer is for this owner-private Site only. Sites dispatch validates
// OAI-Sites-Authorization before forwarding a service request; it supplies no
// visitor identity. Keep browser APIs identity-protected and this opt-in disabled
// if the Site audience changes. Never expose the dispatch token to the app/client.
function guard(req:Request){
 const config=env as typeof env & {DAILY_SERVICE_ENABLED?:string};
 if(config.DAILY_SERVICE_ENABLED!=='true')return Response.json({error:'云端任务入口未启用'},{status:403});
 const origin=req.headers.get('origin');
 if(origin&&origin!==new URL(req.url).origin)return Response.json({error:'拒绝跨站写入'},{status:403});
 return null;
}
const reply=(data:unknown)=>Response.json({data},{headers:{'Cache-Control':'no-store'}});
export async function GET(req:Request){
 const denied=guard(req);if(denied)return denied;
 try{const status=await daily.reportStatus(env);const job=status.jobs[0]??null;const delivery=job?.report_id?(await daily.readReport(String(job.report_id))).delivery:null;return reply({job,delivery});}
 catch{return Response.json({error:'云端任务状态暂不可读'},{status:503});}
}
export async function POST(req:Request){
 const denied=guard(req);if(denied)return denied;
 // Fixed daily, refresh and recovery actions only. Dates, pool and bot remain server-owned.
 try{const text=await req.text();const action=text?JSON.parse(text)?.action:null;return reply(action==='recover'?await daily.recoverLastIncomplete(env):action==='refresh'?await daily.refreshDailyInputs(env):await daily.runDaily(env));}
 catch{return Response.json({error:'云端每日任务未完成；请读取任务状态后决定重试'},{status:503});}
}
