import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const config={};let runs=0;
globalThis.__cloudDailyConfig=config;
globalThis.__cloudDailyRun=async()=>{runs++;return {status:'ready',message:'当日已发送，未重复提交'};};
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.__cloudDailyConfig',shortCircuit:true};
 if(specifier==='@/lib/daily')return {url:'data:text/javascript,export const runDaily=globalThis.__cloudDailyRun;export async function reportStatus(){return {jobs:[{id:"job1",status:"ready",report_id:"report1"}]}};export async function readReport(){return {delivery:{status:"sent"}}}',shortCircuit:true};
 return next(specifier,context);
}});
const {GET,POST}=await import('../app/api/jobs/daily/route.ts');
after(()=>{hooks.deregister();delete globalThis.__cloudDailyConfig;delete globalThis.__cloudDailyRun;});
test('云端入口缺省关闭，不执行任务',async()=>{delete config.DAILY_SERVICE_ENABLED;assert.equal((await POST(new Request('https://desk.example.com/api/jobs/daily',{method:'POST'}))).status,403);assert.equal(runs,0);});
test('明确启用的私有站点入口不依赖访客登录，只执行固定每日任务',async()=>{config.DAILY_SERVICE_ENABLED='true';const res=await POST(new Request('https://desk.example.com/api/jobs/daily',{method:'POST',body:JSON.stringify({date:'2000-01-01',webhook:'https://evil.example'})}));assert.equal(res.status,200);assert.equal(runs,1);assert.equal((await res.json()).data.status,'ready');});
test('跨站写入被拒绝，云端可以读取实际发送状态',async()=>{const before=runs;assert.equal((await POST(new Request('https://desk.example.com/api/jobs/daily',{method:'POST',headers:{origin:'https://evil.example'}}))).status,403);assert.equal(runs,before);const result=await GET(new Request('https://desk.example.com/api/jobs/daily'));assert.equal(result.status,200);assert.equal((await result.json()).data.delivery.status,'sent');});
