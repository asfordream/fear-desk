from contextlib import closing
import datetime as dt
import importlib.util
import io
import json
import sqlite3
import ssl
import urllib.error
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('daily', Path(__file__).parents[1] / 'scripts/local-daily.py')
daily = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daily)


class LocalDailyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.json'
        self.clock = lambda: dt.datetime(2026, 10, 23, 14, 0, tzinfo=daily.TZ)
        self.requests = []
        self.sends = 0
        self.job = {'id': 'job1', 'status': 'ready', 'reportId': 'report1',
                    'requestedClosedDay': '2026-10-22', 'tradeDate': '2026-10-22'}

    def api(self, path, body=None):
        self.requests.append(body)
        return {'job': self.job} if body else {'pipeline': {'jobs': [self.job]}}

    def deliver(self, card, config):
        self.sends += 1
        return {'status': 'sent', 'message': 'confirmed'}

    def run_tick(self, **kwargs):
        args = dict(api_call=self.api, deliver=self.deliver,
                    report_reader=lambda job: ({'tradeDate': job['tradeDate']}, {}),
                    clock=self.clock, sleep=lambda _: None)
        args.update(kwargs)
        return daily.tick(self.path, {}, **args)

    def test_beijing_window_and_sunday(self):
        for stamp, expected in [('2026-10-23T13:59:00+08:00', False),
                                ('2026-10-23T14:00:00+08:00', True),
                                ('2026-10-24T14:00:00+08:00', True),
                                ('2026-10-25T14:00:00+08:00', False),
                                ('2026-10-26T06:00:00+00:00', True)]:
            self.assertEqual(daily.due(dt.datetime.fromisoformat(stamp)), expected)

    def test_ready_sends_once_and_second_tick_is_read_only(self):
        self.assertEqual(self.run_tick()['action'], 'delivery_sent')
        calls = len(self.requests)
        self.assertEqual(self.run_tick()['action'], 'already_sent')
        self.assertEqual(len(self.requests), calls)
        self.assertEqual(self.sends, 1)

    def test_manual_sent_today_seed_does_not_send_again(self):
        daily.save(self.path, {'occurrences': {'2026-10-23': {'delivery': 'sent'}}})
        self.assertEqual(self.run_tick()['action'], 'already_sent')
        self.assertEqual(self.requests, [])

    def test_sending_and_unknown_never_resend(self):
        for status in ['sending', 'unknown']:
            daily.save(self.path, {'occurrences': {'2026-10-23': {'delivery': status}}})
            self.assertEqual(self.run_tick()['action'], 'already_' + status)
        self.assertEqual(self.sends, 0)

    def test_uncertain_response_is_not_retried(self):
        def disconnected(*_):
            raise TimeoutError()
        self.assertEqual(self.run_tick(deliver=disconnected)['action'], 'delivery_unknown')
        self.assertEqual(self.run_tick()['action'], 'already_unknown')

    def test_failed_generation_cannot_send(self):
        self.job['status'] = 'partial'
        self.assertEqual(self.run_tick()['action'], 'generation_failed')
        self.assertEqual(self.sends, 0)

    def test_same_request_identity_after_admission_response_lost(self):
        def lost(path, body=None):
            self.requests.append(body)
            raise TimeoutError()
        self.run_tick(api_call=lost)
        self.run_tick()
        ids = [body['requestId'] for body in self.requests if body]
        self.assertEqual(ids, ['local-daily-2026-10-23'] * 2)
        self.assertEqual(self.sends, 1)

    def test_pending_job_preserves_checkpoint_and_resumes_next_tick(self):
        self.job.update(status='queued', checkpoint=75, nextEligibleAt=0)
        times = iter([0, 0, 1000])
        self.assertEqual(self.run_tick(monotonic=lambda: next(times), budget=10)['action'], 'checkpoint_saved')
        self.assertEqual(self.requests[-1]['action'], 'continue')
        self.job['status'] = 'ready'
        self.assertEqual(self.run_tick()['action'], 'delivery_sent')
        self.assertEqual(sum(body is not None and body['action'] == 'generate' for body in self.requests), 1)

    def test_retry_wait_does_not_start_early(self):
        self.job.update(status='retry_wait', nextEligibleAt=self.clock().timestamp() * 1000 + 60000)
        times = iter([0, 0, 1000])
        self.run_tick(monotonic=lambda: next(times), budget=10)
        self.assertFalse(any(body and body['action'] == 'continue' for body in self.requests))

    def test_cross_midnight_never_sends_previous_day(self):
        tomorrow = dt.datetime(2026, 10, 24, 0, 0, tzinfo=daily.TZ)
        clock = iter([self.clock(), self.clock(), self.clock(), tomorrow])
        self.assertEqual(self.run_tick(clock=lambda: next(clock, tomorrow))['action'], 'day_changed_no_send')
        self.assertEqual(self.sends, 0)

    def test_past_occurrences_are_not_caught_up(self):
        daily.save(self.path, {'occurrences': {'2026-10-22': {'delivery': 'pending'}}})
        self.run_tick()
        self.assertEqual(self.requests[0]['requestId'], 'local-daily-2026-10-23')
        self.assertEqual(daily.load(self.path, {})['occurrences']['2026-10-22']['delivery'], 'pending')

    def test_unavailable_api_has_bounded_attempts(self):
        def down(*_):
            raise ConnectionError()
        for _ in range(7):
            result = self.run_tick(api_call=down)
        self.assertEqual(result['action'], 'generation_failed')
        self.assertEqual(self.sends, 0)

    def test_rejected_delivery_has_backoff_and_attempt_limit(self):
        failed = lambda *_: {'status': 'failed', 'message': 'rejected'}
        for attempt in range(3):
            self.assertEqual(self.run_tick(deliver=failed)['action'], 'delivery_failed')
            self.assertEqual(self.run_tick(deliver=failed)['action'], 'retry_wait')
            state = daily.load(self.path, {})
            state['occurrences']['2026-10-23']['nextRetryAt'] = 0
            daily.save(self.path, state)
        self.assertEqual(self.run_tick(deliver=failed)['action'], 'delivery_retry_exhausted')

    def test_state_file_is_private_and_atomically_saved(self):
        self.run_tick()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.path.with_suffix('.tmp').exists())

    def test_https_redirects_are_disabled(self):
        self.assertIsNone(daily.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.test'))

    def test_sqlite_delivery_fence_blocks_unknown_and_allows_new_day(self):
        path = Path(self.tmp.name) / 'db.sqlite'
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute('CREATE TABLE scheduled_deliveries(occurrence_date TEXT,target_key TEXT,report_id TEXT,status TEXT,attempts INTEGER DEFAULT 0,updated_at TEXT,message TEXT,PRIMARY KEY(occurrence_date,target_key))')
        config = {'webhook': 'https://open.feishu.cn/open-apis/bot/v2/hook/example'}
        with patch.object(daily, 'database_file', return_value=path):
            self.assertEqual(daily.delivery_record('2026-10-23', 'report', config), 'claimed')
            self.assertEqual(daily.delivery_record('2026-10-23', 'report', config), 'sending')
            daily.delivery_record('2026-10-23', 'report', config, 'unknown', 'uncertain')
            self.assertEqual(daily.delivery_record('2026-10-23', 'report', config), 'unknown')
            self.assertEqual(daily.delivery_record('2026-10-24', 'report', config), 'claimed')
        with closing(sqlite3.connect(path)) as connection, connection:
            self.assertEqual(connection.execute('SELECT SUM(attempts) FROM scheduled_deliveries').fetchone()[0], 2)

    def test_existing_sqlite_sent_record_prevents_network_send(self):
        self.assertEqual(self.run_tick(audit=lambda *_: 'sent')['action'], 'already_sent')
        self.assertEqual(self.sends, 0)

    def test_incomplete_or_stale_report_cannot_send(self):
        def invalid(_):
            raise RuntimeError('invalid frozen report')
        self.run_tick(report_reader=invalid)
        self.assertEqual(self.sends, 0)

    def test_delivery_claim_is_saved_before_network_call(self):
        def inspect(card, config):
            self.assertEqual(daily.load(self.path, {})['occurrences']['2026-10-23']['delivery'], 'sending')
            return {'status': 'sent', 'message': 'confirmed'}
        self.assertEqual(self.run_tick(deliver=inspect)['action'], 'delivery_sent')

    def test_feishu_requires_numeric_success_receipt(self):
        config = {'webhook': 'https://open.feishu.cn/open-apis/bot/v2/hook/example'}
        for response, expected in [(b'{"code":0}', 'sent'), (b'{"code":false}', 'unknown'),
                                   (b'{"code":123}', 'failed'), (b'{}', 'unknown')]:
            with patch.object(daily, 'opener') as opener:
                opener.return_value.open.return_value = io.BytesIO(response)
                self.assertEqual(daily.send_card({}, config)['status'], expected)

    def test_feishu_http_error_cannot_be_success(self):
        with patch.object(daily, 'opener') as opener:
            opener.return_value.open.side_effect = urllib.error.HTTPError('https://open.feishu.cn', 400, '', {}, io.BytesIO(b'{"code":0}'))
            self.assertEqual(daily.send_card({}, {'webhook': 'https://open.feishu.cn/open-apis/bot/v2/hook/example'})['status'], 'failed')

    def test_https_certificate_verification_is_required(self):
        handler = next(h for h in daily.opener().handlers if isinstance(h, daily.urllib.request.HTTPSHandler))
        self.assertEqual(handler._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(handler._context.check_hostname)

    def test_command_runs_rules_even_when_fear_already_sent(self):
        import types
        fake = types.ModuleType('watch_rules')
        fake.Store = lambda *args: object()
        seen = []
        fake.notify = lambda *args: seen.append(True) or {'action': 'rules_delivery_sent'}
        daily.save(Path(self.tmp.name) / 'config.json', {'webhook': 'https://open.feishu.cn/open-apis/bot/v2/hook/example'})
        with patch.object(daily, 'STATE', Path(self.tmp.name)), patch.object(daily, 'tick', return_value={'action':'already_sent'}), patch.object(daily, 'database_file', return_value='fake'), patch.dict('sys.modules', {'watch_rules':fake}):
            result=daily.command_tick()
        self.assertTrue(seen)
        self.assertEqual(result['rules']['action'],'rules_delivery_sent')

    def test_rules_failure_does_not_erase_fear_result(self):
        import types
        fake=types.ModuleType('watch_rules')
        fake.Store=lambda *args: object()
        def fail(*args): raise RuntimeError('rules failed')
        fake.notify=fail
        daily.save(Path(self.tmp.name) / 'config.json', {'webhook': 'https://open.feishu.cn/open-apis/bot/v2/hook/example'})
        with patch.object(daily, 'STATE', Path(self.tmp.name)), patch.object(daily,'tick',return_value={'action':'delivery_sent'}), patch.object(daily,'database_file',return_value='fake'), patch.dict('sys.modules',{'watch_rules':fake}):
            result=daily.command_tick()
        self.assertEqual(result['action'],'delivery_sent')
        self.assertEqual(result['rules']['action'],'rules_failed')


if __name__ == '__main__':
    unittest.main()
