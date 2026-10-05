import csv
import json
import tempfile
import unittest
from copy import deepcopy
from decimal import Decimal as D
from pathlib import Path

from review.accounting import allocate,compute,metrics
from review.common import ReviewError,csv_rows,digest,export_csv
from review.ingest import import_rows,normalize
from review.store import Store
from review.reporting import analyze,write_report,reproduce
from review.reviewing import apply_review,apply_fill_sheet,export_fill_sheet,import_documents
from review.futu_worker import read_call
from review.sync import transform


def fill(fid,side,mode,qty,price,fee='0',day='2026-08-02',**extra):
    row=dict(fill_id=fid,symbol='US.XYZ',side=side,open_close=mode,qty=str(qty),price=str(price),fee=fee,
        currency='USD',trade_date=day+' 10:00:00',timezone='America/New_York',market='US',asset_type='STOCK',multiplier='1')
    return {**row,**extra}

def snapshot(rows,opening=True):
    fills=[]
    for row in rows:
        f=normalize(row,{'account':row.get('account','test')});f['id']=row['fill_id'];f['source_ref']={};fills.append(f)
    openings=[]
    if opening:
        for k in {(f['account'],f['symbol'],f['currency'],f['market'],f['multiplier']) for f in fills}:
            openings.append(dict(account=k[0],symbol=k[1],currency=k[2],market=k[3],multiplier=k[4],
                as_of='2026-07-01',lots=[],evidence='synthetic empty opening',confirmed=True))
    return dict(fills=fills,exceptions=[],openings=openings,events=[],coverage=[],groups=[],statements=[],batches=[])

class AccountingTests(unittest.TestCase):
    def test_A01_round_trip(self):
        s=snapshot([fill('a','BUY','OPEN',10,100,'1'),fill('b','SELL','CLOSE',10,110,'1',day='2026-08-03')])
        r=compute(s,'2026-08');self.assertEqual(D(r['matches'][0]['net']),D(98));self.assertFalse(r['open_lots'])
    def test_A02_partial_fees(self):
        s=snapshot([fill('a','BUY','OPEN',10,100,'1'),fill('b','SELL','CLOSE',4,110,'.4',day='2026-08-03')])
        r=compute(s,'2026-08');self.assertEqual(D(r['matches'][0]['net']),D('39.2'));self.assertEqual(D(r['open_lots'][0]['fee']),D('.6'))
    def test_A03_cross_month(self):
        s=snapshot([fill('a','BUY','OPEN',10,100,day='2026-07-02'),fill('b','SELL','CLOSE',10,90)])
        self.assertEqual(D(compute(s,'2026-08')['monthly_matches'][0]['net']),D(-100))
    def test_A04_short_option(self):
        meta=dict(asset_type='OPTION',multiplier='100',expiry='2026-09-18',strike='100',cp='P')
        s=snapshot([fill('a','SELL_SHORT','OPEN',2,3,**meta),fill('b','BUY_TO_CLOSE','CLOSE',2,1,day='2026-08-03',**meta)])
        self.assertEqual(D(compute(s,'2026-08')['matches'][0]['net']),D(400))
    def test_A07_accounts_isolated(self):
        s=snapshot([fill('a','BUY','OPEN',1,10,account='one'),fill('b','SELL','CLOSE',1,20,account='two')])
        r=compute(s,'2026-08');self.assertFalse(r['matches']);self.assertTrue(r['issues'])
    def test_A08_unknown_fee_not_zero(self):
        s=snapshot([fill('a','BUY','OPEN',1,10,None),fill('b','SELL','CLOSE',1,20,day='2026-08-03')])
        r=compute(s,'2026-08');self.assertEqual(D(r['matches'][0]['gross']),D(10));self.assertIsNone(r['matches'][0]['net'])
    def test_A08_missing_opening_blocks(self):
        s=snapshot([fill('a','BUY','OPEN',1,10)],False);r=compute(s,'2026-08')
        self.assertFalse(r['matches']);self.assertEqual(r['issues'][0]['code'],'MISSING_OPENING')
    def test_unknown_multiplier_blocks(self):
        s=snapshot([fill('a','BUY','OPEN',1,10,multiplier=None)])
        self.assertFalse(compute(s,'2026-08')['open_lots'])
    def test_A09_expiry_requires_event(self):
        meta=dict(asset_type='OPTION',multiplier='100',expiry='2026-08-21',strike='100',cp='P')
        s=snapshot([fill('a','SELL_SHORT','OPEN',1,2,**meta)])
        self.assertEqual(len(compute(s,'2026-08')['open_lots']),1)
        s['events']=[dict(id='event',account='test',symbol='US.XYZ',currency='USD',market='US',
            trade_date='2026-08-21T16:00:00-04:00',event_type='EXPIRE_WORTHLESS',direction='SHORT',qty='1',fee='0',expiry='2026-08-21')]
        r=compute(s,'2026-08');self.assertEqual(D(r['matches'][0]['net']),D(200));self.assertFalse(r['open_lots'])
    def test_A10_assignment_fails_closed(self):
        s=snapshot([fill('a','SELL_SHORT','OPEN',1,2)])
        s['events']=[dict(id='event',account='test',symbol='US.XYZ',currency='USD',market='US',
            trade_date='2026-08-21T16:00:00-04:00',event_type='ASSIGNMENT',direction='SHORT',qty='1',fee='0')]
        r=compute(s,'2026-08');self.assertFalse(r['matches']);self.assertEqual(r['issues'][0]['code'],'UNSUPPORTED_LIFECYCLE')
    def test_A10_standard_short_put_assignment_transfers_basis(self):
        meta=dict(symbol='US.XYZ260821P100000',asset_type='OPTION',multiplier='100',expiry='2026-08-21',strike='100',cp='P')
        s=snapshot([fill('a','SELL_SHORT','OPEN',1,2,'1',**meta)])
        s['openings'].append(dict(account='test',symbol='US.XYZ',currency='USD',market='US',multiplier='1',as_of='2026-07-01',lots=[]))
        s['events']=[dict(id='assigned',account='test',symbol=meta['symbol'],currency='USD',market='US',
            trade_date='2026-08-21T16:00:00-04:00',event_type='ASSIGNMENT',direction='SHORT',qty='1',fee='2',
            cp='P',strike='100',target_symbol='US.XYZ',deliverable='STANDARD_SHARES')]
        r=compute(s,'2026-08');self.assertFalse(r['issues']);self.assertFalse(r['monthly_matches'])
        lot=r['open_lots'][0];self.assertEqual(D(lot['price'])*D(lot['qty'])+D(lot['fee']),D(9803))
        stock=normalize(fill('sold','SELL','CLOSE',100,110,'1',day='2026-08-24'),{'account':'test'});stock['id']='sold'
        s['fills'].append(stock);s['groups']=[dict(group_id='g',strategy='put-assignment',member_ids=['a','assigned','sold'])]
        r=analyze(s,'2026-08');self.assertEqual(D(r['summary'][0]['net']),D(1196));self.assertEqual(r['stats'][0]['n'],1)
    def test_long_call_exercise_transfers_debit(self):
        meta=dict(symbol='US.XYZ260821C100000',asset_type='OPTION',multiplier='100',expiry='2026-08-21',strike='100',cp='C')
        s=snapshot([fill('a','BUY','OPEN',1,2,**meta)])
        s['openings'].append(dict(account='test',symbol='US.XYZ',currency='USD',market='US',multiplier='1',as_of='2026-07-01',lots=[]))
        s['events']=[dict(id='exercised',account='test',symbol=meta['symbol'],currency='USD',market='US',
            trade_date='2026-08-21T16:00:00-04:00',event_type='EXERCISE',direction='LONG',qty='1',fee='0',
            cp='C',strike='100',target_symbol='US.XYZ',deliverable='STANDARD_SHARES')]
        r=compute(s,'2026-08');self.assertFalse(r['issues']);self.assertEqual(D(r['open_lots'][0]['price']),D(102))
    def test_bad_option_event_blocks_delivered_stock_profit(self):
        meta=dict(symbol='US.XYZ260821P100000',asset_type='OPTION',multiplier='100',expiry='2026-08-21',strike='100',cp='P')
        s=snapshot([fill('a','SELL_SHORT','OPEN',1,2,**meta),fill('sale','SELL','CLOSE',100,110,day='2026-08-24')])
        s['events']=[dict(id='assigned',account='test',symbol=meta['symbol'],currency='USD',market='US',
            trade_date='2026-08-21T16:00:00-04:00',event_type='ASSIGNMENT',direction='SHORT',qty='2',fee='0',
            cp='P',strike='100',target_symbol='US.XYZ',deliverable='STANDARD_SHARES')]
        r=compute(s,'2026-08');self.assertFalse(r['monthly_matches']);self.assertTrue(r['issues'])
    def test_A12_orphan_discards_instrument_partial_pnl(self):
        s=snapshot([fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,20,day='2026-08-03'),
            fill('c','SELL','CLOSE',1,20,day='2026-08-04')])
        r=compute(s,'2026-08');self.assertFalse(r['matches']);self.assertEqual(r['issues'][0]['code'],'ORPHAN_CLOSE')
    def test_A13_flat_groups(self):
        r=metrics(['100','-50','0']);self.assertEqual(r['n'],3);self.assertEqual(D(r['ev']),D(50)/3)
        self.assertEqual(r['flat'],1);self.assertEqual(D(r['win_rate']),D(1)/3)
    def test_zero_loss_payoff_is_null(self):self.assertIsNone(metrics(['1','2'])['payoff_ratio'])
    def test_tie_without_sequence_blocks(self):
        s=snapshot([fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,20)])
        self.assertEqual(compute(s,'2026-08')['issues'][0]['code'],'AMBIGUOUS_ORDER')
    def test_late_fill_not_in_earlier_month(self):
        s=snapshot([fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,20,day='2026-09-03')])
        self.assertFalse(compute(s,'2026-08')['matches'])
    def test_decimal_allocation_conserves(self):
        parts=allocate(D('1'),[D(1),D(1),D(1)]);self.assertEqual(sum(parts),D(1))
    def test_invalid_nan_and_negative_quantities(self):
        for q in ('NaN','Infinity','-1','0'):
            f=normalize(fill('a','BUY','OPEN',q,10),{'account':'x'});self.assertIn('INVALID_QTY',f['issues'])
    def test_dst_ambiguous_time_blocks(self):
        f=normalize(fill('a','BUY','OPEN',1,10,day='2026-11-01',trade_date='2026-11-01 01:30:00'),{'account':'x'})
        self.assertIn('AMBIGUOUS_LOCAL_TIME',f['issues'])
    def test_same_instrument_currencies_isolated(self):
        s=snapshot([fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,20,currency='HKD',day='2026-08-03')])
        self.assertFalse(compute(s,'2026-08')['matches'])

class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.s=Store(self.root/'data')
    def tearDown(self):self.s.close();self.temp.cleanup()
    def ingest(self,rows,sha='source'):
        return import_rows(self.s,rows,{'account':'test'},sha,'fixture.csv')
    def test_A05_idempotency(self):
        rows=[fill('a','BUY','OPEN',1,10)];self.ingest(rows);r=self.ingest(rows)
        self.assertEqual(r['duplicates'],1);self.assertEqual(len(self.s.fills()),1)
    def test_A06_distinct_fill_ids_preserved(self):
        self.ingest([fill('a','BUY','OPEN',1,10),fill('b','BUY','OPEN',1,10)])
        self.assertEqual(len(self.s.fills()),2)
    def test_no_id_cross_file_similarity_kept(self):
        row=fill(None,'BUY','OPEN',1,10);self.ingest([row],'one');self.ingest([row],'two')
        self.assertEqual(len(self.s.fills()),2)
        self.assertEqual(sum(e['code']=='POSSIBLE_DUPLICATE' for e in self.s.exceptions()),2)
    def test_revision_conflict_does_not_overwrite(self):
        self.ingest([fill('a','BUY','OPEN',1,10)]);self.ingest([fill('a','BUY','OPEN',1,20)])
        self.assertEqual(self.s.fills()[0]['price'],'10');self.assertTrue(any(e['code']=='REVISION_CONFLICT' for e in self.s.exceptions()))
    def test_whitelist_drops_private_csv_columns(self):
        self.ingest([{**fill('a','BUY','OPEN',1,10),'password':'DO_NOT_ARCHIVE','acc_id':'DO_NOT_ARCHIVE'}])
        raw=self.s.db.execute('SELECT payload FROM raw_records').fetchone()[0];self.assertNotIn('DO_NOT_ARCHIVE',raw)
    def test_A18_missing_fields_no_pnl(self):
        row={'symbol':'US.X','side':'BUY','qty':'1','price':'1','trade_date':'2026-08-02 10:00:00'}
        self.ingest([row]);r=analyze(self.s.snapshot(),'2026-08')
        self.assertEqual(r['status'],'DRAFT');self.assertFalse(r['summary']);self.assertIn('MISSING_FEE',r['issue_counts'])
    def test_fill_patch_append_and_version_conflict(self):
        self.ingest([fill('a','BUY','OPEN',1,10,fee=None)])
        p=self.root/'edit.csv';export_fill_sheet(self.s,'2026-08',p);rows=csv_rows(p)
        rows[0]['fee']='0';rows[0]['evidence']='synthetic fee receipt';export_csv(p,rows)
        apply_fill_sheet(self.s,p);self.assertEqual(self.s.fills()[0]['fee'],'0')
        self.assertNotIn('MISSING_FEE',[x['code'] for x in self.s.exceptions()])
        with self.assertRaises(ReviewError):apply_fill_sheet(self.s,p)
        original=json.loads(self.s.db.execute('SELECT payload FROM fills').fetchone()[0]);self.assertIsNone(original['fee'])
    def ready(self):
        self.ingest([fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,20,day='2026-08-03')])
        opening=snapshot([fill('a','BUY','OPEN',1,10)])['openings'][0]
        with self.s.db:self.s.add_document('opening','one',opening)
    def test_A16_review_version_conflict(self):
        self.ready();ids=[f['id'] for f in self.s.fills()];p=self.root/'groups.csv'
        export_csv(p,[dict(group_id='g',version=0,member_ids=';'.join(ids),strategy='long',confirmed='true')])
        apply_review(self.s,p)
        with self.assertRaises(ReviewError):apply_review(self.s,p)
    def test_overlapping_strategy_group_rejected(self):
        self.ready();ids=[f['id'] for f in self.s.fills()];p=self.root/'groups.csv'
        export_csv(p,[dict(group_id=g,version=0,member_ids=';'.join(ids),strategy='long',confirmed='true') for g in ('g1','g2')])
        with self.assertRaises(ReviewError):apply_review(self.s,p)
        self.assertEqual(self.s.documents('group'),[])
    def test_A19_report_reproducible_and_immutable(self):
        self.ready();r=write_report(self.s,'2026-08',self.root/'output')
        self.assertTrue(reproduce(self.s,r['report_id'])['verified'])
        self.assertTrue(write_report(self.s,'2026-08',self.root/'output')['reused'])
        Path(r['path']).write_text('tampered')
        with self.assertRaises(ReviewError):reproduce(self.s,r['report_id'])
    def test_csv_formula_escaped(self):
        p=self.root/'safe.csv';export_csv(p,[{'note':'=HYPERLINK("x")','number':'-12.3'}])
        row=csv_rows(p)[0];self.assertTrue(row['note'].startswith("'="));self.assertEqual(row['number'],'-12.3')
    def test_database_raw_rows_are_append_only(self):
        import sqlite3
        self.ingest([fill('a','BUY','OPEN',1,10)])
        with self.assertRaises(sqlite3.IntegrityError):self.s.db.execute('DELETE FROM fills')
        self.s.db.rollback();self.assertEqual(len(self.s.fills()),1)
    def test_duplicate_resolution_retains_audit_and_excluded_row(self):
        from review.reviewing import resolve_exception
        row=fill(None,'BUY','OPEN',1,10);self.ingest([row],'one');self.ingest([row],'two')
        exceptions=[e for e in self.s.exceptions() if e['code']=='POSSIBLE_DUPLICATE']
        resolve_exception(self.s,exceptions[0]['id'],'exclude-fill','synthetic duplicate receipt')
        resolve_exception(self.s,exceptions[1]['id'],'keep-current','synthetic original receipt')
        self.assertEqual(len(self.s.fills()),1);self.assertEqual(len(self.s.snapshot()['excluded_fills']),1)
        self.assertEqual(self.s.db.execute('SELECT COUNT(*) FROM fills').fetchone()[0],2)
    def test_statement_difference_prevents_final(self):
        self.ready()
        with self.s.db:
            self.s.add_document('coverage','one',dict(account='test',market='US',month='2026-08',confirmed=True,complete=True,evidence='mock'))
            self.s.add_document('statement','one',dict(account='test',month='2026-08',net={'USD':'999'},fee={'USD':'0'},positions=[],evidence='mock'))
        r=analyze(self.s.snapshot(),'2026-08');self.assertEqual(r['status'],'PARTIAL')
        self.assertTrue(any(c['status']=='FAIL' for c in r['reconciliation']))
    def test_A15_sync_retries_record_attempts(self):
        from unittest.mock import patch
        from review.sync import sync_month
        success={'query':{'account':'test','market':'US'},'results':{'fills':{'status':'OK','rows':[]},'orders':{'status':'OK','rows':[]},'fees':{'status':'OK','rows':[]}}}
        with patch('review.sync.query',side_effect=[ReviewError('TIMEOUT','test',exit_code=3),success]) as query,patch('time.sleep'):
            result=sync_month(self.s,'test','2026-08')
        self.assertEqual(query.call_count,2);self.assertEqual(result['rows'],0)
        self.assertEqual(len(list((self.s.root/'raw').glob('*.json'))),2)
    def test_candidates_use_connected_full_lifecycle(self):
        from review.candidates import propose
        self.ready();r=propose(self.s.snapshot(),'2026-08')
        self.assertEqual(len(r),1);self.assertEqual(len(r[0]['member_ids']),2);self.assertEqual(r[0]['confirmed'],'false')
    def test_cli_help_and_invalid_month(self):
        from contextlib import redirect_stdout,redirect_stderr
        from io import StringIO
        from review.cli import main
        with redirect_stdout(StringIO()),redirect_stderr(StringIO()):
            code=main(['--data-dir',str(self.s.root),'review-month','--month','nonsense'])
        self.assertEqual(code,2)
    def test_missing_statement_cannot_be_final(self):
        self.ready()
        with self.s.db:self.s.add_document('coverage','one',dict(account='test',market='US',month='2026-08',confirmed=True,complete=True,evidence='mock'))
        self.assertEqual(analyze(self.s.snapshot(),'2026-08')['status'],'PARTIAL')

class ReportTests(unittest.TestCase):
    def test_A11_combination_count_one(self):
        rows=[fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,20,day='2026-08-03'),
              fill('c','BUY','OPEN',1,10,symbol='US.ABC'),fill('d','SELL','CLOSE',1,5,day='2026-08-03',symbol='US.ABC')]
        s=snapshot(rows);s['groups']=[dict(group_id='g',strategy='spread',member_ids=['a','b','c','d'])]
        r=analyze(s,'2026-08');self.assertEqual(r['stats'][0]['n'],1);self.assertEqual(D(r['stats'][0]['ev']),D(5))
    def test_A17_group_month_bridge(self):
        s=snapshot([fill('a','BUY','OPEN',2,10,day='2026-07-02'),fill('b','SELL','CLOSE',1,12,day='2026-07-03'),
            fill('c','SELL','CLOSE',1,13,day='2026-08-03')])
        s['groups']=[dict(group_id='g',strategy='long',member_ids=['a','b','c'])]
        r=analyze(s,'2026-08');g=r['groups'][0]
        self.assertEqual(D(g['net']),D(5));self.assertEqual(D(g['before_month_net']),D(2));self.assertEqual(D(r['summary'][0]['net']),D(3))
    def test_partial_group_excluded(self):
        s=snapshot([fill('a','BUY','OPEN',2,10),fill('b','SELL','CLOSE',1,12,day='2026-08-03')])
        s['groups']=[dict(group_id='g',strategy='long',member_ids=['a','b'])]
        self.assertFalse(analyze(s,'2026-08')['stats'])
    def test_A14_missing_and_stale_fx(self):
        rows=[fill('a','BUY','OPEN',1,10),fill('b','SELL','CLOSE',1,110,day='2026-08-03')]
        r=analyze(snapshot(rows),'2026-08',[dict(currency='USD',date='2026-08-31',rate='7.2',source='synthetic')])
        self.assertEqual(D(r['cny']['value']),D(720));self.assertEqual(r['cny']['status'],'PARTIAL')
        stale=analyze(snapshot(rows),'2026-08',[dict(currency='USD',date='2026-08-01',rate='7.2',source='synthetic')])
        self.assertTrue(stale['cny']['excluded'])
    def test_A20_read_allowlist(self):
        class Spy:
            def place_order(self,**kwargs):raise AssertionError('MUTATION WAS CALLED')
            def get_acc_list(self):return 0,[]
        self.assertEqual(read_call(Spy(),'get_acc_list'),(0,[]))
        with self.assertRaises(ValueError):read_call(Spy(),'place_order')
    def test_sync_month_boundary_and_complete_fee(self):
        raw=[dict(deal_id='a',order_id='o',qty=1,price=10,code='US.X',trd_side='BUY',create_time='2026-07-31 10:00:00',deal_market='US'),
             dict(deal_id='b',order_id='o',qty=1,price=10,code='US.X',trd_side='BUY',create_time='2026-08-01 10:00:00',deal_market='US')]
        response={'query':{'market':'US'},'results':{'fills':{'rows':raw},'orders':{'rows':[dict(order_id='o',dealt_qty=2,order_status='FILLED_ALL',currency='USD')]},
            'fees':{'rows':[dict(order_id='o',fee_amount=1)]}}}
        rows,out=transform(response,'2026-08');self.assertEqual(len(rows),1);self.assertEqual(out,1);self.assertEqual(rows[0]['fee'],'0.5')
        response['results']['orders']['rows'][0]['dealt_qty']=3
        self.assertIsNone(transform(response,'2026-08')[0][0]['fee'])

if __name__=='__main__':unittest.main()
