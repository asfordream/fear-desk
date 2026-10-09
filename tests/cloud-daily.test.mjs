import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const config={};let admissions=0,resumes=0,sends=0;const pending=[];let contextAvailable=true;
globalThis.__cloudSchedule=(_id,execute)=>{if(!contextAvailable)return false;pending.push(Promise.resolve().then(execute));return true;};
globalThis.__cloudDailyConfig=config;
globalThis.__cloudAdmit=async()=>{admissions++;return {requestId:'original-schedule-request',job:{id:'job1',status:globalThis.__cloudJobStatus??'queued'}};};
globalThis.__cloudResume=async()=>{resumes++;return {advanced:1,status:{jobs:[]}};};
globalThis.__cloudSend=async()=>{sends++;return {status:'not_requested'};};
const hooks=registerHooks({resolve(specifier,context,next){
 if(specifier==='@/lib/daily-contract')return {url:'data:text/javascript,export const jobDto=x=>x',shortCircuit:true};
 if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.__cloudDailyConfig',shortCircuit:true};
 if(specifier==='@/lib/daily-repository')return {url:'data:text/javascript,export class DailyRepository{async status(){return {current:null,jobs:[{id:"job1",status:"queued"}]}}}',shortCircuit:true};
 if(specifier==='@/lib/daily-pipeline')return {url:'data:text/javascript,export const admitScheduled=globalThis.__cloudAdmit;export const resumeExisting=globalThis.__cloudResume;export const originalScheduledDelivery=globalThis.__cloudSend;export const scheduleFirstSlice=globalThis.__cloudSchedule;export async function drainJob(...args){globalThis.__cloudDrainBudget=args[4];return {advanced:1,job:{id:"job1",status:globalThis.__cloudDrainStatus??"queued"}}}',shortCircuit:true};
 return next(specifier,context);
}});
const {GET,POST}=await import('../app/api/jobs/daily/route.ts');
after(()=>{hooks.deregister();delete globalThis.__cloudDailyConfig;delete globalThis.__cloudAdmit;delete globalThis.__cloudResume;delete globalThis.__cloudSend;});
const request=(body,origin)=>new Request('https://desk.example.com/api/jobs/daily',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
test('服务入口默认关闭；未知或空action不回落生成',async()=>{
 assert.equal((await POST(request({action:'daily'}))).status,403);config.DAILY_SERVICE_ENABLED='true';
 for(const body of [{},{action:['resume_existing']},{action:['daily']},{action:null},{action:123},{action:{}},{action:'recover'},{action:'refresh'},{action:'bogus'},{action:'daily',date:'2000-01-01'}])assert.equal((await POST(request(body))).status,400);
 assert.equal(admissions,0);assert.equal(sends,0);
});
test('小时入口只能续已有，不受理新任务或发送，不接受requestId',async()=>{
 assert.equal((await POST(request({action:'resume_existing',requestId:'new'}))).status,400);
 assert.equal((await POST(request({action:'resume_existing'}))).status,200);
 assert.equal(resumes,1);assert.equal(admissions,0);assert.equal(sends,0);
});
test('原daily入口保留独立原发送路径；跨站拒绝，GET零执行',async()=>{
 const response=await POST(request({action:'daily'}));assert.equal(response.status,202);const data=(await response.json()).data;assert.equal(globalThis.__cloudDrainBudget,45000);assert.equal(data.delivery.status,'pending');assert.equal(data.continuation.requestId,data.requestId);await Promise.all(pending.splice(0));assert.equal(admissions,1);assert.equal(sends,0);
 assert.equal((await POST(request({action:'daily'},'https://evil.example'))).status,403);assert.equal(admissions,1);
 assert.equal((await GET(new Request('https://desk.example.com/api/jobs/daily'))).status,200);assert.equal(resumes,1);assert.equal(sends,0);
});

test('定时续跑不依赖浏览器后台上下文',async()=>{contextAvailable=false;const response=await POST(request({action:'daily'}));assert.equal(response.status,202);const data=(await response.json()).data;assert.equal(data.job.status,'queued');assert.equal(data.continuation.pollAfterSeconds,0);assert.equal(sends,0);});

test('已生成日报直接返回原排程投递结果，不要求重新计算或后台上下文',async()=>{globalThis.__cloudJobStatus='ready';const response=await POST(request({action:'daily'}));assert.equal(response.status,200);const data=(await response.json()).data;assert.equal(data.job.status,'ready');assert.equal(data.delivery.status,'not_requested');assert.equal(sends,1);delete globalThis.__cloudJobStatus;});

test('定时续跑返回已推进的状态并在同次请求完成投递检查',async()=>{
 contextAvailable=true;globalThis.__cloudDrainStatus='ready';
 const before=sends;const response=await POST(request({action:'daily'}));const data=(await response.json()).data;
 assert.equal(response.status,200);assert.equal(data.job.status,'ready');assert.equal(sends,before+1);assert.equal(globalThis.__cloudDrainBudget,45000);
 delete globalThis.__cloudDrainStatus;
});
