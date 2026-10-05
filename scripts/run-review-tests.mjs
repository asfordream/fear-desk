import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, delimiter } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.env.REVIEW_LEDGER_PROJECT ?? resolve(root, 'review-ledger'));
const localPython = resolve(source, '.venv/bin/python');
const python = process.env.REVIEW_PYTHON ?? (existsSync(localPython) ? localPython : 'python3');
const env = {...process.env, PYTHONPATH: [resolve(source,'src'),resolve(root,'local-review'),process.env.PYTHONPATH].filter(Boolean).join(delimiter)};
for (const dir of [resolve(root,'local-review'),resolve(source,'tests')]) {
 const result=spawnSync(python,['-m','unittest','discover','-s',dir,'-p','test_*.py'],{cwd:root,env,stdio:'inherit'});
 if(result.error){console.error('Python 测试未启动，请安装 review-ledger/requirements.txt 或配置 REVIEW_PYTHON。');process.exit(1);}
 if(result.status!==0)process.exit(result.status??1);
}
