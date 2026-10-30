import {DatabaseSync,backup} from 'node:sqlite';
import {readdir,readFile,mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';

function schema(database){
 return JSON.stringify(database.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all()
  .map(row=>[row.type,row.name,row.sql.replace(/[\s`"\[\]]/g,'').toLowerCase()]));
}

// Local only. Match a complete known migration prefix before touching a saved
// database; a partial or unfamiliar schema requires investigation, not guessing.
export async function migrateSignalDatabase(filename,migrationsDirectory,backupsDirectory){
 const files=(await readdir(migrationsDirectory)).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
 const statements=await Promise.all(files.map(name=>readFile(path.join(migrationsDirectory,name),'utf8')));
 const expected=new DatabaseSync(':memory:');const prefixes=[schema(expected)];
 try{for(const sql of statements){expected.exec(sql);prefixes.push(schema(expected));}}finally{expected.close();}
 const database=new DatabaseSync(filename);
 try{
  database.exec('PRAGMA busy_timeout=5000');
  if(database.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('本地信号数据库完整性检查失败');
  const current=schema(database),prefix=prefixes.lastIndexOf(current);
  if(prefix<0)throw new Error('本地信号数据库结构不是已知的完整版本；未修改旧库');
  if(prefix===files.length)return {applied:0,backup:null};
  await mkdir(backupsDirectory,{recursive:true,mode:0o700});
  const snapshot=path.join(backupsDirectory,`signal-${Date.now()}-${process.pid}.sqlite`);
  await backup(database,snapshot);await chmod(snapshot,0o600);
  database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try{
   // Another process must not have changed the schema while the backup ran.
   if(schema(database)!==current)throw new Error('本地数据库结构已变化，请重新启动');
   for(const sql of statements.slice(prefix))database.exec(sql);
   if(schema(database)!==prefixes.at(-1))throw new Error('本地迁移后结构验证失败');
   if(database.prepare('PRAGMA foreign_key_check').all().length)throw new Error('本地迁移外键验证失败');
   database.exec('COMMIT');
  }catch(error){database.exec('ROLLBACK');throw error;}
  return {applied:files.length-prefix,backup:snapshot};
 }finally{database.close();}
}

export async function migrateLocalSignals(root,migrationsDirectory=path.join(root,'drizzle')){
 const localDirectory=path.join(root,'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
 let names;try{names=await readdir(localDirectory);}catch(error){if(error.code==='ENOENT')return {applied:0,backup:null};throw error;}
 const candidates=[];
 for(const name of names.filter(n=>/^[a-f0-9]{64}\.sqlite$/.test(n))){
  const filename=path.join(localDirectory,name),database=new DatabaseSync(filename,{readOnly:true});
  try{if(database.prepare("SELECT 1 FROM sqlite_master WHERE name='instruments'").get())candidates.push(filename);}finally{database.close();}
 }
 if(candidates.length>1)throw new Error('发现多个本地信号数据库，需先核对；未自动迁移');
 if(!candidates.length)return {applied:0,backup:null};
 return migrateSignalDatabase(candidates[0],migrationsDirectory,path.join(root,'.wrangler/backups'));
}
