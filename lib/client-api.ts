export async function clientApi(path:string,method='GET',body?:unknown,fetcher:typeof fetch=fetch,timeoutMs=method==='GET'?20_000:90_000){
 try{
  const response=await fetcher(path,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});
  const result=await response.json().catch(()=>null) as {error?:string;data:unknown}|null;
  if(response.status===401)throw new Error('请使用 ChatGPT 登录后查看');
  if(!response.ok)throw new Error(result?.error??'请求失败，请重试');
  if(!result||!Object.hasOwn(result,'data'))throw new Error('服务响应异常，请重试');
  return result.data as any;
 }catch(error){if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))throw new Error('请求超时，请重试；已保存的数据不受影响');throw error;}
}
