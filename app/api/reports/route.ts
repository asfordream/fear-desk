import {env} from 'cloudflare:workers';
import {reportStatus} from '@/lib/daily';
import {admitManual,scheduleFirstSlice,drainJob} from '@/lib/daily-pipeline';
import {DailyRepository} from '@/lib/daily-repository';
import {jobDto,validRequestId} from '@/lib/daily-contract';
import {access,success,failure} from '@/lib/http';
export async function GET(req:Request){try{await access(req);const status=await reportStatus(env);return success({...status,pipeline:await new DailyRepository().status()});}catch(e){return failure(e);}}
export async function POST(req:Request){
 try{
  await access(req);
  const body=await req.json() as {action?:unknown;requestId?:unknown};
  if(!body||typeof body.action!=='string'||!['generate','continue'].includes(body.action)||Object.keys(body).some(key=>!['action','requestId'].includes(key)))throw new Error('请选择立即生成最新日报');
  const repo=new DailyRepository();
  let result;
  if(body.action==='continue'){
   if(!validRequestId(body.requestId))throw new Error('请求编号无效');
   const request=await repo.request(body.requestId);
   if(!request||request.source!=='manual'||request.send_intent!=='none')throw new Error('只能续跑已受理的手动生成请求');
   const job=await repo.job(request.job_id);if(!job)throw new Error('任务映射不完整');
   result={requestId:body.requestId,job:jobDto(job),sendIntent:'none'};
  }else result=await admitManual(body.requestId,repo);
  const firstSliceScheduled=scheduleFirstSlice(result.job.id,()=>drainJob(result.job.id,new DailyRepository(),env));
  return Response.json({data:{...result,firstSliceScheduled}},{status:202,headers:{'Cache-Control':'no-store'}});
 }catch(e){return failure(e);}
}
