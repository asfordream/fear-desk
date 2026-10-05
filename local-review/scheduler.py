"""Single monthly authority: due -> lease -> immutable report -> completed.
Crash before completion leaves an expiring lease; report identity deduplicates retry.
"""
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import uuid
from domain import database, compute_report, save_report, invalidate_reports

def due_months(clock):
    local=clock.astimezone(ZoneInfo('Asia/Shanghai'))
    year,month=local.year,local.month
    if (local.day,local.hour,local.minute)<(3,9,0):month-=1
    month-=1
    while month<=0:year-=1;month+=12
    out=[];y,m=2026,1
    while (y,m)<=(year,month):
        out.append(f'{y:04d}-{m:02d}');m+=1
        if m==13:y,m=y+1,1
    return out

def tick(root,space,clock=None):
    clock=clock or datetime.now(timezone.utc);stamp=clock.isoformat();lease=(clock+timedelta(minutes=5)).isoformat()
    with database(root,space) as store:
        with store.db:
            for month in due_months(clock):store.db.execute('INSERT OR IGNORE INTO monthly_jobs(month,status) VALUES(?,"pending")',(month,))
        for month in due_months(clock):
            owner=uuid.uuid4().hex
            with store.db:
                store.db.execute('BEGIN IMMEDIATE')
                row=store.db.execute('SELECT * FROM monthly_jobs WHERE month=?',(month,)).fetchone()
                if row['status']=='completed' or (row['status']=='running' and row['lease_until']>stamp) or (row['status']=='failed' and row['attempts']>=3):continue
                generation=store.db.execute('SELECT generation FROM review_state WHERE id=1').fetchone()[0]
                store.db.execute('UPDATE monthly_jobs SET status="running",lease_until=?,lease_id=?,attempts=attempts+1,error=NULL WHERE month=?',(lease,owner,month))
            try:
                report=compute_report(store,month)
                # Ownership checked in same transaction as report persistence/completion.
                with store.db:
                    store.db.execute('BEGIN IMMEDIATE')
                    job=store.db.execute('SELECT lease_id FROM monthly_jobs WHERE month=?',(month,)).fetchone()
                    if job[0]!=owner:continue
                    old=store.db.execute('SELECT 1 FROM documents WHERE kind="monthly_report" AND doc_key=?',(report['id'],)).fetchone()
                    if not old:store.add_document('monthly_report',report['id'],report,expected_version=0)
                    changed=store.db.execute('SELECT generation FROM review_state WHERE id=1').fetchone()[0]!=generation
                    store.db.execute('UPDATE monthly_jobs SET status=?,report_id=?,lease_until=NULL,lease_id=NULL WHERE month=?',('pending' if changed else 'completed',report['id'],month))
            except Exception as e:
                with store.db:store.db.execute('UPDATE monthly_jobs SET status="failed",error=?,lease_until=NULL WHERE month=? AND lease_id=?',(type(e).__name__,month,owner))

def invalidate(store):
    invalidate_reports(store)
