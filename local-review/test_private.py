import copy
import json
from pathlib import Path
import tempfile
import unittest
from fastapi.testclient import TestClient
from domain import database,seed,get,signals,create_case,mutate_case,compute_report,save_report,Fault,append,evidence
from service import create_app
from scheduler import due_months,tick
from datetime import datetime,timezone

class PrivateTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.token='x'*64
        self.client=TestClient(create_app(self.root,self.token),base_url='http://127.0.0.1:18761',headers={'authorization':'Bearer '+self.token})
    def tearDown(self):self.temp.cleanup()
    def fixture(self):
        with database(self.root,'demo') as s:return seed(s,{'idempotency_key':'fixture'})
    def test_guard_and_isolation(self):
        self.assertEqual(self.client.get('/api/review/v1/health',headers={'authorization':''}).status_code,403)
        self.assertEqual(self.client.get('/api/review/v1/health',headers={'host':'evil.test'}).status_code,403)
        self.assertEqual(self.client.get('/api/review/v1/health',headers={'origin':'http://evil.test'}).status_code,403)
        self.assertEqual(self.client.post('/api/review/v1/live/demo',json={}).status_code,403)
        self.fixture()
        self.assertEqual(self.client.get('/api/review/v1/live/overview').json()['data']['fills'],[])
    def test_loop_decimal_evidence_and_restart(self):
        info=self.fixture()
        with database(self.root,'demo') as s:
            r=compute_report(s,'2026-08');self.assertEqual(r['result']['summary'][0]['gross'],'100');self.assertEqual(r['result']['summary'][0]['net'],'98');self.assertEqual(r['result']['summary'][0]['fee'],'2')
            f=s.fills()[0];e=evidence(s,f['id']);self.assertEqual(e['raw']['fill_id'],f['fill_id']);self.assertTrue(e['source_hash'])
            cid=info['case_id'];plan=get(s,'case',cid)['plans'][0]
        self.fixture()
        with database(self.root,'demo') as s:
            self.assertEqual(get(s,'case',cid)['plans'][0],plan)
            self.assertEqual(compute_report(s,'2026-08')['id'],r['id'])
            self.assertEqual(len(s.fills()),2)
        self.assertTrue(self.client.get('/api/review/v1/demo/reports/'+r['id']+'/reproduce').json()['data']['verified'])
    def test_signal_frozen_and_version_idempotency(self):
        info=self.fixture()
        with database(self.root,'demo') as s:
            c=get(s,'case',info['case_id']);original=copy.deepcopy(c['plans'][0]['signal']);sig=copy.deepcopy(original);sig.pop('version');sig.pop('id');sig.pop('source_hash');sig.pop('recorded_at');sig['indicators']['fear']['value']='12'
            signals(s,{'idempotency_key':'next-signal','signal':sig})
            self.assertEqual(get(s,'case',c['id'])['plans'][0]['signal'],original)
            b={'expected_version':c['version'],'idempotency_key':'recall','text':'事后回忆'}
            a=mutate_case(s,c['id'],'recall',b);self.assertEqual(mutate_case(s,c['id'],'recall',b),a)
            with self.assertRaises(Fault):mutate_case(s,c['id'],'recall',{**b,'text':'另一内容'})
            with self.assertRaises(Fault):mutate_case(s,c['id'],'recall',{**b,'idempotency_key':'stale'})
    def test_overallocation_and_identity_conflict(self):
        info=self.fixture()
        with database(self.root,'demo') as s:
            c=get(s,'case',info['case_id']);f=s.fills()[0]
            with self.assertRaises(Fault) as exc:mutate_case(s,c['id'],'allocate',{'expected_version':c['version'],'idempotency_key':'over','fill_id':f['id'],'quantity':'0.1'})
            self.assertEqual(exc.exception.code,'OVER_ALLOCATION')
            p=copy.deepcopy(c['plans'][0]['plan']);p['identity']['market']='HK'
            with self.assertRaises(Fault):create_case(s,{'idempotency_key':'wrong','signal_id':c['signal']['id'],'plan':p})
    def test_future_opening_cannot_replace_history(self):
        self.fixture()
        with database(self.root,'demo') as s:
            old=get(s,'opening','fixture-opening')
            with s.db:append(s,'opening','fixture-opening',{**old,'as_of':'2026-09-01','lots':[]},1)
            self.assertEqual(compute_report(s,'2026-08')['result']['summary'][0]['net'],'98')
    def test_unknown_fee_and_cross_month(self):
        self.fixture()
        with database(self.root,'demo') as s:
            from review.ingest import import_rows
            rows=[{'fill_id':'partial','symbol':'US.ZZZ','side':'BUY','open_close':'OPEN','qty':'10','price':'0.1','fee':'1','currency':'USD','trade_date':'2026-07-31T10:00:00','timezone':'America/New_York','market':'US','asset_type':'STOCK','multiplier':'1'},
                  {'fill_id':'partial-close','symbol':'US.ZZZ','side':'SELL','open_close':'CLOSE','qty':'3','price':'0.2','fee':None,'currency':'USD','trade_date':'2026-08-01T10:00:00','timezone':'America/New_York','market':'US','asset_type':'STOCK','multiplier':'1'}]
            import_rows(s,rows,{'account':'demo','provider':'synthetic','environment':'SIMULATE'},'hash','SYNTHETIC')
            with s.db:append(s,'opening','z',{'account':'demo','symbol':'US.ZZZ','currency':'USD','market':'US','environment':'SIMULATE','multiplier':'1','as_of':'2026-01-01','lots':[],'evidence':'fixture'},0)
            r=compute_report(s,'2026-08')['result'];m=next(m for m in r['accounting']['monthly_matches'] if m['symbol']=='US.ZZZ')
            self.assertEqual(m['gross'],'0.3');self.assertIsNone(m['net']);self.assertIsNone(r['summary'][0]['net'])
    def test_month_boundary_recovery_no_duplicate(self):
        self.assertEqual(due_months(datetime.fromisoformat('2026-10-03T00:59:00+00:00'))[-1],'2026-08')
        self.assertEqual(due_months(datetime.fromisoformat('2026-10-03T01:00:00+00:00'))[-1],'2026-09')
        self.fixture();t=datetime.fromisoformat('2026-10-05T01:00:00+00:00');tick(self.root,'demo',t)
        with database(self.root,'demo') as s:
            count=s.db.execute('SELECT COUNT(*) FROM documents WHERE kind="monthly_report"').fetchone()[0]
            with s.db:s.db.execute('UPDATE monthly_jobs SET status="running",lease_id="crashed",lease_until="2026-01-01" WHERE month="2026-08"')
        tick(self.root,'demo',t)
        with database(self.root,'demo') as s:
            self.assertEqual(s.db.execute('SELECT COUNT(*) FROM documents WHERE kind="monthly_report"').fetchone()[0],count)
            self.assertEqual(s.db.execute('SELECT status FROM monthly_jobs WHERE month="2026-08"').fetchone()[0],'completed')
    def test_coverage_without_fills_and_invalid_input(self):
        with database(self.root,'demo') as s:
            with s.db:append(s,'coverage','empty',{'account':'demo','market':'HK','month':'2026-02','evidence':'empty period declaration'},0)
            r=compute_report(s,'2026-02')['result'];self.assertEqual(r['coverage'][0]['market'],'HK');self.assertEqual(r['status'],'DRAFT')
        self.assertEqual(self.client.post('/api/review/v1/demo/signals',json={'bad':True}).status_code,422)
        self.assertEqual(self.client.post('/api/review/v1/demo/cases',json={}).status_code,422)

    def test_malformed_document_rejected_before_storage(self):
        for kind,value in [('event',{'account':'demo','market':'US','evidence':'fixture'}),('opening',{'account':'demo','market':'US','evidence':'fixture','as_of':'2026-08-01T00:00:00+00:00','multiplier':'1','lots':[]}),('statement',{'account':'demo','market':'US','month':'2026-08','evidence':'fixture'})]:
            response=self.client.post('/api/review/v1/demo/documents',json={'idempotency_key':kind,'kind':kind,'key':kind,'expected_version':0,'document':value})
            self.assertEqual(response.status_code,422,(kind,response.text))
        with database(self.root,'demo') as store:
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM documents').fetchone()[0],0)
    def test_case_mutation_invalidates_completed_jobs(self):
        info=self.fixture();clock=datetime.fromisoformat('2026-10-05T01:00:00+00:00');tick(self.root,'demo',clock)
        with database(self.root,'demo') as store:
            c=get(store,'case',info['case_id'])
            mutate_case(store,c['id'],'unallocate',{'expected_version':c['version'],'idempotency_key':'remove','allocation_id':c['allocations'][0]['id'],'reason':'fixture correction'})
            self.assertEqual(store.db.execute('SELECT status FROM monthly_jobs WHERE month="2026-08"').fetchone()[0],'pending')
    def test_attribution_currency_and_complete_replay(self):
        self.fixture()
        with database(self.root,'demo') as store:
            report=compute_report(store,'2026-08');portion=report['result']['attribution'][0]['portions'][0]
            self.assertEqual(portion['currency'],'USD')
            report['result']['attribution'][0]['portions'][0]['net']='999'
            with store.db:stored=append(store,'monthly_report',report['id'],report,1)
        response=self.client.get('/api/review/v1/demo/reports/'+stored['id']+'/reproduce')
        self.assertEqual(response.status_code,409)
    def test_dirty_generation_survives_running_job(self):
        from scheduler import invalidate
        self.fixture()
        with database(self.root,'demo') as store:
            with store.db:store.db.execute('INSERT INTO monthly_jobs(month,status,lease_until,lease_id) VALUES("2026-08","running","2099-01-01","owner")')
            before=store.db.execute('SELECT generation FROM review_state').fetchone()[0]
            with store.db:invalidate(store)
            self.assertGreater(store.db.execute('SELECT generation FROM review_state').fetchone()[0],before)


    def test_draft_missing_strategy_can_be_reported(self):
        with database(self.root,'demo') as store:
            create_case(store,{'idempotency_key':'empty-plan','plan':{'identity':{'provider':'synthetic','market':'US','asset_type':'STOCK','symbol':'US.XYZ'}}})
            self.assertEqual(compute_report(store,'2099-01')['result']['retrospective']['cases'][0]['strategy'],'UNCLASSIFIED')

    def test_concurrent_allocations_never_overconsume(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        info=self.fixture()
        with database(self.root,'demo') as store:
            original=get(store,'case',info['case_id']);plan=original['plans'][0]['plan']
            for a in original['allocations']:
                original=mutate_case(store,original['id'],'unallocate',{'expected_version':original['version'],'idempotency_key':a['id'],'allocation_id':a['id'],'reason':'concurrency fixture'})
            cases=[create_case(store,{'idempotency_key':str(i),'plan':plan}) for i in range(2)]
            fid=store.fills()[0]['id']
        barrier=Barrier(2)
        def allocate(c):
            with database(self.root,'demo') as store:
                barrier.wait()
                try:
                    mutate_case(store,c['id'],'allocate',{'expected_version':c['version'],'idempotency_key':c['id'],'fill_id':fid,'quantity':'6'})
                    return 'OK'
                except Fault as e:return e.code
        with ThreadPoolExecutor(max_workers=2) as pool:outcomes=list(pool.map(allocate,cases))
        self.assertEqual(sorted(outcomes),['OK','OVER_ALLOCATION'])

    def test_input_changed_during_compute_stays_pending(self):
        from unittest.mock import patch
        import scheduler
        self.fixture();real_compute=scheduler.compute_report
        def changed(store,month):
            report=real_compute(store,month)
            if month=='2026-08':
                with database(self.root,'demo') as another:
                    from scheduler import invalidate
                    with another.db:invalidate(another)
            return report
        with patch.object(scheduler,'compute_report',side_effect=changed):tick(self.root,'demo',datetime.fromisoformat('2026-10-05T01:00:00+00:00'))
        with database(self.root,'demo') as store:self.assertEqual(store.db.execute('SELECT status FROM monthly_jobs WHERE month="2026-08"').fetchone()[0],'pending')

    def test_sqlite_backup_restore_preserves_evidence_and_report(self):
        import sqlite3
        self.fixture()
        with tempfile.TemporaryDirectory() as restored:
            restored=Path(restored)
            with database(self.root,'demo') as store:
                report=save_report(store,compute_report(store,'2026-08'));fid=store.fills()[0]['id'];raw=evidence(store,fid)
                target=restored/'demo';target.mkdir()
                with sqlite3.connect(target/'ledger.sqlite3') as backup:store.db.backup(backup)
            with database(restored,'demo') as store:
                self.assertEqual(get(store,'monthly_report',report['id']),report)
                self.assertEqual(evidence(store,fid),raw)
                self.assertEqual(compute_report(store,'2026-08')['id'],report['id'])
            with database(restored,'live') as store:self.assertEqual(store.fills(),[])

    def test_patch_group_fx_validation_and_versioning(self):
        self.fixture()
        with database(self.root,'demo') as store:ids=[f['id'] for f in store.fills()]
        base='/api/review/v1/demo/'
        self.assertEqual(self.client.post(base+'fill-patches',json={'idempotency_key':'patch','fill_id':ids[0],'expected_version':0,'fields':{'fee':'3'},'evidence':'corrected fee statement'}).status_code,200)
        self.assertEqual(self.client.post(base+'fill-patches',json={'idempotency_key':'stale-patch','fill_id':ids[0],'expected_version':0,'fields':{'fee':'4'},'evidence':'statement'}).status_code,409)
        group={'group_id':'g1','strategy':'long_stock','confirmed':True,'member_ids':ids}
        self.assertEqual(self.client.post(base+'groups',json={'idempotency_key':'group','expected_version':0,'group':group}).status_code,200)
        self.assertEqual(self.client.post(base+'groups',json={'idempotency_key':'overlap','expected_version':0,'group':{**group,'group_id':'g2'}}).status_code,409)
        self.assertEqual(self.client.post(base+'documents',json={'idempotency_key':'fx','kind':'fx','expected_version':0,'document':{'currency':'USD','date':'2026-08-31','source':'synthetic rate','rate':'7'}}).status_code,200)
        self.assertEqual(self.client.post(base+'documents',json={'idempotency_key':'bad-fx','kind':'fx','expected_version':0,'document':{'currency':'USD','date':'2026-08-31','source':'synthetic rate','rate':'NaN'}}).status_code,422)
        for resource,field in [('groups','group'),('documents','document'),('signals','signal'),('rules','rule')]:
            self.assertEqual(self.client.post(base+resource,json={field:[]}).status_code,422)
        with database(self.root,'demo') as store:
            self.assertEqual(compute_report(store,'2026-08')['result']['summary'][0]['net'],'96')
            self.assertEqual(evidence(store,ids[0])['raw']['fee'],'1')

if __name__=='__main__':unittest.main()
