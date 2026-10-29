// Review uses the same loopback signal service as the native daily scheduler.
const allowed = /^\/api\/(?:desk|sync|earnings|watchlist(?:\/[^/?]+)?|stocks\/[^/?]+|reports(?:\/[a-f0-9]{64})?)$/;
export function signalProxy({enabled=false,port=5191,fetcher=fetch}={}) {
 return async (req,res,next)=>{
  const path=(req.url??'').split('?')[0];
  if(!enabled||!allowed.test(path))return next();
  const origin=`http://127.0.0.1:${port}`;
  const fail=(status,message)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:message}));};
  if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)||![undefined,'none','same-origin'].includes(req.headers['sec-fetch-site']))return fail(403,'拒绝非本机同源请求');
  if(!['GET','POST','PATCH','DELETE'].includes(req.method))return fail(405,'操作方式不支持');
  if(req.method!=='GET'&&req.headers.origin!==origin)return fail(403,'写入请求需要本机同源入口');
  try{
   const chunks=[];let size=0;
   if(req.method!=='GET')for await(const chunk of req){size+=chunk.length;if(size>2000000)return fail(413,'请求过大');chunks.push(chunk);}
   const upstream=await fetcher('http://127.0.0.1:5173'+req.url,{method:req.method,headers:{cookie:'__sites_local_auth=1','content-type':'application/json'},body:req.method==='GET'?undefined:Buffer.concat(chunks),redirect:'error',signal:AbortSignal.timeout(60000)});
   res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store','x-feardesk-source':'local-signal'});
   res.end(Buffer.from(await upstream.arrayBuffer()));
  }catch{return fail(503,'本机信号服务暂不可用；请检查信号服务，未回退到旧数据库');}
 };
}
export function localSignalProxy(){return {name:'feardesk-local-signal-source',enforce:'pre',configureServer(server){server.middlewares.use(signalProxy({enabled:!!process.env.REVIEW_BOOTSTRAP,port:Number(process.env.REVIEW_WEB_PORT??5191)}));}};}
