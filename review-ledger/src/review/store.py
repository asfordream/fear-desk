from __future__ import annotations
import json
import sqlite3
import uuid
from pathlib import Path
from .common import dumps, now, private_dir

SCHEMA = '''
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version VALUES(1);
CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, source_hash TEXT NOT NULL,
 source_name TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS raw_records(id INTEGER PRIMARY KEY, batch_id TEXT REFERENCES batches(id),
 source_row INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fills(id TEXT PRIMARY KEY, account TEXT NOT NULL, symbol TEXT NOT NULL,
 trade_date TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES batches(id));
CREATE INDEX IF NOT EXISTS fills_account_symbol ON fills(account,symbol);
CREATE TABLE IF NOT EXISTS exceptions(id TEXT PRIMARY KEY, code TEXT NOT NULL,
 ref TEXT NOT NULL, detail TEXT NOT NULL, batch_id TEXT REFERENCES batches(id));
CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, kind TEXT NOT NULL,
 doc_key TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(kind,doc_key,version));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, action TEXT NOT NULL,
 payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS report_runs(id TEXT PRIMARY KEY, month TEXT NOT NULL,
 manifest TEXT NOT NULL, output_path TEXT NOT NULL, created_at TEXT NOT NULL);
'''

class Store:
    def __init__(self, data_dir):
        self.root=private_dir(data_dir); self.path=self.root/'ledger.sqlite3'
        self.db=sqlite3.connect(self.path);self.db.row_factory=sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON');self.db.executescript(SCHEMA);self.path.chmod(0o600)
        for table in ('raw_records','fills','documents','audit','report_runs'):
            for action in ('UPDATE','DELETE'):
                self.db.execute(f"CREATE TRIGGER IF NOT EXISTS immutable_{table}_{action} BEFORE {action} ON {table} BEGIN SELECT RAISE(ABORT, 'append-only table'); END")
    def close(self): self.db.close()
    def audit(self, action, payload):
        self.db.execute('INSERT INTO audit(action,payload,created_at) VALUES(?,?,?)',(action,dumps(payload),now()))
    def exception(self, code, ref, detail, batch_id=None):
        from .common import digest
        id=digest([code,ref,detail])
        self.db.execute('INSERT OR IGNORE INTO exceptions VALUES(?,?,?,?,?)',(id,code,ref,detail,batch_id))
    def documents(self,kind):
        return [json.loads(r['payload']) for r in self.db.execute('''SELECT d.payload FROM documents d
        WHERE kind=? AND version=(SELECT MAX(version) FROM documents e WHERE e.kind=d.kind AND e.doc_key=d.doc_key)
        ORDER BY d.doc_key''',(kind,))]
    def add_document(self,kind,key,payload,expected_version=None):
        version=self.db.execute('SELECT COALESCE(MAX(version),0) FROM documents WHERE kind=? AND doc_key=?',(kind,key)).fetchone()[0]
        from .common import ReviewError
        if expected_version is not None and version!=expected_version:
            raise ReviewError('VERSION_CONFLICT','记录已更新，请重新导出后编辑','重新导出 review-sheet',5)
        value={**payload,'version':version+1}
        self.db.execute('INSERT INTO documents(kind,doc_key,version,payload,created_at) VALUES(?,?,?,?,?)',
                        (kind,key,version+1,dumps(value),now()))
        self.audit('document_append',{'kind':kind,'key':key,'version':version+1})
        return value
    def fills(self, include_excluded=False):
        rows=[json.loads(r['payload']) for r in self.db.execute('SELECT payload FROM fills ORDER BY trade_date,id')]
        patches={p['fill_id']:p for p in self.documents('fill_patch')}
        from .ingest import normalize
        for i,f in enumerate(rows):
            if f['id'] in patches:
                patch=patches[f['id']]
                updated=normalize({**f,**patch['fields']},{'account':f['account'],'provider':f['provider'],'environment':f['environment']})
                rows[i]={**updated,'id':f['id'],'source_ref':f['source_ref'],'revision':patch['version'],'revision_evidence':patch['evidence']}
        excluded={r['ref'] for r in self.documents('resolution') if r['decision']=='exclude-fill'}
        return rows if include_excluded else [r for r in rows if r['id'] not in excluded]
    def exceptions(self):
        fills={f['id']:f for f in self.fills()}
        rows=[dict(r) for r in self.db.execute('SELECT * FROM exceptions ORDER BY code,ref')]
        permanent={'REVISION_CONFLICT','POSSIBLE_DUPLICATE','MISSING_FILL_ID'}
        resolved={r['exception_id'] for r in self.documents('resolution')}
        excluded={r['ref'] for r in self.documents('resolution') if r['decision']=='exclude-fill'}
        return [r for r in rows if r['id'] not in resolved and r['ref'] not in excluded and (r['code'] in permanent or r['ref'] not in fills or r['code'] in fills[r['ref']]['issues'])]
    def snapshot(self):
        active=self.fills();ids={f['id'] for f in active}
        return dict(fills=active,excluded_fills=[f for f in self.fills(True) if f['id'] not in ids],resolutions=self.documents('resolution'),exceptions=self.exceptions(),
            openings=self.documents('opening'),events=self.documents('event'),
            coverage=self.documents('coverage'),groups=self.documents('group'),statements=self.documents('statement'),
            batches=[dict(r) for r in self.db.execute('SELECT * FROM batches ORDER BY id')])
