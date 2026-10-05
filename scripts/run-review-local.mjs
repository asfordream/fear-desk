import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import net from 'node:net';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.env.REVIEW_LEDGER_PROJECT ?? resolve(root, 'review-ledger'));
const python = process.env.REVIEW_PYTHON ?? resolve(source, '.venv/bin/python');
const state = resolve(process.env.REVIEW_STATE ?? resolve(root, '.review-state'));
let brokerPython=process.env.REVIEW_BROKER_PYTHON;
if(!brokerPython){
  try{const config=JSON.parse(await readFile(resolve(state,'runtime.json'),'utf8'));if(typeof config.broker_python==='string')brokerPython=config.broker_python;}catch{}
}
if (!brokerPython) {
  try {
    const found=JSON.parse(execFileSync('python3',['-c','import importlib.util,json,sys; print(json.dumps({"executable":sys.executable,"sdk":importlib.util.find_spec("futu") is not None}))'],{encoding:'utf8',timeout:3000}));
    if(found.sdk)brokerPython=found.executable;
  } catch {}
}
const webPort = Number(process.env.REVIEW_WEB_PORT ?? 5191);
const servicePort = Number(process.env.REVIEW_SERVICE_PORT ?? 18761);
if (![webPort, servicePort].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || webPort === servicePort) throw new Error('无效服务端口');
await access(resolve(source, 'src/review/accounting.py')); await access(python);
for (const port of [webPort, servicePort]) {
  await new Promise((ok, fail) => { const server = net.createServer(); server.once('error', () => fail(new Error(`端口 ${port} 已占用；没有停止或修改旧服务`))); server.listen(port, '127.0.0.1', () => server.close(ok)); });
}
await mkdir(state, { recursive: true, mode: 0o700 });
const bootstrap = randomBytes(32).toString('hex');
const serviceToken = randomBytes(32).toString('hex');
const env = { ...process.env, ...(brokerPython?{REVIEW_BROKER_PYTHON:brokerPython}:{}), PYTHONPATH: [resolve(source, 'src'), resolve(root, 'local-review')].join(':'), REVIEW_BOOTSTRAP: bootstrap,
  REVIEW_SERVICE_TOKEN: serviceToken, REVIEW_STATE: state, REVIEW_WEB_PORT: String(webPort), REVIEW_SERVICE_PORT: String(servicePort) };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 2000).unref();
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => stop());
function start(executable,args) {
  const child = spawn(executable,args,{ cwd: root, env, stdio: ['ignore','pipe','pipe'] }); children.push(child);
  // Keep output small; do not print credentials or full request URLs.
  child.stderr.on('data', data => { const value = String(data).replaceAll(bootstrap,'[redacted]').replaceAll(serviceToken,'[redacted]'); process.stderr.write(value.slice(0,1800)); });
  child.on('error', () => { console.error('子服务启动失败'); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`子服务退出 (${code})`); stop(code || 1); } });
}
start(python,[resolve(root,'local-review/service.py')]);
start(process.execPath,[resolve(root,'scripts/run-framework.mjs'),'dev','--host','127.0.0.1','--port',String(webPort),'--strictPort']);
const url = `http://127.0.0.1:${webPort}/review#local=${bootstrap}`;
await writeFile(resolve(state,'entry-url.txt'),url+'\n',{mode:0o600});
console.log(`FearDesk 两服务启动中：网页 ${webPort}，私人核算 ${servicePort}。本机解锁链接保存在 .review-state/entry-url.txt。`);
if (!process.argv.includes('--no-open')) {
  // Browser remains the only user entry; wait for readiness before opening.
  const ready = setInterval(async () => { try { const r=await fetch(`http://127.0.0.1:${webPort}/review`); if(r.ok) {clearInterval(ready);spawn('open',[url],{stdio:'ignore'});} } catch {} },1000);
  setTimeout(() => clearInterval(ready),60_000).unref();
}
