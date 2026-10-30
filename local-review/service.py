"""Loopback-only private API. No broker order, SQL, shell or filesystem endpoint."""
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
import asyncio
import json
import os
import secrets
import sqlite3
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from domain import (database,Fault,fail,identity,number,get,listing,command,append,signals,create_case,mutate_case,rule,
                    compute_report,save_report,evidence,overview,seed,digest,import_rows,code_hash,result_from_input)
from scheduler import tick,invalidate

LIMIT=2_000_000

def create_app(root,token,port=18761,scheduled=False):
    if not token or len(token)<32:raise ValueError('service secret required')
    worker_status={'demo':{'status':'idle','error':None},'live':{'status':'idle','error':None}}
    root=Path(root);root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
    async def worker():
        while True:
            for space in ('demo','live'):
                try:await asyncio.to_thread(tick,root,space)
                except Exception as exc:worker_status[space].update(status='failed',error=type(exc).__name__)
                else:worker_status[space].update(status='running',error=None)
            await asyncio.sleep(60)
    @asynccontextmanager
    async def lifespan(app):
        task=asyncio.create_task(worker()) if scheduled else None
        yield
        if task:
            task.cancel()
            try:await task
            except asyncio.CancelledError:pass
    app=FastAPI(title='FearDesk private review',version='1.0',docs_url=None,redoc_url=None,openapi_url=None,lifespan=lifespan)
    @app.middleware('http')
    async def guard(req,call_next):
        if req.headers.get('host')!=f'127.0.0.1:{port}' or req.headers.get('origin') is not None or not secrets.compare_digest(req.headers.get('authorization',''),'Bearer '+token):
            return JSONResponse({'error':{'code':'ACCESS_DENIED','message':'私人服务需要本机入口认证','retryable':False}},403)
        chunks=[];size=0
        async for chunk in req.stream():
            size+=len(chunk)
            if size>LIMIT:return JSONResponse({'error':{'code':'TOO_LARGE','message':'请求超过2MB','retryable':False}},413)
            chunks.append(chunk)
        req._body=b''.join(chunks)
        response=await call_next(req);response.headers['Cache-Control']='no-store';response.headers['X-Content-Type-Options']='nosniff'
        return response
    @app.exception_handler(Fault)
    async def fault(req,exc):return JSONResponse({'error':{'code':exc.code,'message':exc.message,'affected_entities':[],'retryable':exc.status in (409,503),'next_step':'刷新版本或补充证据后重试'}},exc.status)
    from review.common import ReviewError
    @app.exception_handler(ReviewError)
    async def invalid_ledger(req,exc):return JSONResponse({'error':{'code':exc.code,'message':exc.message,'retryable':False}},422)
    @app.exception_handler(sqlite3.OperationalError)
    async def locked(req,exc):return JSONResponse({'error':{'code':'STORE_UNAVAILABLE','message':'私人存储暂不可用，请重试','retryable':True}},503)
    @app.exception_handler(Exception)
    async def unexpected(req,exc):return JSONResponse({'error':{'code':'INTERNAL_ERROR','message':'处理失败，源数据已保留','retryable':True}},500)
    from watch_rules import Store, RulesError
    observations=Store(root)
    @app.get('/api/review/v1/live/watch-rules')
    def watch_list():
        return {'data':observations.view()}
    @app.post('/api/review/v1/live/watch-rules')
    async def watch_change(req:Request):
        try:
            value=await body(req,['action','id','revision','title','kind','text','threshold','waitDays','enabled','ids','previousIds'])
            if value.get('action')=='scan':observations.refresh()
            else:observations.change(value)
            return {'data':observations.view()}
        except (ValueError, ArithmeticError):
            return JSONResponse({'error':{'message':'规则操作失败：请核对字段、版本和交易日历，刷新后重试'}},422)
    @app.get('/api/review/v1/health')
    def health():
        from review.connector import doctor
        state=doctor()
        return {'data':{'version':'1.0','spaces':['demo','live'],'opend':state,'scheduled':scheduled,'orders':False,'worker':worker_status}}
    async def body(req,allowed):
        try:value=await req.json()
        except Exception:fail('INVALID_JSON','请求JSON无效',422)
        if not isinstance(value,dict) or not set(value)<=set(allowed):fail('INVALID_INPUT','请求字段无效',422)
        return value
    @app.get('/api/review/v1/{space}/overview')
    def show(space:str,month:str='2026-08'):
        try:
            from review.common import month_bounds
            month_bounds(month)
            with database(root,space) as s:
                value=overview(s,month)
                from review.connector import doctor
                value['capabilities']['opend']='REACHABLE' if doctor()['opend_reachable'] else 'NOT_CONNECTED'
                value['capabilities']['scheduled']=scheduled
                value['capabilities']['worker']=worker_status
                return {'data':value}
        except ValueError:fail('INVALID_MONTH','月份应为 YYYY-MM',422)
    @app.get('/api/review/v1/{space}/cases/{cid}')
    def case(space:str,cid:str):
        with database(root,space) as s:return {'data':get(s,'case',cid)}
    @app.get('/api/review/v1/{space}/evidence/{fid}')
    def fill(space:str,fid:str):
        with database(root,space) as s:return {'data':evidence(s,fid)}
    @app.get('/api/review/v1/{space}/reports/{rid}')
    def report(space:str,rid:str):
        with database(root,space) as s:return {'data':get(s,'monthly_report',rid)}
    @app.get('/api/review/v1/{space}/reports/{rid}/reproduce')
    def reproduce(space:str,rid:str):
        from review.reporting import analyze
        with database(root,space) as s:
            r=get(s,'monthly_report',rid)
            if digest(r['input'])!=r['input_hash']:fail('INPUT_CHANGED','报告输入哈希不符')
            if code_hash()!=r['input']['code_hash']:fail('CODE_VERSION_REQUIRED','请使用保存报告的代码版本复算')
            if result_from_input(r['input'])!=r['result']:fail('REPRODUCE_MISMATCH','完整报告复算不一致')
            return {'data':{'report_id':rid,'verified':True,'input_hash':r['input_hash']}}
    @app.post('/api/review/v1/{space}/{resource}')
    async def write(space:str,resource:str,req:Request):
        allowed={'signals':['idempotency_key','signal'],'cases':['idempotency_key','plan','signal_id'],
                 'rules':['idempotency_key','id','expected_version','rule'],'reports':['idempotency_key','month'],
                 'demo':['idempotency_key'],'imports':['idempotency_key','account','provider','rows','source_name'],
                 'documents':['idempotency_key','kind','key','expected_version','document'],
                 'fill-patches':['idempotency_key','fill_id','expected_version','fields','evidence'],
                 'resolutions':['idempotency_key','exception_id','expected_version','decision','evidence'],
                 'groups':['idempotency_key','expected_version','group'],
                 'tasks':['idempotency_key']}
        if resource not in allowed:fail('NOT_FOUND','接口不存在',404)
        b=await body(req,allowed[resource])
        for field in ('signal','plan','rule','document','fields','group'):
            if field in b and not isinstance(b[field],dict):fail('INVALID_INPUT','对象字段格式无效',422)
        def process():
            try:
                with database(root,space) as s:
                    if resource=='signals':result=signals(s,b)
                    elif resource=='cases':result=create_case(s,b)
                    elif resource=='rules':result=rule(s,b)
                    elif resource=='demo':result=seed(s,b)
                    elif resource=='reports':
                        r=compute_report(s,b['month'])
                        def save():
                            old=s.db.execute('SELECT payload FROM documents WHERE kind="monthly_report" AND doc_key=?',(r['id'],)).fetchone()
                            return json.loads(old[0]) if old else append(s,'monthly_report',r['id'],r,0)
                        result=command(s,'report:create',b,save)
                    elif resource=='imports':
                        if not isinstance(b['rows'],list) or len(b['rows'])>5000 or not all(isinstance(x,dict) for x in b['rows']):fail('INVALID_ROWS','单批最多5000条对象记录',422)
                        provider=b.get('provider','futu')
                        if space=='live' and provider!='futu':fail('DEMO_ONLY','真实空间只接受券商记录',422)
                        if not isinstance(b['account'],str) or not b['account'].strip():fail('ACCOUNT_REQUIRED','请使用账户脱敏键',422)
                        # Existing stable fill keys deduplicate retries and preserve conflicting facts.
                        result=import_rows(s,b['rows'],{'account':b['account'],'provider':provider,'environment':'REAL' if space=='live' else 'SIMULATE'},digest(b['rows']),str(b.get('source_name','用户导入'))[:150])
                        with s.db:invalidate(s)
                    elif resource=='fill-patches':
                        from review.reviewing import EDIT_FIELDS
                        from review.ingest import normalize
                        if not isinstance(b['fields'],dict) or not set(b['fields'])<=set(EDIT_FIELDS[3:]) or not isinstance(b.get('evidence'),str) or not b['evidence'].strip():
                            fail('INVALID_PATCH','只接受有据的开平/费用/证券字段修订',422)
                        original=next((f for f in s.fills() if f['id']==b['fill_id']),None)
                        if not original:fail('NOT_FOUND','成交不存在',404)
                        candidate=normalize({**original,**b['fields']},{'account':original['account'],'provider':original['provider'],'environment':original['environment']})
                        if any(i.startswith('INVALID') or i=='DIRECTION_CONFLICT' for i in candidate['issues']):fail('INVALID_PATCH','修订字段存在矛盾或无效格式',422)
                        def patch():
                            from review.common import now
                            return append(s,'fill_patch',b['fill_id'],{'fill_id':b['fill_id'],'fields':b['fields'],'evidence':b['evidence'],'recorded_at':now()},b['expected_version'])
                        result=command(s,'fill:patch',b,patch)
                    elif resource=='resolutions':
                        row=s.db.execute('SELECT * FROM exceptions WHERE id=?',(b['exception_id'],)).fetchone()
                        if not row or row['code'] not in ('REVISION_CONFLICT','POSSIBLE_DUPLICATE','MISSING_FILL_ID') or b['decision'] not in ('keep-current','exclude-fill') or not b.get('evidence','').strip():fail('INVALID_RESOLUTION','需明确冲突处置并提供证据',422)
                        result=command(s,'resolution',b,lambda:append(s,'resolution',b['exception_id'],{'exception_id':b['exception_id'],'ref':row['ref'],'decision':b['decision'],'evidence':b['evidence']},b['expected_version']))
                    elif resource=='groups':
                        group=b['group']
                        if group.get('confirmed') is not True or not group.get('strategy') or not group.get('group_id') or not group.get('member_ids') or len(set(group['member_ids']))!=len(group['member_ids']):fail('GROUP_INCOMPLETE','策略生命周期组需本人确认完整成员',422)
                        facts={f['id']:f for f in s.fills()}
                        if any(fid not in facts for fid in group['member_ids']):fail('FILL_NOT_FOUND','策略组含未知成交',422)
                        if len({(facts[fid]['account'],facts[fid]['currency'],facts[fid]['market']) for fid in group['member_ids']})!=1:fail('GROUP_SCOPE_CONFLICT','策略组不能混入另一账户/币种/市场',422)
                        def save_group():
                            if any(set(g['member_ids'])&set(group['member_ids']) for g in s.documents('group') if g['group_id']!=group['group_id']):fail('GROUP_OVERLAP','已确认策略组成员重复')
                            return append(s,'group',group['group_id'],group,b['expected_version'])
                        result=command(s,'group',b,save_group)
                    elif resource=='documents':
                        from review.reviewing import validate_document
                        if b['kind']=='fx':
                            d=b['document']
                            if not all(isinstance(d.get(k),str) and d[k].strip() for k in ('currency','date','source','rate')):fail('FX_SOURCE_REQUIRED','汇率需日期、原币及来源',422)
                            from datetime import date
                            date.fromisoformat(d['date']);number(d['rate'],positive=True)
                            canonical=digest([d['currency'],d['date']])
                        else:canonical,d=validate_document(b['kind'],b['document'])
                        if b['kind']!='fx' and not d.get('market'):fail('DOCUMENT_INCOMPLETE','缺少市场',422)
                        if 'environment' in d and d['environment']!=('REAL' if space=='live' else 'SIMULATE'):fail('SPACE_CONFLICT','资料环境与空间不符',422)
                        d['environment']='REAL' if space=='live' else 'SIMULATE'
                        d['document_key']=canonical
                        def save_doc():return append(s,b['kind'],canonical,d,b['expected_version'])
                        result=command(s,'document:'+b['kind'],b,save_doc)
                    else:
                        with s.db:invalidate(s)
                        result={'state':'queued'}
                    return {'data':result}
            except (KeyError,TypeError,ValueError,IndexError):fail('INVALID_INPUT','字段、日期或数量格式不完整',422)
        return await asyncio.to_thread(process)
    @app.post('/api/review/v1/{space}/cases/{cid}/{action}')
    async def change(space:str,cid:str,action:str,req:Request):
        b=await body(req,['idempotency_key','expected_version','plan','reason','checks','fill_id','quantity','entries','confirmed','text','allocation_id'])
        for field in ('plan','checks'):
            if field in b and not isinstance(b[field],dict):fail('INVALID_INPUT','对象字段格式无效',422)
        def process():
            try:
                with database(root,space) as s:return {'data':mutate_case(s,cid,action,b)}
            except (KeyError,TypeError,ValueError,IndexError):fail('INVALID_INPUT','档案请求字段不完整',422)
        return await asyncio.to_thread(process)
    return app

if __name__=='__main__':
    import uvicorn
    port=int(os.environ.get('REVIEW_SERVICE_PORT','18761'))
    uvicorn.run(create_app(os.environ['REVIEW_STATE'],os.environ['REVIEW_SERVICE_TOKEN'],port,scheduled=True),host='127.0.0.1',port=port,log_level='warning',access_log=False)
