from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from .common import ReviewError,dumps,export_csv,month_bounds
from .store import Store

def parser():
    p=argparse.ArgumentParser(prog='review',description='本地只读交割单复盘；缺失信息不会被填成零')
    p.add_argument('--data-dir',default='data');p.add_argument('--json',action='store_true')
    commands=p.add_subparsers(dest='command',required=True)
    for name in ('doctor','accounts'):
        c=commands.add_parser(name);c.add_argument('--port',type=int,default=11111)
        if name=='accounts':c.add_argument('--market',choices=['US','HK','HKCC','JP'],default='US');c.add_argument('--firm',default='FUTUSECURITIES')
    c=commands.add_parser('sync-month');c.add_argument('--month',required=True);c.add_argument('--account',required=True)
    c.add_argument('--market',choices=['US','HK','HKCC','JP'],default='US');c.add_argument('--port',type=int,default=11111);c.add_argument('--firm',default='FUTUSECURITIES')
    c=commands.add_parser('import-fills');c.add_argument('--file',required=True);c.add_argument('--account',required=True);c.add_argument('--mapping')
    for command in ('import-opening','import-events','import-coverage','import-statement'):
        c=commands.add_parser(command);c.add_argument('--file',required=True)
    c=commands.add_parser('exceptions');c.add_argument('--month');c.add_argument('--export')
    c=commands.add_parser('export-review-sheet');c.add_argument('--month',required=True);c.add_argument('--out',required=True)
    c=commands.add_parser('export-fill-sheet');c.add_argument('--month',required=True);c.add_argument('--out',required=True)
    c=commands.add_parser('apply-fill-sheet');c.add_argument('--file',required=True)
    c=commands.add_parser('apply-review');c.add_argument('--file',required=True);c.add_argument('--expected-version',type=int)
    for command in ('review-month','export-ledger','reconcile'):
        c=commands.add_parser(command);c.add_argument('--month',required=True)
        if command!='reconcile':c.add_argument('--out',default='output');c.add_argument('--fx-file')
    c=commands.add_parser('resolve-exception');c.add_argument('--id',required=True);c.add_argument('--decision',choices=['keep-current','exclude-fill'],required=True);c.add_argument('--evidence',required=True);c.add_argument('--expected-version',type=int,default=0)
    c=commands.add_parser('reproduce');c.add_argument('--report-id',required=True)
    return p

def dispatch(args,store):
    if hasattr(args,'month') and args.month:month_bounds(args.month)
    if args.command=='doctor':
        from .connector import doctor
        return doctor(args.port)
    if args.command=='accounts':
        from .connector import query
        return query(store.root,'accounts',port=args.port,market=args.market,firm=args.firm)
    if args.command=='sync-month':
        from .sync import sync_month
        return sync_month(store,args.account,args.month,args.market,args.port,args.firm)
    if args.command=='import-fills':
        from .ingest import import_file
        mapping=json.loads(Path(args.mapping).read_text()) if args.mapping else None
        return import_file(store,args.file,args.account,mapping)
    if args.command in ('import-opening','import-events','import-coverage','import-statement'):
        from .reviewing import import_documents
        kind={'import-opening':'opening','import-events':'event','import-coverage':'coverage','import-statement':'statement'}[args.command]
        return import_documents(store,kind,args.file)
    if args.command=='exceptions':
        rows=store.exceptions()
        if args.month:
            ids={f['id'] for f in store.fills() if f['trade_date'][:7]==args.month}
            rows=[r for r in rows if r['ref'] in ids]
        if args.export:export_csv(args.export,rows)
        from collections import Counter
        return {'count':len(rows),'by_code':dict(Counter(x['code'] for x in rows)),'path':args.export}
    if args.command=='export-review-sheet':
        from .reviewing import export_review_sheet
        return export_review_sheet(store,args.month,args.out)
    if args.command=='export-fill-sheet':
        from .reviewing import export_fill_sheet
        return export_fill_sheet(store,args.month,args.out)
    if args.command=='apply-fill-sheet':
        from .reviewing import apply_fill_sheet
        return apply_fill_sheet(store,args.file)
    if args.command=='apply-review':
        from .reviewing import apply_review
        return apply_review(store,args.file,args.expected_version)
    if args.command in ('review-month','export-ledger'):
        from .reporting import write_report
        return write_report(store,args.month,args.out,args.fx_file)
    if args.command=='reconcile':
        from .reporting import analyze
        r=analyze(store.snapshot(),args.month)
        return {'status':r['status'],'issues':r['issue_counts'],'coverage':r['coverage'],'reconciliation':r['reconciliation']}
    if args.command=='resolve-exception':
        from .reviewing import resolve_exception
        return resolve_exception(store,args.id,args.decision,args.evidence,args.expected_version)
    if args.command=='reproduce':
        from .reporting import reproduce
        return reproduce(store,args.report_id)
    raise ReviewError('UNKNOWN_COMMAND','未知命令')

def main(argv=None):
    args=parser().parse_args(argv);store=None
    try:
        store=Store(args.data_dir);result=dispatch(args,store)
        print(dumps(result))
        if result.get('status') in ('DRAFT','PARTIAL','FAILED'):
            return 3 if result['status']=='FAILED' else 4
        return 0
    except ReviewError as exc:
        print(dumps({'error':exc.as_dict()}),file=sys.stderr);return exc.exit_code
    except (ValueError,KeyError,OSError) as exc:
        # Do not echo values of malformed rows or private file contents.
        print(dumps({'error':{'code':'INVALID_INPUT','message':'输入文件或参数无效','type':type(exc).__name__}}),file=sys.stderr);return 2
    finally:
        if store:store.close()
