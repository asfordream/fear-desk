from __future__ import annotations
import json
from datetime import date,datetime,timezone
from decimal import Decimal as D
from .common import ReviewError,csv_rows,decimal,digest,export_csv,now

REVIEW_FIELDS=['group_id','version','member_ids','strategy','confirmed','reason_at_entry','entry_evidence',
               'recalled_reason','exit_plan','risk_budget','emotion','execution_deviation','next_action','review_date','note']

def validate_evidence(row):
    if row.get('confirmed') is not True or not str(row.get('evidence','')).strip():
        raise ReviewError('EVIDENCE_REQUIRED','需要 confirmed=true 和可追溯 evidence，不能将未知状态当事实')

def validate_document(kind,row):
    """Validate one structured document before either CLI or private API persistence."""
    from copy import deepcopy
    r=deepcopy(row)
    validate_evidence(r)
    for k in ('account','symbol','currency','market'):
        if kind in ('opening','event') and not r.get(k):raise ReviewError('MISSING_FIELD','缺少字段 '+k)
    if kind=='opening':
        date.fromisoformat(r['as_of']);r['multiplier']=str(decimal(r['multiplier'],positive=True))
        seen=set()
        for lot in r.get('lots',[]):
            if lot['direction'] not in ('LONG','SHORT'):raise ReviewError('INVALID_DIRECTION','期初方向必须为LONG/SHORT')
            if not lot.get('lot_id') or lot['lot_id'] in seen:raise ReviewError('DUPLICATE_LOT','期初批次ID重复或缺失')
            seen.add(lot['lot_id'])
            for k in ('qty','price','fee'):
                v=decimal(lot.get(k),optional=k=='fee',positive=k=='qty',nonnegative=k=='price');lot[k]=str(v) if v is not None else None
            datetime.fromisoformat(lot['opened_at'])
            if lot['opened_at'][:10]>r['as_of']:raise ReviewError('INVALID_OPENING_DATE','期初批次开仓日在期初之后')
        if len({lot['direction'] for lot in r.get('lots',[])})>1:raise ReviewError('UNSUPPORTED_HEDGE','暂不支持期初同合约双向库存')
        key=digest([r.get(k) for k in ('account','symbol','currency','market')])
    elif kind=='event':
        if r['event_type'] not in ('EXPIRE_WORTHLESS','EXERCISE','ASSIGNMENT','CORPORATE_ACTION'):
            raise ReviewError('EVENT_TYPE','未知生命周期事件')
        dt=datetime.fromisoformat(r['trade_date'])
        if dt.tzinfo is None:raise ReviewError('MISSING_TIMEZONE','生命周期事件必须带时区')
        r['executed_at']=dt.astimezone(timezone.utc).isoformat()
        if r.get('direction') not in ('LONG','SHORT'):raise ReviewError('INVALID_DIRECTION','事件方向必须为LONG/SHORT')
        r['qty']=str(decimal(r['qty'],positive=True))
        v=decimal(r.get('fee'),optional=True);r['fee']=str(v) if v is not None else None
        if r['event_type'] in ('EXERCISE','ASSIGNMENT') and r.get('strike'):
            r['strike']=str(decimal(r['strike'],positive=True))
        if r['event_type']=='EXPIRE_WORTHLESS':
            date.fromisoformat(r['expiry'])
        key=r['id']
    elif kind=='coverage':
        from .common import month_bounds
        month_bounds(r['month'])
        if not all(r.get(x) for x in ('account','market')):raise ReviewError('MISSING_SCOPE','覆盖声明必须有账户和市场')
        if r.get('complete') is not True:raise ReviewError('INVALID_COVERAGE','只接受有证据的完整性声明')
        key=digest([r['account'],r['market'],r['month']])
    elif kind=='statement':
        from .common import month_bounds
        month_bounds(r['month'])
        if not r.get('account'):raise ReviewError('MISSING_ACCOUNT','月结单缺少账户')
        if not r.get('net') or not r.get('fee'):raise ReviewError('MISSING_TOTALS','月结单需原币净损益和费用字典')
        for bucket in ('net','fee'):
            for value in r[bucket].values():decimal(value)
        if 'positions' not in r:raise ReviewError('MISSING_POSITIONS','月结单需要期末持仓，空仓用空列表')
        for pos in r['positions']:
            if not pos.get('symbol') or not pos.get('currency'):raise ReviewError('POSITION_SCOPE','期末持仓缺少标的或币种')
            decimal(pos['qty'])
        key=digest([r['account'],r['month']])
    else:raise ReviewError('DOCUMENT_TYPE','不支持该类型')
    return key,r

def import_documents(store,kind,path):
    content=json.loads(open(path,encoding='utf-8').read())
    rows=content if isinstance(content,list) else [content]
    validated=[validate_document(kind,r) for r in rows]
    with store.db:
        for key,r in validated:store.add_document(kind,key,r,expected_version=r.get('expected_version',0))
    return {'imported':len(validated),'kind':kind}


def export_review_sheet(store,month,path):
    groups={g['group_id']:g for g in store.documents('group')}
    rows=[{**g,'member_ids':';'.join(g['member_ids'])} for g in groups.values()]
    occupied={x for g in groups.values() for x in g['member_ids']}
    from .candidates import propose
    for candidate in propose(store.snapshot(),month):
        occupied.update(candidate['member_ids'])
        rows.append({**candidate,'member_ids':';'.join(candidate['member_ids'])})
    # Candidates are explicitly unconfirmed single-fill entries, not inferred strategies.
    for f in store.fills():
        if f['trade_date'][:7]==month and f['id'] not in occupied:
            rows.append(dict(group_id='candidate-'+f['id'][:16],version=0,member_ids=f['id'],strategy='UNCLASSIFIED',
                confirmed='false',note=f['symbol']+'；候选成员，请补齐开平腿并确认'))
    export_csv(path,rows,REVIEW_FIELDS);return {'rows':len(rows),'path':str(path)}

def apply_review(store,path,expected_version=None):
    rows=csv_rows(path);known={f['id']:f for f in store.fills()}
    for op in store.documents('opening'):
        for lot in op.get('lots',[]):known[lot['lot_id']]={**op,'trade_date':lot['opened_at']}
    for e in store.documents('event'):known[e['id']]=e
    old={g['group_id']:g for g in store.documents('group')};updates={}
    for r in rows:
        if r.get('confirmed','').lower()!='true':continue
        gid=r['group_id'];members=[x.strip() for x in r['member_ids'].split(';') if x.strip()]
        if not members or len(set(members))!=len(members) or any(m not in known for m in members):
            raise ReviewError('INVALID_MEMBERS','成员引用缺失、未知或重复')
        if len({(known[x]['account'],known[x].get('currency')) for x in members})!=1:
            raise ReviewError('MIXED_GROUP','一个策略组不能跨账户或币种')
        if not r['strategy'] or r['strategy']=='UNCLASSIFIED':raise ReviewError('STRATEGY_REQUIRED','确认前填写策略')
        if r.get('reason_at_entry') and not r.get('entry_evidence'):
            raise ReviewError('ENTRY_EVIDENCE_REQUIRED','当时理由必须有当时证据；事后回忆填 recalled_reason')
        if r.get('risk_budget'):decimal(r['risk_budget'],positive=True)
        if r.get('review_date'):date.fromisoformat(r['review_date'])
        if gid in updates:raise ReviewError('DUPLICATE_GROUP','同文件组ID重复')
        updates[gid]={**r,'member_ids':members,'confirmed':True,'recorded_at':now()}
    merged={**old,**updates};owner={}
    for gid,g in merged.items():
        for member in g['member_ids']:
            if member in owner:raise ReviewError('OVERLAPPING_GROUP','成交已被其他组占用；v0.1仅支持完整成员归组')
            owner[member]=gid
    with store.db:
        for gid,g in updates.items():
            version=int(g.get('version') or 0)
            if expected_version is not None and version!=expected_version:
                raise ReviewError('VERSION_CONFLICT','CSV版本与指定版本不一致',exit_code=5)
            store.add_document('group',gid,g,version)
    return {'confirmed_groups':len(updates)}


EDIT_FIELDS=['id','version','evidence','open_close','side','asset_type','multiplier','currency','market','timezone','expiry','strike','cp','underlying','fee','sequence']

def export_fill_sheet(store,month,path):
    patches={p['fill_id']:p for p in store.documents('fill_patch')}
    rows=[{**f,'version':patches.get(f['id'],{}).get('version',0),'evidence':''} for f in store.fills() if f['trade_date'][:7]==month]
    export_csv(path,rows,EDIT_FIELDS);return {'path':str(path),'rows':len(rows)}

def apply_fill_sheet(store,path):
    from .ingest import normalize
    known={f['id']:f for f in store.fills()};updates=[];seen=set()
    for row in csv_rows(path):
        if not row.get('evidence','').strip():continue
        fid=row['id']
        if fid not in known or fid in seen:raise ReviewError('INVALID_FILL_ID','成交ID未知或重复')
        seen.add(fid);f=known[fid]
        fields={k:row[k] or None for k in EDIT_FIELDS[3:] if k in row}
        candidate=normalize({**f,**fields},{'account':f['account'],'provider':f['provider'],'environment':f['environment']})
        invalid=[i for i in candidate['issues'] if i.startswith('INVALID') or i=='DIRECTION_CONFLICT']
        if invalid:raise ReviewError('INVALID_PATCH','补录字段无效：'+','.join(invalid))
        updates.append((fid,{'fill_id':fid,'fields':fields,'evidence':row['evidence'],'recorded_at':now()},int(row['version'])))
    with store.db:
        for fid,payload,version in updates:store.add_document('fill_patch',fid,payload,version)
    return {'revised_fills':len(updates)}


def resolve_exception(store,exception_id,decision,evidence,expected_version=0):
    row=store.db.execute('SELECT * FROM exceptions WHERE id=?',(exception_id,)).fetchone()
    if not row or row['code'] not in ('REVISION_CONFLICT','POSSIBLE_DUPLICATE','MISSING_FILL_ID'):
        raise ReviewError('INVALID_RESOLUTION','此命令仅处理业务去重/来源冲突；字段缺失请补录')
    if decision not in ('keep-current','exclude-fill') or not evidence.strip():
        raise ReviewError('EVIDENCE_REQUIRED','必须明确保留/排除，并提供证据')
    with store.db:
        store.add_document('resolution',exception_id,dict(exception_id=exception_id,ref=row['ref'],decision=decision,evidence=evidence),expected_version)
    return {'exception_id':exception_id,'decision':decision}
