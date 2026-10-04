import test from 'node:test';
import assert from 'node:assert/strict';
import {ReportReader,reportPollDelay} from '../lib/report-reader.ts';
test('旧响应与取消不能替换新完整读取，当前读取错误保留上层旧内容',async()=>{
 const reader=new ReportReader(),first=Promise.withResolvers(),second=Promise.withResolvers();
 const slow=reader.read(async()=>first.promise),fast=reader.read(async()=>second.promise);
 second.resolve({id:'new',snapshot:'new'});assert.deepEqual(await fast,{id:'new',snapshot:'new'});first.resolve({id:'old'});assert.equal(await slow,null);
 const pending=reader.read(async()=>new Promise(resolve=>setTimeout(()=>resolve('late'),5)));reader.cancel();assert.equal(await pending,null);
 await assert.rejects(reader.read(async()=>{throw new Error('offline');}),/offline/);
 assert.equal(reportPollDelay(true),5000);assert.equal(reportPollDelay(false),30000);
});
