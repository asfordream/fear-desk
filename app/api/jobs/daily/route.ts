import {env} from 'cloudflare:workers';
import {DailyRepository} from '@/lib/daily-repository';
import {admitScheduled,drainJob,resumeExisting,originalScheduledDelivery,scheduleFirstSlice} from '@/lib/daily-pipeline';

function guard(req:Request){
 const config=env as typeof env&{DAILY_SERVICE_ENABLED?:string};
 if(config.DAILY_SERVICE_ENABLED!=='true')return Response.json({error:'云端任务入口未启用'},{status:403});
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return Response.json({error:'拒绝跨站写入'},{status:403});
 return null;
}
const reply=(data:unknown,status=200)=>Response.json({data},{status,headers:{'Cache-Control':'no-store'}});
export async function GET(req:Request){const denied=guard(req);if(denied)return denied;try{return reply(await new DailyRepository().status());}catch{return Response.json({error:'云端任务状态暂不可读'},{status:503});}}
export async function POST(req:Request){
 const denied=guard(req);if(denied)return denied;
 try{
  const body=await req.json() as {action?:unknown;requestId?:unknown};
  if(!body||typeof body.action!=='string'||!['daily','resume_existing'].includes(body.action)||Object.keys(body).some(key=>!['action','requestId'].includes(key)))return Response.json({error:'请选择 daily 或 resume_existing'},{status:400});
  const repo=new DailyRepository();
  if(body.action==='resume_existing'){
   if(body.requestId!==undefined)return Response.json({error:'恢复入口不接受新请求身份'},{status:400});
   return reply(await resumeExisting(repo,env));
  }
  const accepted=await admitScheduled(env,repo,new Date(),body.requestId);
  if('status' in accepted)return reply(accepted);
  if(['ready','reused'].includes(accepted.job.status)){
   return reply({requestId:accepted.requestId,job:accepted.job,
    delivery:await originalScheduledDelivery(accepted.requestId,env,repo)});
  }
  // Use the same request-scoped continuation as the working manual generation
  // endpoint. A scheduler HTTP timeout must not cancel the leased computation.
  const firstSliceScheduled=scheduleFirstSlice(accepted.job.id,async()=>{
   await drainJob(accepted.job.id,new DailyRepository(),env);
   await originalScheduledDelivery(accepted.requestId,env,new DailyRepository());
  });
  return reply({requestId:accepted.requestId,firstSliceScheduled,job:accepted.job,
   delivery:{status:'pending',message:'发送在后台生成完成后独立核对；受理不表示已送达'},
   continuation:{action:'daily',requestId:accepted.requestId,pollAfterSeconds:3}},firstSliceScheduled?202:503);
 }catch{return Response.json({error:'本次执行未完成；持久任务与检查点保留，请读取状态'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
