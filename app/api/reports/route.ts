import {env} from 'cloudflare:workers';
import {reportStatus} from '@/lib/daily';
import {admitManual,scheduleFirstSlice,drainJob} from '@/lib/daily-pipeline';
import {DailyRepository} from '@/lib/daily-repository';
import {access,success,failure} from '@/lib/http';
export async function GET(req:Request){try{await access(req);const status=await reportStatus(env);return success({...status,pipeline:await new DailyRepository().status()});}catch(e){return failure(e);}}
export async function POST(req:Request){
 try{
  await access(req);
  const body=await req.json() as {action?:unknown;requestId?:unknown};
  if(!body||body.action!=='generate'||Object.keys(body).some(key=>!['action','requestId'].includes(key)))throw new Error('请选择立即生成最新日报');
  const result=await admitManual(body.requestId);
  const firstSliceScheduled=scheduleFirstSlice(result.job.id,()=>drainJob(result.job.id,new DailyRepository(),env));
  return Response.json({data:{...result,firstSliceScheduled}},{status:202,headers:{'Cache-Control':'no-store'}});
 }catch(e){return failure(e);}
}
