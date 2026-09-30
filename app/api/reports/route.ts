import {env} from 'cloudflare:workers';
import {generateReport,reportStatus,runDaily} from '@/lib/daily';
import {access,success,failure} from '@/lib/http';
export async function GET(req:Request){try{await access(req);return success(await reportStatus(env));}catch(e){return failure(e);}}
export async function POST(req:Request){try{await access(req);const body=await req.json() as {action?:string};if(body?.action==='preview')return success(await generateReport(env));if(body?.action==='run')return success(await runDaily(env));throw new Error('请选择生成预览或运行每日更新');}catch(e){return failure(e);}}
