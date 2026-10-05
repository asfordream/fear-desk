from __future__ import annotations
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from .common import ReviewError, csv_rows, decimal, digest, dumps, now

FIELDS = ('fill_id','order_id','symbol','underlying','side','open_close','qty','price','fee','currency',
          'trade_date','timezone','market','asset_type','multiplier','expiry','strike','cp','sequence')
SIDE_MAP={'买入':'BUY','卖出':'SELL','卖空':'SELL_SHORT','买入平仓':'BUY_TO_CLOSE',
          'BTO':'BUY','STC':'SELL','STO':'SELL_SHORT','BTC':'BUY_TO_CLOSE'}
OPEN_MAP={'BTO':'OPEN','STO':'OPEN','STC':'CLOSE','BTC':'CLOSE'}

def normalize(row,context):
    mapping=context.get('mapping',{}); columns=mapping.get('columns',{}); defaults=mapping.get('defaults',{})
    f={k:row.get(columns.get(k,k)) or defaults.get(k) for k in FIELDS}
    issues=[]
    f['account']=context['account']; f['provider']=context.get('provider','futu')
    f['environment']=context.get('environment','REAL')
    original=f['side']; f['side']=SIDE_MAP.get(original,original)
    f['open_close']=f.get('open_close') or OPEN_MAP.get(original,'UNKNOWN')
    if f['side'] not in {'BUY','SELL','SELL_SHORT','BUY_TO_CLOSE'}: issues.append('UNKNOWN_SIDE')
    if f['open_close'] not in {'OPEN','CLOSE'}: issues.append('UNKNOWN_OPEN_CLOSE')
    if (f['open_close']=='OPEN' and f['side']=='BUY_TO_CLOSE') or (f['open_close']=='CLOSE' and f['side']=='SELL_SHORT'):issues.append('DIRECTION_CONFLICT')
    if f.get('sequence'):
        try:
            seq=decimal(f['sequence'],nonnegative=True)
            if seq!=seq.to_integral_value():raise ValueError()
            f['sequence']=str(int(seq))
        except (ReviewError,ValueError):issues.append('INVALID_SEQUENCE');f['sequence']=None
    if not f['symbol']: issues.append('MISSING_SYMBOL')
    for field in ('qty','price','fee','multiplier'):
        try:
            v=decimal(f[field],optional=field in ('fee','multiplier'),positive=field in ('qty','multiplier'),nonnegative=field=='price')
            f[field]=str(v) if v is not None else None
        except ReviewError: issues.append('INVALID_'+field.upper());f[field]=None
    if f['fee'] is None: issues.append('MISSING_FEE')
    if f['multiplier'] is None: issues.append('MISSING_MULTIPLIER')
    for field in ('currency','market','asset_type'):
        if not f[field]: issues.append('MISSING_'+field.upper())
    if f['asset_type'] and f['asset_type'] not in ('STOCK','ETF','OPTION'): issues.append('UNSUPPORTED_ASSET')
    if f['asset_type']=='OPTION':
        if not all(f.get(x) for x in ('expiry','strike','cp')):issues.append('MISSING_OPTION_METADATA')
        elif f['cp'] not in ('C','P'):issues.append('INVALID_OPTION_METADATA')
        else:
            try:
                from datetime import date
                date.fromisoformat(f['expiry']);decimal(f['strike'],positive=True)
            except (ValueError,ReviewError):issues.append('INVALID_OPTION_METADATA')
    f['executed_at']=None
    try:
        dt=datetime.fromisoformat(f['trade_date'] or '')
        if not f['timezone']:issues.append('MISSING_TIMEZONE')
        else:
            zone=ZoneInfo(f['timezone'])
            if dt.tzinfo is None:
                a=dt.replace(tzinfo=zone,fold=0);b=dt.replace(tzinfo=zone,fold=1)
                if a.utcoffset()!=b.utcoffset():issues.append('AMBIGUOUS_LOCAL_TIME')
                elif a.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)!=dt:issues.append('INVALID_LOCAL_TIME')
                dt=a
            f['executed_at']=dt.astimezone(timezone.utc).isoformat()
            f['trade_date']=dt.astimezone(zone).isoformat()
    except (ValueError,ZoneInfoNotFoundError):issues.append('INVALID_TIME')
    f['issues']=sorted(set(issues));return f

def import_rows(store,rows,context,source_hash,source_name):
    # Whitelist input columns in the immutable archive: never retain accidentally supplied account/password fields.
    batch=str(uuid.uuid4()); added=duplicate=conflicts=0
    with store.db:
        store.db.execute('INSERT INTO batches VALUES(?,?,?,?,?,?)',(batch,source_hash,source_name,dumps(context),'STARTED',now()))
        for i,row in enumerate(rows,2):
            f=normalize(row,context)
            mapping=context.get('mapping',{}).get('columns',{})
            allowed={mapping.get(k,k) for k in FIELDS}
            raw={k:v for k,v in row.items() if k in allowed}
            store.db.execute('INSERT INTO raw_records(batch_id,source_row,payload) VALUES(?,?,?)',(batch,i,dumps(raw)))
            # Include importer context: a file imported into another account is not the same fill.
            scope=[f['provider'],f['environment'],f['account']]
            fid=digest(scope+[f['fill_id']]) if f['fill_id'] else digest(scope+[source_hash,i])
            f['id']=fid;f['source_ref']={'batch':batch,'row':i}
            canonical={k:v for k,v in f.items() if k not in ('source_ref','id','issues')}
            fingerprint=digest(canonical)
            old=store.db.execute('SELECT fingerprint FROM fills WHERE id=?',(fid,)).fetchone()
            if old:
                if old[0]!=fingerprint:
                    conflicts+=1;store.exception('REVISION_CONFLICT',fid,'同一成交键出现不同内容，需核实来源',batch)
                else: duplicate+=1
                continue
            if not f['fill_id']:
                store.exception('MISSING_FILL_ID',fid,'无法可靠跨文件去重',batch)
                # Preserve all matches; mark both sides, never silently delete them.
                similarity=digest([f.get(k) for k in ('account','symbol','trade_date','side','qty','price')])
                for oldrow in store.db.execute('SELECT id,payload FROM fills WHERE account=? AND symbol=? AND trade_date=?',
                        (f['account'],f['symbol'] or '',f['trade_date'] or '')):
                    other=json.loads(oldrow['payload'])
                    if digest([other.get(k) for k in ('account','symbol','trade_date','side','qty','price')])==similarity:
                        store.exception('POSSIBLE_DUPLICATE',fid,'与另一记录相似：'+oldrow['id'],batch)
                        store.exception('POSSIBLE_DUPLICATE',oldrow['id'],'与另一记录相似：'+fid,batch)
            for issue in f['issues']:store.exception(issue,fid,'补充有据字段后使用独立修订流程；勿直接覆写原始账本',batch)
            store.db.execute('INSERT INTO fills VALUES(?,?,?,?,?,?,?)',
                (fid,f['account'],f['symbol'] or '',f['trade_date'] or '',fingerprint,dumps(f),batch));added+=1
        status='PARTIAL' if conflicts or any(normalize(r,context)['issues'] for r in rows) else 'IMPORTED'
        store.db.execute('UPDATE batches SET status=? WHERE id=?',(status,batch))
        store.audit('import',dict(batch=batch,added=added,duplicates=duplicate,conflicts=conflicts))
    return dict(batch_id=batch,rows=len(rows),inserted=added,duplicates=duplicate,conflicts=conflicts,status=status)

def import_file(store,path,account,mapping=None):
    p=Path(path)
    context={'account':account,'provider':'futu','mapping':mapping or {}}
    return import_rows(store,csv_rows(p),context,digest(p.read_bytes()),p.name)
