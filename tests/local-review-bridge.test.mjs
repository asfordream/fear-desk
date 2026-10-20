import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { createReviewMiddleware } from '../build/local-review-plugin.mjs';

async function fixture(fn) {
  const privateServer = createServer((req,res) => {
    assert.equal(req.headers.authorization, 'Bearer '+ 's'.repeat(64));
    assert.equal(req.headers.cookie, undefined);assert.equal(req.headers.origin, undefined);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:{private:true}}));
  });
  await new Promise(r=>privateServer.listen(0,'127.0.0.1',r));
  const publicServer=createServer();await new Promise(r=>publicServer.listen(0,'127.0.0.1',r));
  const port=publicServer.address().port;
  const middleware=createReviewMiddleware({bootstrap:'b'.repeat(64),serviceToken:'s'.repeat(64),port,servicePort:privateServer.address().port});
  publicServer.on('request',(req,res)=>void middleware(req,res,()=>{res.writeHead(200);res.end('original market');}));
  const origin=`http://127.0.0.1:${port}`;
  try{await fn(origin);}finally{await Promise.all([new Promise(r=>publicServer.close(r)),new Promise(r=>privateServer.close(r))]);}
}

test('private bridge enforces session, origin, csrf and fixed target without altering market routes',async()=>fixture(async origin=>{
  assert.equal(await (await fetch(origin+'/api/desk')).text(),'original market');
  assert.equal((await fetch(origin+'/api/review/v1/demo/overview')).status,401);
  assert.equal((await fetch(origin+'/api/review/v1/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({capability:'错'.repeat(64)})})).status,403);
  const session=await fetch(origin+'/api/review/v1/session',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({capability:'b'.repeat(64)})});
  const cookie=session.headers.get('set-cookie').split(';')[0];
  assert.match(session.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const csrf=(await session.json()).data.csrf;
  assert.equal((await fetch(origin+'/api/review/v1/demo/overview',{headers:{cookie}})).status,200);
  assert.equal((await fetch(origin+'/api/review/v1/demo/overview',{headers:{cookie,origin:'http://cross.test'}})).status,403);
  const forged=await new Promise((resolve,reject)=>{const r=get(origin+'/api/review/v1/demo/overview',{headers:{cookie,host:'cross.test'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);});assert.equal(forged,403);
  assert.equal((await fetch(origin+'/api/review/v1/demo/overview',{headers:{cookie,'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(origin+'/api/review/v1/demo/cases',{method:'POST',headers:{cookie,origin},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/api/review/v1/demo/cases',{method:'POST',headers:{cookie,origin,'x-review-csrf':csrf},body:'{}'})).status,200);
  assert.equal((await fetch(origin+'/api/review/v1/demo/files/private',{headers:{cookie}})).status,404);
}));

test('unavailable private service surfaces failure, never empty financial data',async()=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  const middleware=createReviewMiddleware({bootstrap:'b'.repeat(64),serviceToken:'s'.repeat(64),port,servicePort:1});server.on('request',(req,res)=>void middleware(req,res,()=>{}));
  try{const r=await fetch(origin+'/api/review/v1/session',{method:'POST',headers:{origin},body:JSON.stringify({capability:'b'.repeat(64)})});const cookie=r.headers.get('set-cookie').split(';')[0];
    const missing=await fetch(origin+'/api/review/v1/demo/overview',{headers:{cookie}});assert.equal(missing.status,503);assert.equal((await missing.json()).error.code,'PRIVATE_SERVICE_UNAVAILABLE');
  }finally{await new Promise(r=>server.close(r));}
});

test('expired sessions can unlock again without restarting and rejected unlocks cannot renew them',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  await fixture(async origin=>{
    const unlock=capability=>fetch(origin+'/api/review/v1/session',{method:'POST',headers:{origin},body:JSON.stringify({capability})});
    const read=cookie=>fetch(origin+'/api/review/v1/session',{headers:{cookie}});
    // The service may have been idle longer than a session lifetime before first use.
    now+=13*3600_000;
    const first=await unlock('b'.repeat(64));assert.equal(first.status,200);
    const cookie=first.headers.get('set-cookie').split(';')[0],data=(await first.json()).data;
    assert.equal(Date.parse(data.expires_at),now+12*3600_000);
    assert.equal((await read(cookie)).status,200);
    now+=3600_000;
    const other=await unlock('b'.repeat(64));
    assert.equal(other.headers.get('set-cookie').split(';')[0],cookie);
    assert.equal((await other.json()).data.expires_at,data.expires_at);
    assert.equal((await read(cookie)).status,200);
    now+=11*3600_000;
    assert.equal((await read(cookie)).status,401);
    assert.equal((await unlock('wrong')).status,403);
    assert.equal((await read(cookie)).status,401);
    assert.equal((await fetch(origin+'/api/review/v1/session',{method:'POST',headers:{origin:'http://cross.test'},body:JSON.stringify({capability:'b'.repeat(64)})})).status,403);
    const renewed=await unlock('b'.repeat(64));assert.equal(renewed.status,200);
    const nextCookie=renewed.headers.get('set-cookie').split(';')[0],next=(await renewed.json()).data;
    assert.notEqual(nextCookie,cookie);assert.notEqual(next.csrf,data.csrf);
    assert.equal(Date.parse(next.expires_at),now+12*3600_000);
    assert.equal((await read(cookie)).status,401);
    assert.equal((await read(nextCookie)).status,200);
    assert.equal((await fetch(origin+'/api/review/v1/demo/cases',{method:'POST',headers:{origin,cookie:nextCookie,'x-review-csrf':data.csrf},body:'{}'})).status,403);
    assert.equal((await fetch(origin+'/api/review/v1/demo/cases',{method:'POST',headers:{origin,cookie:nextCookie,'x-review-csrf':next.csrf},body:'{}'})).status,200);
  });
});
