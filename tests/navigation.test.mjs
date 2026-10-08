import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

for(const name of ['updates','reports']){
 test(`${name}页导航使用原生链接，不依赖故障的客户端路由`,()=>{
  const source=readFileSync(new URL(`../components/${name}.tsx`,import.meta.url),'utf8');
  assert.doesNotMatch(source,/from\s+['"]next\/link['"]|<\/?Link\b/);
  const navigation=source.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(navigation);
  for(const href of ['/','/reports','/updates'])assert.ok(navigation.includes(`<a href="${href}"`));
  assert.match(source,/<a className="brand" href="\/">/);
  assert.match(source,/<a className="back" href="\/">/);
  assert.doesNotMatch(navigation,/onClick|preventDefault/);
 });
}
