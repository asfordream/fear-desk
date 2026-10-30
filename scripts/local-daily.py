from contextlib import closing
"""Local-only FearDesk scheduler. No model, cloud scheduler or public URL required."""
import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.sites-runtime/local-daily'
BASE = 'http://127.0.0.1:5191'
TZ = ZoneInfo('Asia/Shanghai')
BLOCKED = {'sent', 'sending', 'unknown'}


def now():
    return dt.datetime.now(TZ)


def due(stamp):
    stamp = stamp.astimezone(TZ)
    return stamp.weekday() < 6 and (stamp.hour, stamp.minute) >= (14, 0)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def load(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def database_file():
    candidates = []
    for path in (ROOT / '.wrangler/state/v3/d1/miniflare-D1DatabaseObject').glob('*.sqlite'):
        if not re.fullmatch(r'[a-f0-9]{64}\.sqlite', path.name):continue
        with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as connection, connection:
            if connection.execute("SELECT 1 FROM sqlite_master WHERE name='instruments'").fetchone():
                candidates.append(path)
    if len(candidates) != 1:
        raise RuntimeError('本地信号数据库未唯一确定')
    return candidates[0]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener():
    # Homebrew Python may point to a missing OpenSSL bundle; use the macOS bundle.
    context = ssl.create_default_context(cafile='/etc/ssl/cert.pem')
    return urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context))


def api(path, body=None):
    # This is the existing loopback-only development sign-in, never a cloud identity.
    request = urllib.request.Request(BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Cookie': '__sites_local_auth=1', 'Origin': BASE, 'Content-Type': 'application/json'})
    try:
        with opener().open(request, timeout=60) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError('本地日报接口返回 HTTP ' + str(error.code)) from None
    if 'error' in value:
        raise RuntimeError('本地日报接口未完成操作')
    return value['data']


def send_card(card, config):
    webhook = config.get('webhook', '')
    if not re.fullmatch(r'https://open\.feishu\.cn/open-apis/bot/v2/hook/[a-zA-Z0-9-]+', webhook):
        raise RuntimeError('飞书机器人配置无效')
    payload = {'msg_type': 'interactive', 'card': card}
    if config.get('signingSecret'):
        timestamp = str(int(time.time()))
        key = (timestamp + '\n' + config['signingSecret']).encode()
        payload.update(timestamp=timestamp, sign=base64.b64encode(hmac.new(key, b'', hashlib.sha256).digest()).decode())
    body = json.dumps(payload, ensure_ascii=False).encode()
    if len(body) > 28000:
        raise RuntimeError('完整卡片超过飞书发送大小限制')
    request = urllib.request.Request(webhook, data=body, headers={'Content-Type': 'application/json'})
    ok = True
    try:
        with opener().open(request, timeout=15) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        ok = False
        if 300 <= error.code < 400:
            return {'status': 'failed', 'message': '飞书重定向已阻止'}
        try:
            result = json.load(error)
        except Exception:
            return {'status': 'unknown', 'message': '没有明确回执，禁止自动重发'}
    except Exception:
        return {'status': 'unknown', 'message': '没有明确回执，禁止自动重发'}
    code = result.get('code', result.get('StatusCode'))
    if ok and type(code) is int and code == 0:
        return {'status': 'sent', 'message': '飞书已确认接收'}
    if type(code) is int:
        return {'status': 'failed', 'message': '飞书明确拒绝请求'}
    return {'status': 'unknown', 'message': '没有明确回执，禁止自动重发'}


def frozen_report(job):
    with closing(sqlite3.connect(database_file())) as connection, connection:
        row = connection.execute('SELECT payload,card,complete FROM reports WHERE id=?', (job['reportId'],)).fetchone()
    if not row or not row[2]:
        raise RuntimeError('没有完整冻结日报，未发送')
    report, card = json.loads(row[0]), json.loads(row[1])
    if not report['summary']['complete'] or report['tradeDate'] != job['requestedClosedDay']:
        raise RuntimeError('日报不完整或日期落后，未发送')
    card['header']['title']['content'] = 'FearDesk · 本地收盘日报 · ' + report['tradeDate']
    # No cloud report link: local IDs are not published to the retained cloud site.
    card['body']['elements'] = [element for element in card['body']['elements'] if element.get('tag') != 'button']
    card['body']['elements'].append({'tag': 'markdown', 'content': '本地定时生成；完整日报保存在本机，不提供公网详情链接。'})
    return report, card


def delivery_record(day, report_id, config, status=None, message=''):
    target = hashlib.sha256(config['webhook'].encode()).hexdigest()
    stamp = now().isoformat()
    with closing(sqlite3.connect(database_file())) as connection, connection:
        connection.execute('PRAGMA busy_timeout=5000')
        if status is None:
            connection.execute("INSERT INTO scheduled_deliveries(occurrence_date,target_key,report_id,status,updated_at) VALUES (?,?,?,'failed',?) ON CONFLICT(occurrence_date,target_key) DO NOTHING", (day, target, report_id, stamp))
            claim = connection.execute("UPDATE scheduled_deliveries SET status='sending',report_id=?,attempts=attempts+1,updated_at=?,message='本地定时发送中' WHERE occurrence_date=? AND target_key=? AND status='failed'", (report_id, stamp, day, target))
            if claim.rowcount:
                return 'claimed'
            return connection.execute('SELECT status FROM scheduled_deliveries WHERE occurrence_date=? AND target_key=?', (day, target)).fetchone()[0]
        connection.execute("UPDATE scheduled_deliveries SET status=?,updated_at=?,message=? WHERE occurrence_date=? AND target_key=? AND report_id=? AND status='sending'", (status, stamp, message, day, target, report_id))


def tick(state_path, config, api_call=api, deliver=send_card, report_reader=frozen_report,
         clock=now, sleep=time.sleep, monotonic=time.monotonic, budget=240, audit=None):
    stamp = clock()
    if not due(stamp):
        return {'action': 'outside_window'}
    day = stamp.astimezone(TZ).date().isoformat()
    state = load(state_path, {'occurrences': {}})
    record = state['occurrences'].setdefault(day, {'requestId': 'local-daily-' + day,
        'generation': 'pending', 'delivery': 'pending', 'sendAttempts': 0, 'generationAttempts': 0})
    if record['delivery'] in BLOCKED:
        return {'action': 'already_' + record['delivery'], 'day': day}
    if record['generation'] in {'failed', 'partial'}:
        return {'action': 'generation_failed', 'day': day}
    if record.get('nextRetryAt', 0) > stamp.timestamp():
        return {'action': 'retry_wait', 'day': day}
    # Same request ID survives network errors and process restarts.
    save(state_path, state)
    start = monotonic()
    try:
        if not record.get('jobId'):
            accepted = api_call('/api/reports', {'action': 'generate', 'requestId': record['requestId']})
            record['jobId'] = accepted['job']['id']
            save(state_path, state)
        while monotonic() - start < budget:
            if clock().astimezone(TZ).date().isoformat() != day:
                return {'action': 'day_changed_no_send', 'day': day}
            status = api_call('/api/reports')
            job = next((job for job in status['pipeline']['jobs'] if job['id'] == record['jobId']), None)
            if not job:
                raise RuntimeError('同一生成任务暂不可见')
            record.update(generation=job['status'], checkpoint=job.get('checkpoint'), stage=job.get('stage'), updatedAt=clock().isoformat())
            save(state_path, state)
            if job['status'] in {'failed', 'partial'}:
                return {'action': 'generation_failed', 'day': day}
            if job['status'] in {'ready', 'reused'}:
                report, card = report_reader(job)
                # Check again immediately before claiming delivery; never catch up a past day.
                if clock().astimezone(TZ).date().isoformat() != day:
                    return {'action': 'day_changed_no_send', 'day': day}
                if record['sendAttempts'] >= 3:
                    return {'action': 'delivery_retry_exhausted', 'day': day}
                record.update(reportId=job['reportId'], tradeDate=report['tradeDate'], delivery='sending',
                              sendAttempts=record['sendAttempts'] + 1)
                save(state_path, state)  # Crash after this point must never cause an automatic resend.
                if audit:
                    claimed = audit(day, job['reportId'], config)
                    if claimed != 'claimed':
                        record['delivery'] = claimed
                        save(state_path, state)
                        return {'action': 'already_' + claimed, 'day': day}
                try:
                    result = deliver(card, config)
                except Exception:
                    result = {'status': 'unknown', 'message': '发送结果不确定，禁止自动重发'}
                record.update(delivery=result['status'], message=result['message'], updatedAt=clock().isoformat())
                if result['status'] == 'failed':
                    record['nextRetryAt'] = clock().timestamp() + 300
                save(state_path, state)
                if audit:
                    audit(day, job['reportId'], config, result['status'], result['message'])
                return {'action': 'delivery_' + record['delivery'], 'day': day, 'tradeDate': report['tradeDate']}
            if job['status'] in {'queued', 'interrupted', 'retry_wait'}:
                if job.get('nextEligibleAt', 0) <= clock().timestamp() * 1000:
                    api_call('/api/reports', {'action': 'continue', 'requestId': record['requestId']})
            sleep(4)
        return {'action': 'checkpoint_saved', 'day': day}
    except Exception:
        record.update(generationAttempts=record['generationAttempts'] + 1, updatedAt=clock().isoformat(),
                      message='本轮未完成，保留原任务，下次检查恢复')
        if record['generationAttempts'] >= 6:
            record['generation'] = 'failed'
        save(state_path, state)
        return {'action': 'generation_retry_wait', 'day': day}


def command_tick():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'action': 'another_runner_active'}
        config = load(STATE / 'config.json', {})
        if not re.fullmatch(r'https://open\.feishu\.cn/open-apis/bot/v2/hook/[a-zA-Z0-9-]+', config.get('webhook', '')):
            return {'action': 'configuration_required'}
        try:
            result = tick(STATE / 'state.json', config, audit=delivery_record)
        except Exception:
            result = {'action': 'daily_failed'}
        # Independent delivery identity: an already-sent fear report does not suppress rules.
        sys.path.insert(0, str(ROOT / 'local-review'))
        try:
            from watch_rules import Store, notify
            result['rules'] = notify(Store(ROOT / '.review-state'), config, send_card)
        except Exception:
            try:
                with Store(ROOT / '.review-state').db() as db:
                    db.execute("INSERT OR REPLACE INTO meta VALUES('delivery_error',?)", ('规则计算或投递未完成，请核对行情与卡片大小；未确认送达',))
            except Exception:
                pass
            result['rules'] = {'action': 'rules_failed', 'message': '规则计算或投递未完成，保留记录后续核对'}
        return result


def serve():
    # Refuse unknown/missing schema instead of silently using an empty database.
    with closing(sqlite3.connect(database_file())) as connection, connection:
        if 'pipeline_version' not in {row[1] for row in connection.execute('PRAGMA table_info(job_runs)')}:
            raise RuntimeError('本地数据库需要升级，请先备份并迁移')
    env = dict(os.environ, NODE_TLS_REJECT_UNAUTHORIZED='1', NODE_USE_SYSTEM_CA='1',
               NODE_EXTRA_CA_CERTS='/etc/ssl/cert.pem',
               WRANGLER_SEND_METRICS='false')
    node = load(STATE / 'config.json', {})['node']
    os.chdir(ROOT)
    config = load(STATE / 'config.json', {})
    if not config.get('reviewPython'):
        raise RuntimeError('请配置复盘核算Python解释器')
    env.update(REVIEW_PYTHON=config['reviewPython'], REVIEW_STATE=str(ROOT / '.review-state'))
    os.execve(node, [node, str(ROOT / 'scripts/run-review-local.mjs'), '--no-open'], env)


def install():
    config = load(STATE / 'config.json', {})
    if not config.get('node') or not config.get('python'):
        raise RuntimeError('请先配置本地运行时路径')
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    logs = Path.home() / 'Library/Logs/FearDesk'
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    for suffix, extra in [('review', {'KeepAlive': True}), ('daily', {
        'StartInterval': 300, 'StartCalendarInterval': {'Hour': 14, 'Minute': 0}})]:
        label = 'cn.feardesk.local.' + suffix
        value = {'Label': label, 'ProgramArguments': [config['python'], str(Path(__file__).resolve()),
            'serve' if suffix == 'review' else 'tick'], 'WorkingDirectory': str(ROOT),
            'RunAtLoad': True, 'ThrottleInterval': 30,
            'StandardOutPath': str(logs / (suffix + '.log')),
            'StandardErrorPath': str(logs / (suffix + '-error.log')),
            'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}, **extra}
        path = agents / (label + '.plist')
        if path.exists():
            raise RuntimeError('同名任务已存在，先核对，未覆盖')
        path.write_bytes(plistlib.dumps(value))
        os.chmod(path, 0o600)
        subprocess.run(['plutil', '-lint', str(path)], check=True, capture_output=True)
    return {'action': 'agents_written_not_loaded'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['tick', 'serve', 'install', 'status'])
    action = parser.parse_args().action
    if action == 'serve':
        serve()
    else:
        result = command_tick() if action == 'tick' else install() if action == 'install' else {
            'state': load(STATE / 'state.json', {'occurrences': {}})}
        print(json.dumps(result, ensure_ascii=False), flush=True)
