import unittest,tempfile,sqlite3,json,sys
from pathlib import Path
from datetime import datetime,timezone
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
from watch_rules import Store,RulesError,advance,effective,closed,remaining,notify,card,NY,BJ

def clock(day,hour=18):return datetime.fromisoformat(day).replace(hour=hour,tzinfo=NY)
class RulesTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name);self.market=self.root/'market.sqlite'
  with sqlite3.connect(self.market) as c:
   c.executescript('CREATE TABLE instruments(symbol TEXT PRIMARY KEY,active INTEGER);CREATE TABLE bars(symbol TEXT,date TEXT,close REAL,PRIMARY KEY(symbol,date));INSERT INTO instruments VALUES("AAA",1);')
  self.s=Store(self.root/'private',self.market)
 def rule(self,**extra):return self.s.change({'action':'save','title':'等待观察','kind':'drop','threshold':'5','waitDays':3,**extra},clock('2026-09-30',10))
 def bars(self,rows):
  with sqlite3.connect(self.market) as c:c.executemany('INSERT OR REPLACE INTO bars VALUES("AAA",?,?)',rows)
 def test_exact_threshold_not_trigger(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',95)]);self.s.refresh(clock('2026-10-01'));self.assertEqual(self.s.view()['items'],[])
 def test_strict_threshold_triggers(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94.99)]);self.s.refresh(clock('2026-10-01'));i=self.s.view(clock('2026-10-02'))['items'][0];self.assertEqual(i['observe_day'],'2026-10-06');self.assertEqual(i['remaining'],2)
 def test_recent_trigger_resets_and_retains_old(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94),('2026-10-02',88)]);self.s.refresh(clock('2026-10-02'));items=self.s.view(clock('2026-10-02'))['items'];self.assertEqual(len(items),2);self.assertEqual([i['observe_day'] for i in items if i['status']=='active'],['2026-10-07']);self.assertIn('superseded',[i['status'] for i in items])
 def test_repeat_scan_does_not_duplicate(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);self.s.refresh(clock('2026-10-01'));self.s.refresh(clock('2026-10-01'));self.assertEqual(len(self.s.view()['items']),1)
 def test_no_history_before_enable(self):
  self.rule();self.bars([('2026-09-28',100),('2026-09-29',90)]);self.s.refresh(clock('2026-10-01'));self.assertEqual(self.s.view()['items'],[])
 def test_missing_adjacent_session_is_unknown(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-02',80)]);self.s.refresh(clock('2026-10-02'));v=self.s.view();self.assertEqual(v['items'],[]);self.assertTrue(v['scan']['issues'])
 def test_missing_today_is_disclosed(self):
  self.rule();self.bars([('2026-09-30',100)]);self.s.refresh(clock('2026-10-02'));self.assertIn('缺少',self.s.view()['scan']['issues'][0])
 def test_disable_and_archive_stop_existing(self):
  for action in ['toggle','archive']:
   with self.subTest(action=action):
    rid=self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);self.s.refresh(clock('2026-10-01'));self.s.change({'action':action,'id':rid,'revision':1,'enabled':False});self.assertFalse(any(i['rule_id']==rid and i['status']=='active' for i in self.s.view()['items']))
 def test_removed_stock_stops_reminder(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);self.s.refresh(clock('2026-10-01'))
  with sqlite3.connect(self.market) as c:c.execute('UPDATE instruments SET active=0')
  self.s.refresh(clock('2026-10-02'));self.assertEqual(self.s.view()['items'][0]['status'],'removed')
 def test_handle_only_due_and_undo(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);self.s.refresh(clock('2026-10-01'));i=self.s.view()['items'][0]
  with self.assertRaises(RulesError):self.s.change({'action':'handled','id':i['id']},clock('2026-10-02'))
  self.s.change({'action':'handled','id':i['id']},clock('2026-10-06'));self.assertEqual(self.s.view()['items'][0]['status'],'handled');self.s.change({'action':'undo','id':i['id']},clock('2026-10-06'));self.assertEqual(self.s.view()['items'][0]['status'],'active')
 def test_revision_conflict_preserves_versions(self):
  rid=self.rule();self.rule(id=rid,revision=1,title='新条件');v=self.s.view()['rules'][0];self.assertEqual(len(v['versions']),2)
  with self.assertRaises(RulesError):self.rule(id=rid,revision=1,title='过期保存')
 def test_versions_do_not_rewrite_trigger(self):
  rid=self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);self.s.refresh(clock('2026-10-01'));self.s.change({'action':'save','id':rid,'revision':1,'title':'改为10%','kind':'drop','threshold':'10','waitDays':3},clock('2026-10-01'));self.assertEqual(self.s.view()['items'][0]['version'],1)
 def test_sort_persists_and_rejects_outdated_order(self):
  a=self.rule();b=self.rule(title='第二条');self.s.change({'action':'reorder','ids':[b,a],'previousIds':[a,b]});self.assertEqual(Store(self.root/'private',self.market).view()['rules'][0]['id'],b)
  with self.assertRaises(RulesError):self.s.change({'action':'reorder','ids':[a,b],'previousIds':[a,b]})
 def test_manual_rule_never_auto_triggers(self):
  self.rule(kind='manual',text='自行检查风险');self.bars([('2026-09-30',100),('2026-10-01',80)]);self.s.refresh(clock('2026-10-01'));self.assertEqual(self.s.view()['items'],[])
 def test_calendar_holidays_and_early_close(self):
  self.assertEqual(advance('2026-11-25',3),'2026-12-01');self.assertEqual(advance('2026-10-02',3),'2026-10-07');self.assertEqual(closed(clock('2026-11-27',14)),'2026-11-27')
 def test_calendar_out_of_range_fails_closed(self):
  with self.assertRaises(RulesError):advance('2028-12-29',3)
 def test_effective_after_close_is_next_session(self):
  self.assertEqual(effective(clock('2026-10-02')),'2026-10-05');self.assertEqual(effective(clock('2026-10-02',10)),'2026-10-02')
 def test_empty_card_keeps_rules(self):
  self.rule();s=json.dumps(card(self.s.view(clock('2026-10-02'))),ensure_ascii=False);self.assertIn('暂无倒数',s);self.assertIn('等待观察',s)
 def test_delivery_has_own_dedupe_and_unknown_fence(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);config={'rulesEnabled':True,'rulesStartDate':'2026-10-02','webhook':'fake'};now=clock('2026-10-02',3);sent=[]
  def send(*args):sent.append(1);return {'status':'unknown','message':'不确定'}
  self.assertEqual(notify(self.s,config,send,now)['action'],'rules_delivery_unknown');self.assertEqual(notify(self.s,config,send,now)['action'],'rules_already_unknown');self.assertEqual(len(sent),1)
 def test_no_surprise_delivery_before_start(self):
  result=notify(self.s,{'rulesEnabled':True,'rulesStartDate':'2026-10-03'},lambda *_:self.fail('sent'),clock('2026-10-02',3));self.assertEqual(result['action'],'rules_not_due')
 def test_success_receipt_records_exactly_once(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);config={'rulesEnabled':True,'rulesStartDate':'2026-10-02','webhook':'fake'};now=clock('2026-10-02',3)
  self.assertEqual(notify(self.s,config,lambda *_:{'status':'sent','message':'ok'},now)['action'],'rules_delivery_sent');self.assertEqual(notify(self.s,config,lambda *_:self.fail('duplicate'),now)['action'],'rules_already_sent')
 def test_invalid_parameter_cannot_create_rule(self):
  for threshold in ['nan','100','-5']:
   with self.assertRaises(RulesError):self.rule(threshold=threshold)

 def test_disabled_rules_never_send_empty_rule_message(self):
  rid=self.rule();self.s.change({'action':'toggle','id':rid,'revision':1,'enabled':False});config={'rulesEnabled':True,'rulesStartDate':'2026-10-02','webhook':'fake'}
  self.assertEqual(notify(self.s,config,lambda *_:self.fail('sent'),clock('2026-10-02',3))['action'],'rules_none_enabled')
 def test_retry_does_not_resend_disabled_rule_snapshot(self):
  rid=self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);config={'rulesEnabled':True,'rulesStartDate':'2026-10-02','webhook':'fake'};now=clock('2026-10-02',3)
  notify(self.s,config,lambda *_:{'status':'failed','message':'rejected'},now)
  self.s.change({'action':'toggle','id':rid,'revision':1,'enabled':False},now)
  self.assertEqual(notify(self.s,config,lambda *_:self.fail('sent'),now)['action'],'rules_none_enabled')
 def test_crash_at_sender_is_unknown_not_retryable(self):
  self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);config={'rulesEnabled':True,'rulesStartDate':'2026-10-02','webhook':'fake'};now=clock('2026-10-02',3)
  def bad(*_):raise ConnectionError()
  self.assertEqual(notify(self.s,config,bad,now)['action'],'rules_delivery_unknown')
  with self.s.db() as c:self.assertEqual(c.execute('select status from reminder_attempts').fetchone()[0],'unknown')
 def test_reenable_starts_new_version_without_old_items(self):
  rid=self.rule();self.bars([('2026-09-30',100),('2026-10-01',94)]);self.s.refresh(clock('2026-10-01'));self.s.change({'action':'toggle','id':rid,'revision':1,'enabled':False},clock('2026-10-02'));self.s.change({'action':'toggle','id':rid,'revision':2,'enabled':True},clock('2026-10-02'));self.assertEqual(self.s.view()['rules'][0]['version'],2);self.assertEqual(self.s.view()['items'][0]['status'],'stopped')

 def test_private_api_requires_auth_and_persists_rule(self):
  from fastapi.testclient import TestClient
  from service import create_app
  token='a'*40
  app=create_app(self.root/'api',token,scheduled=False)
  with TestClient(app,base_url='http://127.0.0.1:18761') as client:
   path='/api/review/v1/live/watch-rules'
   self.assertEqual(client.get(path).status_code,403)
   headers={'authorization':'Bearer '+token}
   r=client.post(path,headers=headers,json={'action':'save','title':'接口规则','kind':'manual','text':'手动检查'})
   self.assertEqual(r.status_code,200)
   self.assertEqual(r.json()['data']['rules'][0]['title'],'接口规则')
   self.assertEqual(client.post(path,headers=headers,json={'action':'save','title':'invalid','unexpected':True}).status_code,422)

 def test_market_snapshot_reads_only_fixed_loopback_source(self):
  import io,watch_rules
  data={'data':{'instruments':[{'symbol':'AAA'}],'bars':[{'symbol':'AAA','date':'2026-10-01','close':94}]}}
  with patch.object(watch_rules.urllib.request,'build_opener') as opener:
   opener.return_value.open.return_value=io.BytesIO(json.dumps(data).encode())
   connection=watch_rules.market_snapshot()
   self.assertEqual(connection.execute('select close from bars').fetchone()[0],94)
   connection.close()
   req=opener.return_value.open.call_args.args[0]
   self.assertEqual(req.full_url,'http://127.0.0.1:5191/api/rules-market')

if __name__=='__main__':unittest.main()
