export type BotConfig={FEISHU_WEBHOOK_URL?:string;FEISHU_SIGNING_SECRET?:string;FEISHU_SEND_ENABLED?:string;SITE_BASE_URL?:string;FINNHUB_API_KEY?:string};
export function validateWebhook(value:string){const u=new URL(value);if(u.origin!=='https://open.feishu.cn'||!/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(u.pathname)||u.search||u.hash||u.username||u.password)throw new Error('机器人地址必须是飞书群自定义机器人官方 Webhook');return u.href;}
export async function signBot(secret:string,timestamp:string){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(`${timestamp}\n${secret}`),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=await crypto.subtle.sign('HMAC',key,new Uint8Array());return btoa(String.fromCharCode(...new Uint8Array(signature)));}
export async function postCard(card:unknown,config:BotConfig,fetcher:typeof fetch=fetch):Promise<{status:'sent'|'failed'|'unknown';message:string}>{
 if(config.FEISHU_SEND_ENABLED!=='true'||!config.FEISHU_WEBHOOK_URL)throw new Error('机器人未启用；请先完成服务器凭据配置');
 const url=validateWebhook(config.FEISHU_WEBHOOK_URL);const timestamp=String(Math.floor(Date.now()/1000));
 const body=JSON.stringify({msg_type:'interactive',card,...(config.FEISHU_SIGNING_SECRET?{timestamp,sign:await signBot(config.FEISHU_SIGNING_SECRET,timestamp)}:{})});
 if(new TextEncoder().encode(body).length>28_000)throw new Error('卡片超出发送体积，请缩小观察池或使用日报链接');
 try{const res=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'manual',signal:AbortSignal.timeout(10_000)});if(res.status>=300&&res.status<400)return {status:'failed',message:'飞书端点返回重定向，已阻止向其他地址提交'};const result=await res.json() as {code?:number;StatusCode?:number};
  if(res.ok&&(result.code===0||result.StatusCode===0))return {status:'sent',message:'飞书已确认接收'};
  if(typeof result.code==='number'||typeof result.StatusCode==='number')return {status:'failed',message:`飞书拒绝请求（代码 ${result.code??result.StatusCode}）`};
  return {status:'unknown',message:'未取得明确接收结果；请核对群消息，禁止自动重发'};
 }catch{return {status:'unknown',message:'网络中断或响应无法解析；可能已发送，请先核对群消息'};}
}
