import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
for(const name of ['desk','reports','updates','review-desk'])test(`${name} retains review entry in main navigation`,()=>{const source=readFileSync(new URL(`../components/${name}.tsx`,import.meta.url),'utf8');const nav=source.match(/<nav aria-label="主导航">([\s\S]*?)<\/nav>/)?.[1];assert.ok(nav);assert.match(nav,/<a href="\/rules"[^>]*>交易规则与观察<\/a>/);assert.match(nav,/<a href="\/review"[^>]*>复盘总览<\/a>/);});
