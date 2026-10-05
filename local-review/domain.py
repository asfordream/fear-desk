"""Private authority. Signal -> immutable plan -> allocated facts -> frozen report.

Market D1 never writes here. All amounts come from the existing Decimal ledger.
"""
from __future__ import annotations
from contextlib import contextmanager
from datetime import datetime, timezone, date, timedelta
from decimal import Decimal
from pathlib import Path
import hashlib
import json
import sqlite3
import uuid
from review.store import Store
from review.common import digest, dumps, now, month_bounds
from review.ingest import import_rows
from review.reporting import analyze, REPORT_VERSION
from review.accounting import VERSION, allocate

class Fault(Exception):
    def __init__(self, code, message, status=409):
        self.code, self.message, self.status = code, message, status

def fail(code, message, status=409):
    raise Fault(code, message, status)

def number(value, *, positive=False):
    if not isinstance(value, str): fail('DECIMAL_REQUIRED', '金额与数量必须为十进制字符串', 422)
    try: result = Decimal(value)
    except Exception: fail('INVALID_DECIMAL', '十进制数字无效', 422)
    if not result.is_finite() or len(value)>80 or (positive and result<=0):
        fail('INVALID_DECIMAL', '数量必须为有限正数', 422)
    return result

def identity(value):
    if set(value) != {'provider','market','asset_type','symbol'} or not all(isinstance(x,str) and x.strip() for x in value.values()):
        fail('IDENTITY_REQUIRED', '请核对提供方、市场、资产类型与证券代码', 422)
    if value['asset_type'] not in ('STOCK','ETF','OPTION'): fail('UNSUPPORTED_ASSET','资产类型未支持',422)
    return value

@contextmanager
def database(root, space):
    if space not in ('demo','live'): fail('SPACE_NOT_FOUND','空间不存在',404)
    store = Store(Path(root)/space)
    store.db.execute('PRAGMA busy_timeout=5000')
    store.db.execute('PRAGMA journal_mode=WAL')
    store.db.executescript('''
      CREATE TABLE IF NOT EXISTS review_state(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO review_state(id,generation) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS review_commands(key TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monthly_jobs(month TEXT PRIMARY KEY,status TEXT NOT NULL,lease_until TEXT,attempts INTEGER NOT NULL DEFAULT 0,report_id TEXT,error TEXT,lease_id TEXT);
    ''')
    # Schema migration and code changes are serialized, including existing local stores.
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        if 'code_hash' not in {r[1] for r in store.db.execute('PRAGMA table_info(review_state)')}:
            store.db.execute('ALTER TABLE review_state ADD COLUMN code_hash TEXT')
        current=code_hash()
        prior=store.db.execute('SELECT code_hash FROM review_state WHERE id=1').fetchone()[0]
        if current!=prior:
            invalidate_reports(store)
            store.db.execute('UPDATE review_state SET code_hash=? WHERE id=1',(current,))
    try: yield store
    finally: store.close()

def invalidate_reports(store):
    store.db.execute('UPDATE review_state SET generation=generation+1 WHERE id=1')
    store.db.execute('UPDATE monthly_jobs SET status="pending",attempts=0 WHERE status!="running"')

def get(store, kind, key):
    row=store.db.execute('SELECT payload FROM documents WHERE kind=? AND doc_key=? ORDER BY version DESC LIMIT 1',(kind,key)).fetchone()
    if not row: fail('NOT_FOUND','记录不存在',404)
    return json.loads(row[0])

def listing(store,kind,limit=100,offset=0):
    rows=store.db.execute('''SELECT payload FROM documents d WHERE kind=? AND version=(
      SELECT MAX(version) FROM documents e WHERE e.kind=d.kind AND e.doc_key=d.doc_key)
      ORDER BY id DESC LIMIT ? OFFSET ?''',(kind, min(max(limit,1),100),max(0,offset)))
    return [json.loads(r[0]) for r in rows]

def command(store, action, body, operation):
    key=body.get('idempotency_key')
    if not isinstance(key,str) or not key.strip() or len(key)>200: fail('KEY_REQUIRED','缺少幂等请求键',422)
    h=digest([action,body])
    with store.db:
        store.db.execute('BEGIN IMMEDIATE')
        old=store.db.execute('SELECT hash,result FROM review_commands WHERE key=?',(key,)).fetchone()
        if old:
            if old[0]!=h: fail('KEY_REUSED','幂等键已用于另一请求')
            return json.loads(old[1])
        value=operation()
        if action!='report:create':invalidate_reports(store)
        store.db.execute('INSERT INTO review_commands VALUES(?,?,?)',(key,h,dumps(value)))
        return value

def append(store,kind,key,value,expected):
    actual=store.db.execute('SELECT COALESCE(MAX(version),0) FROM documents WHERE kind=? AND doc_key=?',(kind,key)).fetchone()[0]
    if expected != actual: fail('VERSION_CONFLICT','记录已更新，请刷新后重试')
    return store.add_document(kind,key,value,expected_version=actual)

def signals(store,body):
    signal=body['signal']; identity(signal['identity'])
    for k in ('source','source_ref','generated_at','data_at','rule_version','trigger','indicators'):
        if not signal.get(k): fail('SIGNAL_INCOMPLETE', '信号缺少来源、时点或规则',422)
    for k in ('generated_at','data_at'):
        if k=='data_at' and signal.get('data_time_precision')=='day':
            try:date.fromisoformat(signal[k])
            except (TypeError,ValueError):fail('INVALID_DATA_DATE','日线日期无效',422)
            if not signal.get('market_timezone'):fail('TIMEZONE_REQUIRED','日线数据需保留市场时区',422)
            continue
        try:
            t=datetime.fromisoformat(signal[k])
            if t.tzinfo is None: raise ValueError()
        except (TypeError,ValueError): fail('TIMEZONE_REQUIRED','信号时间须带时区',422)
    sid=digest(signal)
    def run():
        old=store.db.execute('SELECT payload FROM documents WHERE kind="signal" AND doc_key=?',(sid,)).fetchone()
        if old:return json.loads(old[0])
        return append(store,'signal',sid,{**signal,'id':sid,'source_hash':digest(signal),'recorded_at':now()},0)
    return command(store,'signal',body,run)

PLAN_FIELDS=('account','strategy','direction','thesis','expectation','holding_period','quantity','quantity_unit','price_basis','budget_currency','max_loss','invalidation','take_profit','stop_loss','exit_plan')
def validate_plan(plan):
    if any(not isinstance(plan.get(k),str) or not plan[k].strip() for k in PLAN_FIELDS):
        fail('PLAN_INCOMPLETE','确认前请补齐账户、交易理由、预期、数量和退出/风险计划',422)
    identity(plan['identity']); number(plan['quantity'],positive=True)
    if number(plan['max_loss'])<0: fail('INVALID_BUDGET','风险预算不能为负',422)
    if plan['direction'] not in ('LONG','SHORT'):fail('DIRECTION_REQUIRED','方向无效',422)
    if plan['identity']['asset_type']=='OPTION':
        if not plan.get('legs') or not plan.get('expiry_action'):fail('OPTION_METADATA_REQUIRED','期权需要完整腿、乘数来源及到期预案',422)
        for leg in plan['legs']:
            if not all(leg.get(k) for k in ('identity','expiry','strike','cp','multiplier','multiplier_source','quantity')):
                fail('OPTION_METADATA_REQUIRED','期权腿元数据缺失',422)
            identity(leg['identity']); number(leg['multiplier'],positive=True);number(leg['quantity'],positive=True);number(leg['strike'],positive=True)

def applicable(store,plan):
    matched=[]
    for rule in listing(store,'rule'):
        if not rule['enabled']:continue
        conditions=rule['conditions']
        facts={**plan.get('identity',{}),'strategy':plan.get('strategy'),'direction':plan.get('direction')}
        if all(facts.get(k)==v for k,v in conditions.items()):matched.append({**rule,'match_reason':conditions})
    return matched

def create_case(store,body):
    plan=body.get('plan',{}); identity(plan['identity'])
    signal=get(store,'signal',body['signal_id']) if body.get('signal_id') else None
    if signal and signal['identity']!=plan['identity']:fail('IDENTITY_CONFLICT','信号与立案证券身份不一致',422)
    def run():
        cid=uuid.uuid4().hex
        return append(store,'case',cid,{'id':cid,'created_at':now(),'draft':plan,'signal':signal,'plans':[], 'review':[], 'allocations':[], 'recalls':[]},0)
    return command(store,'case:create',body,run)

def mutate_case(store,cid,action,body):
    def run():
        item=get(store,'case',cid)
        if body['expected_version']!=item['version']:fail('VERSION_CONFLICT','档案已更新，请刷新')
        if action=='draft':
            if not body.get('reason','').strip():fail('REASON_REQUIRED','修订需记录原因',422)
            identity(body['plan']['identity'])
            if body['plan']['identity']!=(item['signal']['identity'] if item['signal'] else (item['draft'] or item['plans'][-1]['plan'])['identity']):
                fail('IDENTITY_CONFLICT','立案不能改为另一证券',422)
            item['draft']=body['plan'];item['draft_reason']=body['reason']
        elif action=='confirm':
            if item['draft'] is None:fail('NO_DRAFT','无待确认草稿')
            validate_plan(item['draft']);rules=applicable(store,item['draft'])
            checks=body.get('checks',{})
            for r in rules:
                c=checks.get(r['id'],{})
                if c.get('status') not in ('done','skipped') or not c.get('evidence','').strip():
                    fail('CHECK_REQUIRED','请完成适用经验检查，或记录跳过原因',422)
            allocations=item['allocations']
            fill_map={f['id']:f for f in store.fills()}
            first=min((fill_map[a['fill_id']]['executed_at'] for a in allocations),default=None)
            stamp=now()
            item['plans'].append({'number':len(item['plans'])+1,'recorded_at':stamp,'effective_at':stamp,
                'reason':item.get('draft_reason','首次立案'),'plan':item['draft'],
                'signal':item['signal'],'checks':[{'rule':r,'response':checks[r['id']]} for r in rules],
                'after_trade':bool(first and stamp>first)})
            item['draft']=None
        elif action=='allocate':
            f=next((f for f in store.fills() if f['id']==body['fill_id']),None)
            if not f:fail('FILL_NOT_FOUND','成交不存在',404)
            p=item['draft'] or item['plans'][-1]['plan'];ident=p['identity']
            if any(f.get(k)!=v for k,v in ident.items()) or f['account']!=p['account']:
                fail('IDENTITY_CONFLICT','账户/市场/资产/提供方/证券不符',422)
            direction='LONG' if (f['open_close']=='OPEN' and f['side']=='BUY') or (f['open_close']=='CLOSE' and f['side']=='SELL') else 'SHORT'
            if f['open_close']=='UNKNOWN' or p.get('direction')!=direction:fail('DIRECTION_CONFLICT','开平或方向与立案不符',422)
            q=number(body['quantity'],positive=True)
            # Serialize all allocations across cases; Decimal sum cannot exceed fact quantity.
            total=sum((Decimal(a['quantity']) for c in store.documents('case') for a in c['allocations'] if a['fill_id']==f['id']),Decimal(0))
            if total+q>Decimal(f['qty']):fail('OVER_ALLOCATION','累计分配量超过实际成交')
            item['allocations'].append({'id':uuid.uuid4().hex,'fill_id':f['id'],'quantity':str(q),'recorded_at':now()})
        elif action=='unallocate':
            if not any(a['id']==body['allocation_id'] for a in item['allocations']):fail('ALLOCATION_NOT_FOUND','关联不存在',404)
            if not body.get('reason','').strip():fail('REASON_REQUIRED','更正关联需说明原因',422)
            item.setdefault('allocation_corrections',[]).append({'allocation_id':body['allocation_id'],'reason':body['reason'],'recorded_at':now()})
            item['allocations']=[a for a in item['allocations'] if a['id']!=body['allocation_id']]
        elif action=='review':
            entries=body.get('entries',[])
            refs={a['fill_id'] for a in item['allocations']}|{f'plan:{p["number"]}' for p in item['plans']}
            for e in entries:
                if not e.get('text','').strip() or not e.get('evidence_ids') or not set(e['evidence_ids'])<=refs:fail('INVALID_EVIDENCE','复盘需引用本档案证据',422)
            item['review'].append({'entries':entries,'recorded_at':now(),'confirmed':bool(body.get('confirmed'))})
        elif action=='recall':
            if not body.get('text','').strip():fail('RECALL_REQUIRED','回忆不能为空',422)
            item['recalls'].append({'text':body['text'],'recorded_at':now(),'kind':'after_the_fact'})
        else:fail('ACTION_NOT_FOUND','操作不存在',404)
        return append(store,'case',cid,item,body['expected_version'])
    return command(store,f'case:{cid}:{action}',body,run)

def rule(store,body):
    def run():
        r=body['rule'];rid=body.get('id') or uuid.uuid4().hex
        if not isinstance(r.get('enabled',False),bool):fail('INVALID_ENABLED','经验启用状态须为布尔值',422)
        if not isinstance(r.get('conditions',{}),dict) or not all(isinstance(v,str) for v in r.get('conditions',{}).values()):fail('INVALID_CONDITIONS','匹配条件需为字符串',422)
        if not all(isinstance(r.get(k),str) and r[k].strip() for k in ('problem','action','verification')):fail('RULE_INCOMPLETE','经验需有问题、具体动作与验证方式',422)
        if not r.get('source_case_ids'):fail('SOURCE_REQUIRED','经验需关联来源案例',422)
        for cid in r['source_case_ids']:get(store,'case',cid)
        if not set(r.get('conditions',{})) <= {'provider','market','asset_type','symbol','strategy','direction'}:fail('INVALID_CONDITIONS','匹配条件无效',422)
        return append(store,'rule',rid,{**r,'id':rid,'enabled':r.get('enabled',False),'recorded_at':now()},body.get('expected_version',0))
    return command(store,'rule',body,run)

def historical_snapshot(store,month):
    start,end=month_bounds(month)
    snap=store.snapshot()
    # Select revision *after* filtering effective time. A future opening cannot hide a prior one.
    eligible={}
    for row in store.db.execute('SELECT kind,doc_key,version,payload FROM documents ORDER BY version'):
        if row['kind'] not in ('opening','coverage','statement','event','group'):continue
        p=json.loads(row['payload']);effective=p.get('effective_at') or p.get('as_of') or p.get('trade_date')
        cutoff=start if row['kind']=='opening' else end
        if effective and effective[:10]>cutoff:continue
        eligible[(row['kind'],row['doc_key'])]=p
    for kind,key in (('opening','openings'),('coverage','coverage'),('statement','statements'),('event','events'),('group','groups')):
        snap[key]=[p for (k,_),p in sorted(eligible.items()) if k==kind]
    by_scope={}
    for opening in snap['openings']:
        from review.accounting import scope
        key=scope(opening)
        previous=by_scope.get(key)
        if previous is None or opening['as_of']>previous['as_of']:by_scope[key]=opening
        elif opening['as_of']==previous['as_of'] and opening['lots']!=previous['lots']:
            fail('OPENING_CONFLICT','同一期初范围出现不同成本批次，需以同资料键追加有据修订')
    snap['openings']=list(by_scope.values())
    # Stable content: duplicate import batches/audit UUIDs are not accounting inputs.
    snap.pop('batches',None)
    snap['fills']=[f for f in snap['fills'] if f['trade_date'][:10]<end]
    ids={f['id'] for f in snap['fills']}
    snap['exceptions']=[e for e in snap['exceptions'] if e['ref'] in ids]
    snap['excluded_fills']=[f for f in snap['excluded_fills'] if f['trade_date'][:10]<end]
    return snap

def attribute_cases(cases,matches):
    remaining={}
    for case in cases:
        for a in case['allocations']:
            key=(case['id'],a['fill_id']);remaining[key]=remaining.get(key,Decimal(0))+Decimal(a['quantity'])
    rows=[]
    for m in matches:
        residual=Decimal(m['qty']);portions=[]
        for case in cases:
            opened=(case['id'],m['open_id']);closed=(case['id'],m['close_id'])
            q=min(residual,remaining.get(opened,Decimal(0)),remaining.get(closed,Decimal(0)))
            if q<=0:continue
            ratio=q/Decimal(m['qty']);remaining[opened]-=q;remaining[closed]-=q;residual-=q
            portions.append({'case_id':case['id'],'currency':m['currency'],'quantity':str(q),'gross':str(Decimal(m['gross'])*ratio),
                'net':str(Decimal(m['net'])*ratio) if m['net'] is not None else None,
                'fee':str(Decimal(m['fee'])*ratio) if m['fee'] is not None else None})
        quantities=[Decimal(p['quantity']) for p in portions]+([residual] if residual>0 else [])
        if quantities:
            for field in ('gross','net','fee'):
                values=allocate(Decimal(m[field]) if m[field] is not None else None,quantities)
                for p,value in zip(portions,values):p[field]=str(value) if value is not None else None
        rows.append({'match_id':m['id'],'portions':portions,'unassigned_quantity':str(residual)})
    return rows

def load_code_sources():
    files=[Path(__file__),Path(__import__('review.accounting',fromlist=['x']).__file__),Path(__import__('review.reporting',fromlist=['x']).__file__),Path(__import__('review.common',fromlist=['x']).__file__)]
    return {p.name:p.read_text() for p in files}

RUNTIME_CODE_SOURCES=load_code_sources()

def code_sources():
    return RUNTIME_CODE_SOURCES.copy()

def code_hash():
    return digest(RUNTIME_CODE_SOURCES)

def result_from_input(frozen):
    snapshot=frozen['snapshot'];month=frozen['month']
    result=analyze(snapshot,month,frozen.get('fx',[]))
    declared={(x['account'],x['market']):x for x in snapshot['coverage'] if x['month']==month}
    expected={(f['account'],f.get('market')) for f in snapshot['fills'] if f['trade_date'][:7]==month}|set(declared)
    result['coverage']=[{'account':k[0],'market':k[1],'status':'DECLARED' if k in declared else 'UNVERIFIED','evidence':declared.get(k,{}).get('evidence')} for k in sorted(expected)]
    if result['status']=='FINAL':result['status']='PARTIAL' # Formal document source verification is a separate gate.
    result['quality']={'accounting':'PARTIAL' if result['accounting']['issues'] else 'COMPUTED',
        'coverage':'DECLARED' if expected and set(declared)==expected else 'UNVERIFIED',
        'statement':'UNVERIFIED','review':'NOT_REVIEWED','valuation':'UNAVAILABLE'}
    result['attribution']=[a for a in attribute_cases(frozen['private_context']['cases'],result['accounting']['matches']) if a['match_id'] in {m['id'] for m in result['accounting']['monthly_matches']}]
    result['retrospective']={'cases':[{'case_id':c['id'],'strategy':(c['draft'] or (c['plans'][-1]['plan'] if c['plans'] else {})).get('strategy','UNCLASSIFIED'),'recorded_reasons':bool(c['plans']),'reviews':c['review'],'recalls':c['recalls']} for c in frozen['private_context']['cases']],'rules':frozen['private_context']['rules']}
    result['limitations']=['正式单据与完整覆盖尚未核对','无完整历史估值；未实现损益未知','缺少汇率不合并币种','交易片段数不等于策略笔数']
    return result

def compute_report(store,month):
    # One read transaction freezes all ledger/private inputs consistently.
    with store.db:
        store.db.execute('BEGIN')
        snapshot=historical_snapshot(store,month)
        ids={f['id'] for f in snapshot['fills']}
        cases=[c for c in store.documents('case') if any(a['fill_id'] in ids for a in c['allocations']) or c['created_at'][:7]<=month]
        case_ids={c['id'] for c in cases}
        rules=[r for r in store.documents('rule') if set(r['source_case_ids'])&case_ids]
        frozen={'snapshot':snapshot,'month':month,'algorithm':VERSION,'report_version':REPORT_VERSION,'adapter':'feardesk-1',
                'fx':[r for r in store.documents('fx') if r['date']<month_bounds(month)[1]],
                'code_hash':code_hash(),'code_sources':code_sources(),'private_context':{'cases':cases,'rules':rules}}
    rid=digest(frozen)
    return {'id':rid,'input_hash':digest(frozen),'input':frozen,'result':result_from_input(frozen),'recorded_at':now()}

def save_report(store,report):
    with store.db:
        old=store.db.execute('SELECT payload FROM documents WHERE kind="monthly_report" AND doc_key=?',(report['id'],)).fetchone()
        if old:return json.loads(old[0])
        return append(store,'monthly_report',report['id'],report,0)

def evidence(store,fid):
    f=next((f for f in store.fills(True) if f['id']==fid),None)
    if not f:fail('NOT_FOUND','成交证据不存在',404)
    ref=f['source_ref']
    raw=store.db.execute('SELECT payload FROM raw_records WHERE batch_id=? AND source_row=?',(ref['batch'],ref['row'])).fetchone()
    if not raw:fail('EVIDENCE_MISSING','原始行证据缺失',404)
    value=json.loads(raw[0]);batch=store.db.execute('SELECT source_hash,source_name FROM batches WHERE id=?',(ref['batch'],)).fetchone()
    return {'fill':f,'raw':value,'raw_hash':digest(value),'source_hash':batch[0],'source_name':batch[1]}

def overview(store,month):
    reports=[r for r in store.documents('monthly_report') if r['result']['month']==month]
    report=max(reports,key=lambda r:r['recorded_at']) if reports else None
    cases=listing(store,'case');fills=[f for f in store.fills() if f['trade_date'][:7]==month]
    for c in cases:
        allocated=[f for f in store.fills() if f['id'] in {a['fill_id'] for a in c['allocations']}]
        first=min((f['executed_at'] for f in allocated),default=None)
        c['after_trade']=bool(c['plans'] and first and c['plans'][0]['recorded_at']>first)
    return {'month':month,'report':report,'report_versions':[{'id':r['id'],'recorded_at':r['recorded_at'],'status':r['result']['status']} for r in sorted(reports,key=lambda r:r['recorded_at'],reverse=True)],
        'cases':cases,'fills':fills,'signals':listing(store,'signal'),'rules':listing(store,'rule'),
        'jobs':[dict(r) for r in store.db.execute('SELECT * FROM monthly_jobs ORDER BY month')],
        'capabilities':{'opend':'NOT_CONNECTED','orders':False,'valuation':False,'ai':False,'synthetic':store.root.name=='demo'}}

def seed(store,body):
    if store.root.name!='demo':fail('DEMO_ONLY','合成数据只能写入示例空间',403)
    ident={'provider':'synthetic','market':'US','asset_type':'STOCK','symbol':'US.XYZ'}
    signal=signals(store,{'idempotency_key':'fixture-signal-v1','signal':{'identity':ident,'source':'SYNTHETIC FearDesk','source_ref':'fixture:v1','generated_at':'2026-08-02T20:00:00+00:00','data_at':'2026-07-31T20:00:00+00:00','rule_version':'synthetic-v1','trigger':'恐慌指标 ≥ 70','indicators':{'fear':{'value':'78','unit':'points'}},'content':{'synthetic':True}}})
    plan={'identity':ident,'account':'demo','strategy':'long_stock','direction':'LONG','thesis':'合成：恐慌后观察修复','expectation':'退出价110','holding_period':'一周','quantity':'10','quantity_unit':'shares','price_basis':'限价100 USD','budget_currency':'USD','max_loss':'100','invalidation':'信号失效','take_profit':'110','stop_loss':'90','exit_plan':'达到目标或失效退出'}
    case=create_case(store,{'idempotency_key':'fixture-case-v1','signal_id':signal['id'],'plan':plan})
    if not get(store,'case',case['id'])['plans']:
        mutate_case(store,case['id'],'confirm',{'idempotency_key':'fixture-confirm-v1','expected_version':1,'checks':{}})
    rows=[{'fill_id':'fixture-open-v1','symbol':'US.XYZ','side':'BUY','open_close':'OPEN','qty':'10','price':'100','fee':'1','currency':'USD','trade_date':'2026-08-03T10:00:00','timezone':'America/New_York','market':'US','asset_type':'STOCK','multiplier':'1'},
          {'fill_id':'fixture-close-v1','symbol':'US.XYZ','side':'SELL','open_close':'CLOSE','qty':'10','price':'110','fee':'1','currency':'USD','trade_date':'2026-08-04T10:00:00','timezone':'America/New_York','market':'US','asset_type':'STOCK','multiplier':'1'}]
    import_rows(store,rows,{'account':'demo','provider':'synthetic','environment':'SIMULATE'},digest(rows),'SYNTHETIC fixture v1')
    for kind,key,value in [('opening','fixture-opening',{'account':'demo','symbol':'US.XYZ','currency':'USD','market':'US','environment':'SIMULATE','multiplier':'1','as_of':'2026-01-01','lots':[],'evidence':'SYNTHETIC empty opening'}),('coverage','fixture-coverage',{'account':'demo','market':'US','month':'2026-08','evidence':'SYNTHETIC fixture coverage'})]:
        if not store.db.execute('SELECT 1 FROM documents WHERE kind=? AND doc_key=?',(kind,key)).fetchone():
            with store.db:append(store,kind,key,value,0)
    for f in store.fills():
        if f['fill_id'] not in ('fixture-open-v1','fixture-close-v1'):continue
        c=get(store,'case',case['id'])
        if not any(a['fill_id']==f['id'] for a in c['allocations']):mutate_case(store,c['id'],'allocate',{'idempotency_key':'fixture-allocate-'+f['fill_id'],'expected_version':c['version'],'fill_id':f['id'],'quantity':'10'})
    save_report(store,compute_report(store,'2026-08'))
    return {'case_id':case['id'],'month':'2026-08'}
