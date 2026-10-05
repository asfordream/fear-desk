// Local QA wrapper: never echo the generated entry capability in browser diagnostics.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const entry=(await readFile(new URL('../.review-state/entry-url.txt',import.meta.url),'utf8')).trim();
const secret=new URL(entry).hash.slice(7);
const args=process.argv.slice(2);
const actual=args[0]==='entry'?['goto',entry]:args;
const r=spawnSync('/Users/zhoujiqing/.codex/skills/gstack/browse/dist/browse',actual,{encoding:'utf8',timeout:30000});
for(const value of [r.stdout,r.stderr])if(value)process.stdout.write(value.replaceAll(secret,'[generated-local-capability]'));
process.exit(r.status??1);
