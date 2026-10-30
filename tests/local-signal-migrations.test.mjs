import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,readdirSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {migrateSignalDatabase,migrateLocalSignals} from '../scripts/local-signal-migrations.mjs';

const root=path.resolve(import.meta.dirname,'..');
const migrations=path.join(root,'drizzle');
function fixture(prefix='0004'){
 const dir=mkdtempSync(path.join(tmpdir(),'review-signal-schema-'));
 const file=path.join(dir,'signal.sqlite');const db=new DatabaseSync(file);
 for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')&&n.slice(0,4)<=prefix).sort())db.exec(readFileSync(path.join(migrations,name),'utf8'));
 db.exec("INSERT INTO instruments(symbol,name,active,status) VALUES('AAA','Test',1,'ready'); INSERT INTO reports(id,trade_date,created_at,payload,card,complete) VALUES('old-report','2026-10-01','2026-10-02','{}','{}',1)");
 db.close();return {dir,file};
}
test('旧本地库升级后可读取新版日报任务，保留历史并备份；重复启动零迁移',async()=>{
 const {dir,file}=fixture();try{
  const result=await migrateSignalDatabase(file,migrations,path.join(dir,'backups'));
  assert.equal(result.applied,3);assert.ok(result.backup);
  const db=new DatabaseSync(file);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_runs WHERE pipeline_version=2").get().n,0);
  assert.equal(db.prepare("SELECT id FROM reports").get().id,'old-report');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
  const saved=new DatabaseSync(result.backup,{readOnly:true});assert.ok(!saved.prepare('PRAGMA table_info(job_runs)').all().some(c=>c.name==='pipeline_version'));saved.close();
  assert.equal((await migrateSignalDatabase(file,migrations,path.join(dir,'backups'))).applied,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('新版本地库不会重复ALTER，空数据库可初始化',async()=>{
 const {dir,file}=fixture('0007');try{
  assert.equal((await migrateSignalDatabase(file,migrations,path.join(dir,'backups'))).applied,0);
  const empty=path.join(dir,'empty.sqlite');new DatabaseSync(empty).close();
  assert.equal((await migrateSignalDatabase(empty,migrations,path.join(dir,'backups'))).applied,8);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('未知或部分升级的结构拒绝猜测，不修改已有数据',async()=>{
 const {dir,file}=fixture();try{
  const db=new DatabaseSync(file);db.exec('ALTER TABLE job_runs ADD pipeline_version INTEGER');db.close();
  await assert.rejects(migrateSignalDatabase(file,migrations,path.join(dir,'backups')),/结构/);
  const check=new DatabaseSync(file);assert.equal(check.prepare('SELECT COUNT(*) n FROM reports').get().n,1);assert.ok(!check.prepare("SELECT 1 FROM sqlite_master WHERE name='daily_requests'").get());check.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('只定位本项目64位本地D1库；多个候选不自动选择',async()=>{
 const {dir,file}=fixture();try{
  const dest=path.join(dir,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');mkdirSync(dest,{recursive:true});
  const {copyFileSync}=await import('node:fs');copyFileSync(file,path.join(dest,'a'.repeat(64)+'.sqlite'));
  const migrated=await migrateLocalSignals(dir,migrations);assert.equal(migrated.applied,3);
  copyFileSync(file,path.join(dest,'b'.repeat(64)+'.sqlite'));
  await assert.rejects(migrateLocalSignals(dir,migrations),/多个/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('迁移SQL无效时旧库保持原样；启动器在服务启动前检查结构',async()=>{
 const {dir,file}=fixture();try{
  const broken=path.join(dir,'broken');mkdirSync(broken);
  for(const n of readdirSync(migrations).filter(n=>n.endsWith('.sql')))writeFileSync(path.join(broken,n),readFileSync(path.join(migrations,n)));
  writeFileSync(path.join(broken,'0008_invalid.sql'),'INVALID SQL;');
  await assert.rejects(migrateSignalDatabase(file,broken,path.join(dir,'backups')));
  const db=new DatabaseSync(file);assert.ok(!db.prepare('PRAGMA table_info(job_runs)').all().some(c=>c.name==='pipeline_version'));db.close();
  const launcher=readFileSync(path.join(root,'scripts/run-review-local.mjs'),'utf8');
  assert.ok(launcher.indexOf('await migrateLocalSignals(root)')<launcher.indexOf('start(python,'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
