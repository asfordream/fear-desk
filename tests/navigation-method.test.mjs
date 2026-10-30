import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('main navigation excludes calculation shortcut',()=>{const source=readFileSync(new URL('../components/desk.tsx',import.meta.url),'utf8');const nav=source.match(/<nav aria-label="主导航">([\s\S]*?)<\/nav>/)?.[1];assert.ok(nav);assert.doesNotMatch(nav,/计算口径|#method/);assert.match(nav,/市场总览/);assert.match(nav,/收盘日报/);});
