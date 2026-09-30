import {env} from 'cloudflare:workers';
import {readReport,sendReport} from '@/lib/daily';
import {access,success,failure} from '@/lib/http';
type Context={params:Promise<{id:string}>};
export async function GET(req:Request,ctx:Context){try{await access(req);const saved=await readReport((await ctx.params).id);if(new URL(req.url).searchParams.get('download')==='card')return new Response(JSON.stringify({msg_type:'interactive',card:saved.card},null,2),{headers:{'Content-Type':'application/json;charset=utf-8','Content-Disposition':`attachment; filename="feardesk-${saved.snapshot.tradeDate}.json"`,'Cache-Control':'no-store'}});return success(saved);}catch(e){return failure(e);}}
export async function POST(req:Request,ctx:Context){try{await access(req);return success(await sendReport((await ctx.params).id,env));}catch(e){return failure(e);}}
