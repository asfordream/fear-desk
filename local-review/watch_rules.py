"""Deterministic local watch rules. Read-only market input; no broker orders or LLM."""
from contextlib import contextmanager, closing
from pathlib import Path
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo
from decimal import Decimal
import json, sqlite3, uuid, re, hashlib
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
NY=ZoneInfo('America/New_York'); BJ=ZoneInfo('Asia/Shanghai')
class RulesError(ValueError): pass

def calendar():
    text=(ROOT/'lib/trading-calendar.ts').read_text()
    h=text.split('const holidays = new Set([',1)[1].split(']);',1)[0]
    e=text.split('const earlyClose = new Set([',1)[1].split(']);',1)[0]
    return set(re.findall(r"'([0-9-]{10})'",h)),set(re.findall(r"'([0-9-]{10})'",e))
HOLIDAYS,EARLY=calendar()
def session(d):
    d=date.fromisoformat(str(d))
    if not 2026<=d.year<=2028: raise RulesError('交易日历超出2026–2028覆盖范围，请先更新日历')
    return d.weekday()<5 and d.isoformat() not in HOLIDAYS

def advance(day,n):
    d=date.fromisoformat(day)
    for _ in range(n):
        d+=timedelta(days=1)
        while not session(d):d+=timedelta(days=1)
    return d.isoformat()

def effective(clock):
    n=clock.astimezone(NY);d=n.date();close=13 if d.isoformat() in EARLY else 16
    if session(d) and n.hour<close:return d.isoformat()
    return advance(d.isoformat(),1)

def closed(clock):
    n=clock.astimezone(NY);d=n.date()
    for _ in range(14):
        if session(d) and (d<n.date() or n.hour>=(13 if d.isoformat() in EARLY else 16)):return d.isoformat()
        d-=timedelta(days=1)
    raise RulesError('无法确定已收盘交易日')

def remaining(today,target):
    d=date.fromisoformat(today);t=date.fromisoformat(target);n=0
    while d<t:
        d+=timedelta(days=1)
        if session(d):n+=1
    return n

def market_snapshot():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    request=urllib.request.Request('http://127.0.0.1:5191/api/rules-market',headers={'Cookie':'__sites_local_auth=1'})
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=25) as response:
        raw=response.read(16000001)
    if len(raw)>16000000:raise RulesError('行情快照过大，未截断计算')
    data=json.loads(raw)['data']
    if not isinstance(data,dict) or not isinstance(data.get('instruments'),list) or not isinstance(data.get('bars'),list):raise RulesError('行情快照格式无效')
    c=sqlite3.connect(':memory:')
    try:
        c.execute('CREATE TABLE instruments(symbol TEXT,active INTEGER)');c.execute('CREATE TABLE bars(symbol TEXT,date TEXT,close REAL)')
        c.executemany('INSERT INTO instruments VALUES(?,1)',[(x['symbol'],) for x in data['instruments']])
        c.executemany('INSERT INTO bars VALUES(?,?,?)',[(x['symbol'],x['date'],x['close']) for x in data['bars']]);c.commit();return c
    except Exception:c.close();raise

class Store:
    def __init__(self,root,market=None):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.root/'observations.sqlite';self.market=market
        with self.db() as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,rank INTEGER NOT NULL,enabled INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS versions(rule_id TEXT,version INTEGER,effective_date TEXT,body TEXT,created_at TEXT,PRIMARY KEY(rule_id,version));
            CREATE TABLE IF NOT EXISTS trigger_evidence(item_id TEXT PRIMARY KEY,payload TEXT);
            CREATE TABLE IF NOT EXISTS evaluations(rule_id TEXT,version INTEGER,symbol TEXT,day TEXT,PRIMARY KEY(rule_id,version,symbol,day));
            CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,rule_id TEXT,version INTEGER,symbol TEXT,trigger_day TEXT,observe_day TEXT,change TEXT,status TEXT,created_at TEXT,updated_at TEXT,UNIQUE(rule_id,version,symbol,trigger_day));
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,at TEXT,action TEXT,entity TEXT,detail TEXT);
            CREATE TABLE IF NOT EXISTS reminders(day TEXT,target TEXT,status TEXT,attempts INTEGER DEFAULT 0,payload TEXT,error TEXT,updated_at TEXT,next_retry REAL DEFAULT 0,PRIMARY KEY(day,target));
            CREATE TABLE IF NOT EXISTS reminder_attempts(day TEXT,target TEXT,attempt INTEGER,payload TEXT,status TEXT,updated_at TEXT,PRIMARY KEY(day,target,attempt));
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
            ''')
        self.path.chmod(0o600)
    @contextmanager
    def db(self):
        c=sqlite3.connect(self.path,timeout=10);c.row_factory=sqlite3.Row
        c.execute('PRAGMA busy_timeout=10000')
        try:
            with c:yield c
        finally:c.close()
    def log(self,c,clock,action,entity,detail=''):
        c.execute('INSERT INTO audit(at,action,entity,detail) VALUES(?,?,?,?)',(clock.isoformat(),action,entity,detail))
    def change(self,b,clock=None):
        clock=clock or datetime.now(timezone.utc);action=b.get('action');stamp=clock.isoformat()
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            if action=='reorder':
                ids=b.get('ids');actual=[r[0] for r in c.execute('SELECT id FROM rules WHERE archived=0 ORDER BY rank,id')]
                if not isinstance(ids,list) or len(ids)!=len(set(ids)) or set(ids)!=set(actual):raise RulesError('排序清单已变化，请刷新')
                if b.get('previousIds')!=actual:raise RulesError('顺序已被修改，请刷新')
                for i,rid in enumerate(ids):c.execute('UPDATE rules SET rank=? WHERE id=?',(i,rid))
                self.log(c,clock,'reorder','rules',json.dumps(ids));return
            if action in ['handled','undo']:
                row=c.execute('SELECT * FROM items WHERE id=?',(b.get('id'),)).fetchone()
                if not row:raise RulesError('观察记录不存在')
                today=clock.astimezone(NY).date().isoformat()
                if action=='handled' and (row['status']!='active' or row['observe_day']>today):raise RulesError('仅到期的有效事项可标记已处理')
                if action=='undo' and row['status']!='handled':raise RulesError('仅已处理事项可撤销')
                rule=c.execute('SELECT * FROM rules WHERE id=?',(row['rule_id'],)).fetchone()
                newer=c.execute("SELECT 1 FROM items WHERE rule_id=? AND symbol=? AND trigger_day>?",(row['rule_id'],row['symbol'],row['trigger_day'])).fetchone()
                if action=='undo' and (not rule or not rule['enabled'] or rule['archived'] or newer):raise RulesError('规则已停用或存在后续触发，不恢复旧提醒')
                c.execute('UPDATE items SET status=?,updated_at=? WHERE id=?',('handled' if action=='handled' else 'active',stamp,row['id']))
                self.log(c,clock,action,row['id']);return
            rid=b.get('id');row=c.execute('SELECT * FROM rules WHERE id=?',(rid,)).fetchone() if rid else None
            if rid and (not row or row['archived']):raise RulesError('规则不存在或已归档')
            if row and b.get('revision')!=row['revision']:raise RulesError('规则已被修改，请刷新后编辑')
            if action in ['archive','toggle']:
                if not row:raise RulesError('请选择规则')
                if action=='toggle' and type(b.get('enabled')) is not bool:raise RulesError('启停状态必须为布尔值')
                enabled=b.get('enabled') if action=='toggle' else False
                c.execute('UPDATE rules SET enabled=?,archived=?,revision=revision+1 WHERE id=?',(int(enabled),int(action=='archive'),rid))
                if not enabled:c.execute("UPDATE items SET status='stopped',updated_at=? WHERE rule_id=? AND status='active'",(stamp,rid))
                else:
                    latest=c.execute('SELECT * FROM versions WHERE rule_id=? ORDER BY version DESC LIMIT 1',(rid,)).fetchone()
                    c.execute('INSERT INTO versions VALUES(?,?,?,?,?)',(rid,latest['version']+1,effective(clock),latest['body'],stamp))
                self.log(c,clock,action,rid);return
            if action!='save':raise RulesError('不支持的规则操作')
            title=str(b.get('title','')).strip();kind=b.get('kind');text=str(b.get('text','')).strip()
            if not 1<=len(title)<=80 or len(text)>2000 or kind not in ['drop','manual']:raise RulesError('请填写规则名称、正确类型和不超过2000字的说明')
            threshold=Decimal(str(b.get('threshold',5)));wait=b.get('waitDays',3)
            if not threshold.is_finite() or not Decimal('.1')<=threshold<=50 or type(wait) is not int or not 1<=wait<=20:raise RulesError('跌幅范围0.1–50%，等待1–20个交易日')
            if kind=='manual' and not text:raise RulesError('请填写人工检查内容')
            body={'title':title,'kind':kind,'text':text,'threshold':str(threshold),'waitDays':wait}
            if not row:
                rid=uuid.uuid4().hex;c.execute('INSERT INTO rules VALUES(?,1,?,1,0,?)',(rid,c.execute('SELECT COALESCE(MAX(rank),-1)+1 FROM rules').fetchone()[0],stamp));version=1
            else:
                version=c.execute('SELECT MAX(version)+1 FROM versions WHERE rule_id=?',(rid,)).fetchone()[0];c.execute('UPDATE rules SET revision=revision+1 WHERE id=?',(rid,))
            c.execute('INSERT INTO versions VALUES(?,?,?,?,?)',(rid,version,effective(clock),json.dumps(body,ensure_ascii=False),stamp))
            self.log(c,clock,'save',rid,str(version));return rid
    def rules(self,c):
        out=[]
        for row in c.execute('SELECT * FROM rules WHERE archived=0 ORDER BY rank,id'):
            versions=[dict(v) for v in c.execute('SELECT * FROM versions WHERE rule_id=? ORDER BY version',(row['id'],))]
            latest=versions[-1];out.append({**dict(row),**json.loads(latest['body']),'version':latest['version'],'effectiveDate':latest['effective_date'],'versions':[{**v,'body':json.loads(v['body'])} for v in versions]})
        return out
    def refresh(self,clock=None):
        clock=clock or datetime.now(timezone.utc);cutoff=closed(clock);stamp=clock.isoformat();issues=[]
        # Read through the running D1 authority rather than opening its live WAL from another runtime.
        market=sqlite3.connect(f'file:{self.market}?mode=ro',uri=True) if self.market else market_snapshot()
        with closing(market) as m,self.db() as c:
            m.row_factory=sqlite3.Row
            symbols=[r[0] for r in m.execute("SELECT symbol FROM instruments WHERE active=1 AND symbol!='SPY'")]
            c.execute('BEGIN IMMEDIATE')
            for row in c.execute("SELECT id,symbol FROM items WHERE status='active'").fetchall():
                if row['symbol'] not in symbols:c.execute("UPDATE items SET status='removed',updated_at=? WHERE id=?",(stamp,row['id']))
            for rule in self.rules(c):
                if not rule['enabled']:continue
                for symbol in symbols:
                    bars=list(m.execute('SELECT date,close FROM bars WHERE symbol=? AND date<=? ORDER BY date',(symbol,cutoff)))
                    if not bars or bars[-1]['date']!=cutoff:
                        issues.append(symbol+'：缺少 '+cutoff+' 收盘数据')
                    for i in range(1,len(bars)):
                        prev,bar=bars[i-1],bars[i];day=bar['date']
                        versions=[v for v in rule['versions'] if v['effective_date']<=day]
                        if not versions:continue
                        v=versions[-1];body=v['body']
                        if body['kind']!='drop':continue
                        key=(rule['id'],v['version'],symbol,day)
                        if c.execute('SELECT 1 FROM evaluations WHERE rule_id=? AND version=? AND symbol=? AND day=?',key).fetchone():continue
                        if advance(prev['date'],1)!=day or prev['close']<=0 or bar['close']<=0:
                            issues.append(symbol+'：相邻交易日数据待核对');continue
                        pct=(Decimal(str(bar['close']))/Decimal(str(prev['close']))-1)*100
                        c.execute('INSERT INTO evaluations VALUES(?,?,?,?)',key)
                        if pct <= -Decimal(body['threshold']):
                            c.execute("UPDATE items SET status='superseded',updated_at=? WHERE rule_id=? AND symbol=? AND status='active'",(stamp,rule['id'],symbol))
                            iid=uuid.uuid4().hex
                            c.execute('INSERT INTO items VALUES(?,?,?,?,?,?,?,\'active\',?,?)',(iid,rule['id'],v['version'],symbol,day,advance(day,body['waitDays']),str(pct),stamp,stamp))
                            c.execute('INSERT INTO trigger_evidence VALUES(?,?)',(iid,json.dumps({'previousDate':prev['date'],'previousAdjustedClose':prev['close'],'date':day,'adjustedClose':bar['close'],'source':'local-bars-adjusted','calendar':'nyse-2026-2028-v1'})))
            c.execute("INSERT OR REPLACE INTO meta VALUES('scan',?)",(json.dumps({'marketDate':cutoff,'updatedAt':stamp,'issues':sorted(set(issues))},ensure_ascii=False),))
    def view(self,clock=None):
        clock=clock or datetime.now(timezone.utc);today=clock.astimezone(NY).date().isoformat()
        with self.db() as c:
            rules=self.rules(c);rank={r['id']:r['rank'] for r in rules};items=[]
            for row in c.execute('SELECT * FROM items ORDER BY observe_day,created_at DESC'):
                item=dict(row);item['remaining']=remaining(today,item['observe_day']);item['label']=('今日到期' if item['observe_day']==today else '待处理') if item['status']=='active' and item['observe_day']<=today else ('倒数中' if item['status']=='active' else {'handled':'已处理','superseded':'已被最近触发替代','stopped':'规则已停用','removed':'已移出观察池'}.get(item['status'],item['status']))
                v=c.execute('SELECT body FROM versions WHERE rule_id=? AND version=?',(item['rule_id'],item['version'])).fetchone();item['ruleTitle']=json.loads(v[0])['title'];items.append(item)
            items.sort(key=lambda x:(x['status']!='active',x['observe_day']>today,rank.get(x['rule_id'],9999),x['observe_day']))
            scan=c.execute("SELECT value FROM meta WHERE key='scan'").fetchone();problem=c.execute("SELECT value FROM meta WHERE key='delivery_error'").fetchone();delivery=c.execute('SELECT day,status,error,updated_at,attempts FROM reminders ORDER BY day DESC LIMIT 1').fetchone()
            return {'rules':rules,'items':items,'scan':json.loads(scan[0]) if scan else None,'delivery':dict(delivery) if delivery else None,'deliveryError':problem[0] if problem else None,'calendar':'nyse-2026-2028-v1','today':today}

def card(view):
    elements=[]
    def md(s):elements.append({'tag':'markdown','content':s})
    md('**每日交易规则** · '+view['today']+'（美东日期）')
    enabled=[r for r in view['rules'] if r['enabled']]
    for i,r in enumerate(enabled):
        desc=('单日复权收盘跌幅达到 '+r['threshold']+'%，最近一次触发后第 '+str(r['waitDays'])+' 个交易日观察') if r['kind']=='drop' else r['text']
        md(str(i+1)+'. **'+r['title'].replace('*','')+'** · '+('自动筛选' if r['kind']=='drop' else '人工检查（不自动判定）')+'\n'+desc+'\n版本 '+str(r['version'])+' · 生效 '+r['effectiveDate'])
    if not enabled:md('暂无启用规则。')
    active=[i for i in view['items'] if i['status']=='active']
    md('**观察清单**')
    for i in active:md('**'+i['symbol']+'** · '+i['ruleTitle'].replace('*','')+'\n触发 '+i['trigger_day']+' · '+str(round(Decimal(i['change']),2))+'% · 观察 '+i['observe_day']+' · '+i['label']+(' · 剩余 '+str(i['remaining'])+' 个交易日' if i['remaining'] else ''))
    if not active:md('暂无倒数或待处理标的。')
    scan=view['scan'];md('行情截面 '+(scan['marketDate'] if scan else '未取得')+' · '+('缺数/待核对：'+'；'.join(scan['issues']) if scan and scan['issues'] else '数据按现有行情库核对')+'\n到期仅提醒观察；在本机网页手动标记已处理，不代表已经开仓。')
    return {'schema':'2.0','header':{'title':{'tag':'plain_text','content':'FearDesk · 恐慌观察池 · 交易规则提醒'},'template':'green'},'body':{'elements':elements}}

def notify(store,config,sender,clock=None):
    clock=clock or datetime.now(timezone.utc);day=clock.astimezone(BJ).date().isoformat()
    # Installation sets this to the next schedule date; never surprise-send on deployment.
    if not config.get('rulesEnabled') or day<config.get('rulesStartDate','9999'):return {'action':'rules_not_due'}
    local=clock.astimezone(BJ)
    if local.weekday()==6 or local.hour<14:return {'action':'rules_outside_window'}
    target=hashlib.sha256(config['webhook'].encode()).hexdigest()
    with store.db() as c:
        row=c.execute('SELECT * FROM reminders WHERE day=? AND target=?',(day,target)).fetchone()
        if row and row['status'] in ['sent','sending','unknown']:return {'action':'rules_already_'+row['status']}
    store.refresh(clock);view=store.view(clock)
    if not any(r['enabled'] for r in view['rules']):return {'action':'rules_none_enabled'}
    payload=card(view)
    if len(json.dumps({'msg_type':'interactive','card':payload},ensure_ascii=False).encode())>28000:raise RulesError('规则卡片超过发送大小限制，请减少规则文字；未截断发送')
    with store.db() as c:
        c.execute('BEGIN IMMEDIATE');row=c.execute('SELECT * FROM reminders WHERE day=? AND target=?',(day,target)).fetchone()
        if row and (row['status'] in ['sent','sending','unknown'] or row['attempts']>=3 or row['next_retry']>clock.timestamp()):return {'action':'rules_delivery_blocked'}
        if card(store.view(clock))!=payload:return {'action':'rules_snapshot_changed'}
        attempt=(row['attempts'] if row else 0)+1
        c.execute("INSERT INTO reminders(day,target,status,attempts,payload,updated_at) VALUES(?,?,'sending',1,?,?) ON CONFLICT(day,target) DO UPDATE SET status='sending',attempts=attempts+1,payload=excluded.payload,updated_at=excluded.updated_at",(day,target,json.dumps(payload,ensure_ascii=False),clock.isoformat()))
        c.execute('INSERT INTO reminder_attempts VALUES(?,?,?,?,?,?)',(day,target,attempt,json.dumps(payload,ensure_ascii=False),'sending',clock.isoformat()))
    try:result=sender(payload,config)
    except Exception:result={'status':'unknown','message':'发送结果不确定，禁止自动重发'}
    with store.db() as c:
        c.execute("DELETE FROM meta WHERE key='delivery_error'")
        c.execute('UPDATE reminder_attempts SET status=?,updated_at=? WHERE day=? AND target=? AND attempt=?',(result['status'],clock.isoformat(),day,target,attempt))
        c.execute('UPDATE reminders SET status=?,error=?,updated_at=?,next_retry=? WHERE day=? AND target=?',(result['status'],result['message'],clock.isoformat(),clock.timestamp()+300,day,target))
    return {'action':'rules_delivery_'+result['status']}
