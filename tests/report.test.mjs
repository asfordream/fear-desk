import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {summarize,renderCard,nyCutoff,beijingReportCutoff,publicBase,stockDelta} from '../lib/report.ts';
import {signBot,postCard,validateWebhook} from '../lib/feishu.ts';
const score=(date,value,total=value,version='v1')=>({date,score:value,total,base:total,groups:[50,50,50,50],price:100,priceChange:0,form:'中性',assessment:'未通过 · 恐慌值低于70',earnings:'财报日期未接入',version,metrics:{}});
const stock=(symbol,value,total=value)=>({symbol,name:symbol,status:'ready',eventDate:null,latest:score('2026-09-29',value,total),previous:score('2026-09-28',value-3,total-3)});
test('整体采用未取整分，分区与总体标准差使用整数分',()=>{const s=summarize([stock('A',75,74.6),stock('B',50,49.6)],'2026-09-29','2026-09-28');assert.equal(s.mean,62.099999999999994);assert.equal(s.delta,3);assert.equal(s.sigma,12.5);assert.equal(s.range,25);assert.deepEqual(s.bands.map(x=>x.count),[1,0,1,0]);});
test('缺数、旧日期、不同版本不会计入每日比较',()=>{const a=stock('A',60);a.previous.date='2026-09-25';const b=stock('B',70);b.previous.version='v0';const c=stock('C',50);c.latest=null;const s=summarize([a,b,c],'2026-09-29','2026-09-28');assert.equal(s.paired,0);assert.equal(s.delta,null);assert.equal(s.complete,false);assert.deepEqual(s.stale,['C']);assert.equal(stockDelta(b),null);});
test('空池、单个有效标的、预热都保留缺数语义',()=>{assert.equal(summarize([],'2026-09-29',null).complete,false);assert.equal(summarize([stock('A',50)],'2026-09-29','2026-09-28').sigma,null);const a=stock('A',null);a.latest.total=null;assert.equal(summarize([a],'2026-09-29','2026-09-28').warming,1);});
test('纽约时间夏令/冬令、周末、收盘前判断',()=>{assert.equal(nyCutoff(new Date('2026-09-29T20:29:00Z')).ready,false);assert.equal(nyCutoff(new Date('2026-09-29T20:30:00Z')).ready,true);assert.equal(nyCutoff(new Date('2026-12-01T20:30:00Z')).ready,false);assert.equal(nyCutoff(new Date('2026-12-01T21:30:00Z')).ready,true);assert.equal(nyCutoff(new Date('2026-10-03T22:30:00Z')).ready,false);});
test('公网地址与机器人端点拒绝本地地址和自定义主机',()=>{for(const url of ['http://example.com','https://localhost','https://127.0.0.1','https://192.168.1.5','https://a.local','https://example.com?key=1','https://u:p@example.com'])assert.equal(publicBase(url),null);assert.equal(publicBase('https://desk.example.com/'),'https://desk.example.com');assert.throws(()=>validateWebhook('https://other.example/bot'));assert.throws(()=>validateWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/a?x=1'));});
test('卡片遵循2.0结构，形态和分区独立，冻结链接无localhost',()=>{const stocks=[stock('A',60)];const r={id:'a'.repeat(64),tradeDate:'2026-09-29',previousDate:'2026-09-28',generatedAt:'2026-09-30T00:00Z',version:'v1',watchlistHash:'x',stocks,summary:summarize(stocks,'2026-09-29','2026-09-28')};const card=renderCard(r,null);assert.equal(card.schema,'2.0');assert.equal(card.body.elements.filter(x=>x.tag==='collapsible_panel').length,4);assert.match(JSON.stringify(card),/形态：中性/);assert.doesNotMatch(JSON.stringify(card),/localhost/);assert.match(JSON.stringify(renderCard(r,'https://desk.example.com')),new RegExp('/reports/'+r.id));});
test('签名使用timestamp+换行+secret作为key，对空消息做HMAC',async()=>{assert.equal(await signBot('test-secret','1000'),createHmac('sha256','1000\ntest-secret').update('').digest('base64'));});
const config={FEISHU_SEND_ENABLED:'true',FEISHU_WEBHOOK_URL:'https://open.feishu.cn/open-apis/bot/v2/hook/test-id'};
test('发送默认关闭，明确确认才成功，超时或未知响应保持unknown',async()=>{await assert.rejects(postCard({},{}),/未启用/);for(const body of [{code:0},{StatusCode:0}])assert.equal((await postCard({},config,async()=>Response.json(body))).status,'sent');assert.equal((await postCard({},config,async()=>Response.json({code:19024}))).status,'failed');assert.equal((await postCard({},config,async()=>Response.json({}))).status,'unknown');assert.equal((await postCard({},config,async()=>{throw new Error('includes a secret URL')})).status,'unknown');});
test('UTF8卡片大小先检查，不向网络提交',async()=>{let called=false;await assert.rejects(postCard({content:'股'.repeat(10000)},config,async()=>{called=true;}),/体积/);assert.equal(called,false);});

test('飞书发送使用Worker支持的manual重定向模式，不跟随到其他地址',async()=>{const result=await postCard({},config,async(url,options)=>{assert.equal(options.redirect,'manual');return Response.json({code:0});});assert.equal(result.status,'sent');assert.equal((await postCard({},config,async()=>new Response(null,{status:302,headers:{location:'https://other.example/'}}))).status,'failed');});

test('北京时间14点边界、周一跳过、周六对应周五及冬夏令时间不变',()=>{
 assert.deepEqual(beijingReportCutoff(new Date('2026-09-30T05:59:00Z')),{date:'2026-09-29',ready:false});
 assert.deepEqual(beijingReportCutoff(new Date('2026-09-30T06:00:00Z')),{date:'2026-09-29',ready:true});
 assert.deepEqual(beijingReportCutoff(new Date('2026-10-03T06:00:00Z')),{date:'2026-10-02',ready:true});
 assert.equal(beijingReportCutoff(new Date('2026-10-04T06:00:00Z')).ready,false);
 assert.equal(beijingReportCutoff(new Date('2026-10-05T06:00:00Z')).ready,false);
 assert.deepEqual(beijingReportCutoff(new Date('2026-12-01T06:00:00Z')),{date:'2026-11-30',ready:true});
 assert.deepEqual(beijingReportCutoff(new Date('2027-01-01T06:00:00Z')),{date:'2026-12-31',ready:true});
});
test('飞书展开分区包含超过10只的全部标的，45只卡片在发送体积限制内',async()=>{
 const stocks=Array.from({length:45},(_,i)=>stock('TEST'+i,45));
 const r={id:'a'.repeat(64),tradeDate:'2026-09-29',previousDate:'2026-09-28',generatedAt:'2026-09-30T06:00Z',version:'v1',watchlistHash:'x',stocks,summary:summarize(stocks,'2026-09-29','2026-09-28')};
 const card=renderCard(r,'https://desk.example.com');assert.match(JSON.stringify(card),/TEST44/);
 let called=false;assert.equal((await postCard(card,config,async()=>{called=true;return Response.json({code:0});})).status,'sent');assert.equal(called,true);
});
