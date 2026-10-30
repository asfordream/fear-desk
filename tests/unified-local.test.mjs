import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('review server reads its own signal DB, not old signal proxy',()=>{assert.doesNotMatch(read('vite.config.ts'),/localSignalProxy/);});
test('native scheduler uses single review web entry',()=>{assert.match(read('scripts/local-daily.py'),/BASE = 'http:\/\/127\.0\.0\.1:5191'/);assert.doesNotMatch(read('scripts/local-daily.py'),/127\.0\.0\.1:5173/);});
test('unified launcher keeps TLS verification and original private state override',()=>{const s=read('scripts/run-review-local.mjs');assert.match(s,/NODE_TLS_REJECT_UNAUTHORIZED:'1'/);assert.match(s,/process.env.REVIEW_STATE/);assert.match(s,/migrateLocalSignals/);});
