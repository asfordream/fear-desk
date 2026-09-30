import {getChatGPTUser} from '@/app/chatgpt-auth';
export async function access(req:Request){if(!await getChatGPTUser())throw new Error('AUTH_REQUIRED');if(req.method!=='GET'){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new Error('拒绝跨站写入');}}
export const success=(data:unknown)=>Response.json({data},{headers:{'Cache-Control':'no-store'}});
export function failure(e:unknown){const message=e instanceof Error?e.message:'服务暂不可用';console.error('FearDesk request:',message);return Response.json({error:message==='AUTH_REQUIRED'?'请使用 ChatGPT 登录后查看':message},{status:message==='AUTH_REQUIRED'?401:400,headers:{'Cache-Control':'no-store'}});}
