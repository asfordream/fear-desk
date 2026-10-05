from __future__ import annotations
import json
from collections import Counter,defaultdict
from datetime import date,timedelta
from decimal import Decimal as D
from pathlib import Path
from .accounting import compute,metrics,VERSION
from .common import ReviewError,csv_rows,decimal,digest,dumps,export_csv,month_bounds,now,private_dir,write_json

REPORT_VERSION='report-0.5.0'


def reconcile_statements(snapshot,month,summary,open_lots):
    accounts={f['account'] for f in snapshot['fills'] if f['trade_date'][:7]==month}
    statements={s['account']:s for s in snapshot.get('statements',[]) if s['month']==month}
    checks=[]
    for account in sorted(accounts):
        statement=statements.get(account)
        if not statement:
            checks.append(dict(account=account,check='statement',status='UNVERIFIED',detail='缺少正式月结单对账证据'));continue
        actual={x['currency']:x for x in summary if x['account']==account}
        for field in ('net','fee'):
            currencies=set(actual)|set(statement[field])
            for currency in sorted(currencies):
                observed=actual.get(currency,{}).get(field)
                expected=statement[field].get(currency)
                passed=observed is not None and expected is not None and D(observed)==D(expected)
                checks.append(dict(account=account,check=field,currency=currency,status='PASS' if passed else 'FAIL',
                    expected=expected,actual=observed,evidence=statement['evidence']))
        positions=defaultdict(lambda:D(0))
        for lot in open_lots:
            if lot['account']==account:positions[(lot['symbol'],lot['currency'])]+=D(lot['qty'])*(1 if lot['direction']=='LONG' else -1)
        expected=defaultdict(lambda:D(0))
        for pos in statement['positions']:expected[(pos['symbol'],pos['currency'])]+=D(pos['qty'])
        for key in sorted(set(positions)|set(expected)):
            checks.append(dict(account=account,check='position_qty',symbol=key[0],currency=key[1],
                status='PASS' if positions[key]==expected[key] else 'FAIL',expected=str(expected[key]),actual=str(positions[key]),evidence=statement['evidence']))
    return checks

def analyze(snapshot,month,fx=None):
    start,end=month_bounds(month);accounting=compute(snapshot,month)
    fills=[f for f in snapshot['fills'] if f['trade_date'][:7]==month]
    source_fees=defaultdict(lambda:dict(amount=D(0),known=0,missing=0))
    for f in fills:
        k=f.get('currency') or 'UNKNOWN'
        if f.get('fee') is None:source_fees[k]['missing']+=1
        else:source_fees[k]['amount']+=D(f['fee']);source_fees[k]['known']+=1
    source_fees={k:{**v,'amount':str(v['amount'])} for k,v in sorted(source_fees.items())}
    totals=defaultdict(lambda:dict(gross=D(0),net=D(0),fee=D(0),matches=0,missing_net=0))
    for m in accounting['monthly_matches']:
        t=totals[(m['account'],m['currency'])];t['gross']+=D(m['gross']);t['matches']+=1
        if m['net'] is None:t['missing_net']+=1
        else:t['net']+=D(m['net']);t['fee']+=D(m['fee'])
    summary=[]
    for (account,ccy),t in sorted(totals.items()):
        summary.append(dict(account=account,currency=ccy,gross=str(t['gross']),
            net=None if t['missing_net'] else str(t['net']),fee=None if t['missing_net'] else str(t['fee']),
            matched_fragments=t['matches'],missing_net_fragments=t['missing_net']))
    groups=[];stat_buckets=defaultdict(list)
    open_ids={x['id'] for x in accounting['open_lots']}
    for group in snapshot['groups']:
        members=set(group['member_ids']);related=[m for m in accounting['matches'] if m['open_id'] in members or m['close_id'] in members]
        internal=[m for m in related if {m['open_id'],m['close_id']}<=members]
        used={i for m in internal for i in (m['open_id'],m['close_id'])}
        complete=bool(internal) and used==members and not (members&open_ids) and len(internal)==len(related)
        net=sum((D(m['net']) for m in internal if m['net'] is not None),D(0))
        net_known=bool(internal) and all(m['net'] is not None for m in internal)
        closed_at=max((m['closed_at'] for m in internal),default='')
        eligible=complete and net_known and closed_at[:7]==month
        currency=internal[0]['currency'] if internal else None
        account=internal[0]['account'] if internal else None
        item=dict(group_id=group['group_id'],strategy=group['strategy'],complete=complete,eligible=eligible,
            closed_at=closed_at,currency=currency,account=account,net=str(net) if net_known and complete else None,
            current_month_net=str(sum((D(m['net']) for m in internal if m['net'] is not None and m['closed_at'][:7]==month),D(0))) if net_known else None,
            before_month_net=str(sum((D(m['net']) for m in internal if m['net'] is not None and m['closed_at'][:7]<month),D(0))) if net_known else None,
            member_ids=group['member_ids'])
        groups.append(item)
        if eligible:stat_buckets[(account,currency,group['strategy'])].append(net)
    stats=[dict(account=k[0],currency=k[1],strategy=k[2],**metrics(v)) for k,v in sorted(stat_buckets.items())]
    coverage=[]
    declarations={(c['account'],c['market']):c for c in snapshot['coverage'] if c['month']==month}
    scopes={(f['account'],f.get('market')) for f in fills}
    for key in sorted(scopes,key=str):
        c=declarations.get(key);coverage.append(dict(account=key[0],market=key[1],
            status='CONFIRMED' if c else 'UNVERIFIED',evidence=c.get('evidence') if c else None))
    unassigned=[f for f in snapshot['fills'] if 'INVALID_TIME' in f['issues'] and f['trade_date'][:7]!=month]
    issue_counts=Counter(i for f in fills+unassigned for i in f['issues'])
    issue_counts.update(x['code'] for x in accounting['issues'])
    for e in snapshot['exceptions']:
        if e['code'] in ('REVISION_CONFLICT','POSSIBLE_DUPLICATE'):issue_counts[e['code']]+=1
    status='FINAL'
    if issue_counts or not coverage or any(c['status']!='CONFIRMED' for c in coverage):
        status='PARTIAL' if accounting['monthly_matches'] else 'DRAFT'
    reconciliation=reconcile_statements(snapshot,month,summary,accounting['open_lots'])
    if not reconciliation or any(x['status']!='PASS' for x in reconciliation):
        status='PARTIAL' if accounting['monthly_matches'] else 'DRAFT'
    cny=D(0);fx_used=[];fx_missing=[]
    last_day=date.fromisoformat(end)-timedelta(days=1)
    for t in summary:
        if t['net'] is None:fx_missing.append(dict(currency=t['currency'],reason='NET_UNKNOWN'));continue
        if t['currency']=='CNY':rate=D(1);record=dict(currency='CNY',rate='1',date=last_day.isoformat(),source='identity')
        else:
            candidates=[r for r in (fx or []) if r['currency']==t['currency'] and date.fromisoformat(r['date'])<=last_day]
            record=max(candidates,key=lambda r:r['date']) if candidates else None
            if record is None or (last_day-date.fromisoformat(record['date'])).days>7:
                fx_missing.append(dict(currency=t['currency'],reason='MISSING_OR_STALE_FX'));continue
            rate=D(record['rate'])
        cny+=D(t['net'])*rate;fx_used.append(record)
    fx_status='COMPLETE' if summary and not fx_missing and status=='FINAL' else 'PARTIAL' if summary else 'UNAVAILABLE'
    return dict(month=month,status=status,fills=len(fills),excluded_fills=snapshot.get('excluded_fills',[]),source_fees=source_fees,markets=dict(sorted(Counter(f.get('market') or 'UNKNOWN' for f in fills).items())),issue_counts=dict(sorted(issue_counts.items())),
        summary=summary,accounting=accounting,groups=groups,stats=stats,coverage=coverage,reconciliation=reconciliation,unassigned_fills=unassigned,
        cny={'value':str(cny) if summary else None,'status':fx_status,'rates':fx_used,'excluded':fx_missing})

def load_fx(path):
    if not path:return []
    rows=csv_rows(path);seen=set()
    for r in rows:
        if not r.get('source') or not r.get('currency'):raise ReviewError('FX_SOURCE','汇率缺少币种或来源')
        date.fromisoformat(r['date']);decimal(r['rate'],positive=True)
        key=(r['currency'],r['date'])
        if key in seen:raise ReviewError('FX_CONFLICT','同币种同日期汇率重复')
        seen.add(key)
    return rows

def money(value,currency='USD'):
    if value is None:return 'N/A'
    precision={'USD':2,'HKD':2,'CNY':2,'JPY':0}.get(currency)
    if precision is None:return str(value)
    from decimal import ROUND_HALF_UP
    return format(D(value).quantize(D(1).scaleb(-precision),rounding=ROUND_HALF_UP),'f')

def render(result):
    r=result
    lines=[f"# 交割单复盘 · {r['month']}",'',f"状态：**{r['status']}**。本报告由确定性程序计算，尚未填入的个人判断保持空白。",'',
        f"[我的数据] 月内成交记录 {r['fills']} 条；已计算 FIFO 匹配片段 {len(r['accounting']['monthly_matches'])} 条。片段数不是策略交易笔数。",'',
        '## 数据质量','', 'BUY/SELL 保留买卖行为；没有开平证据时 open_close=UNKNOWN，不默认开多或平多。', '',
        '| 待处理项 | 数量 |','|---|---:|']
    labels={'MISSING_MULTIPLIER':'合约乘数待核实','MISSING_ASSET_TYPE':'资产类型待核实','UNKNOWN_OPEN_CLOSE':'开平仓方向缺失','MISSING_OPENING':'期初持仓/成本或空仓证据缺失','MISSING_FEE':'成交费用缺失','MISSING_CURRENCY':'币种缺失','MISSING_TIMEZONE':'时区缺失','INSTRUMENT_BLOCKED':'合约核算被阻断'}
    lines.extend(f"| {labels.get(k,k)} | {v} |" for k,v in r['issue_counts'].items())
    if not r['issue_counts']:lines.append('| 字段/核算异常 | 0 |')
    lines+=['', '市场记录数：'+dumps(r['markets']), '', '已关联成交费用（包含未平仓交易费用，不等同本月已实现费用；显示按币种精度舍入，底账保留原值）：','']
    for c,f in r['source_fees'].items():lines.append(f"- [我的数据] {c}：{money(f['amount'],c)}；已知费用 {f['known']} 条，缺失 {f['missing']} 条。")
    lines+=['','## 已实现损益（按平仓月、原币）','','[我的数据] 仅列可计算的范围；NULL/N/A 表示未知，不能当作零。','','| 账户 | 币种 | 毛损益 | 净损益 |','|---|---|---:|---:|']
    for t in r['summary']:lines.append(f"| {t['account']} | {t['currency']} | {money(t['gross'],t['currency'])} | {money(t['net'],t['currency'])} |")
    if not r['summary']:lines.append('| 无可核验核算结果 | — | N/A | N/A |')
    lines+=['',f"CNY 月末汇率折算：{money(r['cny']['value'],'CNY')}；状态 {r['cny']['status']}。不是账户净值收益。",'',
        '## 已闭合且人工确认的策略组','','| 策略 | 币种 | 样本数 | 胜率 | EV/组 | 样本说明 |','|---|---|---:|---:|---:|---|']
    for s in r['stats']:lines.append(f"| {s['strategy']} | {s['currency']} | {s['n']} | {s['win_rate']} | {s['ev']} | {s['sample_label']} |")
    if not r['stats']:lines.append('| 尚无符合统计条件的策略组 | — | 0 | N/A | N/A | 不据此归因 |')
    lines+=['','账务按本月平仓计入；策略按本月最终闭合的完整生命周期统计。strategy_groups.csv 保留当月与以前月份损益桥接。','',
        '## 下一步','',
        '1. 核对 coverage.csv：以正式单据补充期初、完整覆盖和生命周期证据。',
        '2. 处理 exceptions.csv，补充有据开平、费用和证券元数据。',
        '3. 导出复盘表，人工确认完整组合；当时理由需附证据，回忆单独记录。',
        '4. 同一报告输入可用 reproduce 复算；不要修改已归档报告。','',
        '历史 EV 仅描述已记录样本，不证明未来优势。缺历史净值、现金流和原计划时，不计算账户收益率或推断心理。','',
        '---','本报告由 EdgeLab Skills 框架生成 · by 杰尼马（EdgeLab）',
        '公众号 杰尼马 · X @jienima8635 · github.com/edgelab101/elab-skills','仅供研究参考，不构成任何投资建议。','']
    return '\n'.join(lines)

def write_report(store,month,out,fx_path=None):
    snapshot=store.snapshot();fx=load_fx(fx_path);r=analyze(snapshot,month,fx)
    frozen=dict(snapshot=snapshot,month=month,fx=fx,algorithm=VERSION,report_version=REPORT_VERSION)
    rid=digest(frozen)[:24];target=Path(out)/month/rid
    if target.exists():
        # Verify immutable existing output; never silently overwrite a changed report.
        manifest=json.loads((target/'manifest.json').read_text())
        for name,sha in manifest['files'].items():
            if digest((target/name).read_bytes())!=sha:raise ReviewError('ARTIFACT_CHANGED','既有报告文件已被改动',exit_code=5)
        return {'report_id':rid,'path':str(target/'report.md'),'status':r['status'],'reused':True}
    private_dir(target)
    write_json(target/'input.json',frozen);write_json(target/'result.json',r)
    (target/'report.md').write_text(render(r));(target/'report.md').chmod(0o600)
    export_csv(target/'fills.csv',[f for f in snapshot['fills'] if f['trade_date'][:7]==month])
    export_csv(target/'excluded_fills.csv',r['excluded_fills'])
    export_csv(target/'unassigned_fills.csv',r['unassigned_fills'])
    export_csv(target/'fifo_matches.csv',r['accounting']['monthly_matches'])
    export_csv(target/'open_lots.csv',r['accounting']['open_lots'])
    export_csv(target/'strategy_groups.csv',r['groups'])
    export_csv(target/'exceptions.csv',snapshot['exceptions']+r['accounting']['issues'])
    export_csv(target/'coverage.csv',r['coverage'])
    export_csv(target/'reconciliation.csv',r['reconciliation'])
    hashes={p.name:digest(p.read_bytes()) for p in sorted(target.iterdir())}
    manifest=dict(report_id=rid,month=month,algorithm=VERSION,report_version=REPORT_VERSION,
        input_hash=digest(frozen),files=hashes,status=r['status'])
    write_json(target/'manifest.json',manifest)
    with store.db:
        store.db.execute('INSERT OR IGNORE INTO report_runs VALUES(?,?,?,?,?)',(rid,month,dumps(manifest),str(target.resolve()),now()))
        store.audit('report',{'report_id':rid})
    return {'report_id':rid,'path':str((target/'report.md').resolve()),'status':r['status']}

def reproduce(store,rid):
    row=store.db.execute('SELECT * FROM report_runs WHERE id=?',(rid,)).fetchone()
    if not row:raise ReviewError('REPORT_NOT_FOUND','报告ID不存在')
    target=Path(row['output_path']);manifest=json.loads(row['manifest'])
    if json.loads((target/'manifest.json').read_text())!=manifest:
        raise ReviewError('MANIFEST_CHANGED','报告清单与数据库记录不一致',exit_code=5)
    for name,sha in manifest['files'].items():
        if digest((target/name).read_bytes())!=sha:raise ReviewError('ARTIFACT_CHANGED','报告文件校验失败',exit_code=5)
    frozen=json.loads((target/'input.json').read_text())
    if frozen['algorithm']!=VERSION or frozen['report_version']!=REPORT_VERSION:
        raise ReviewError('VERSION_MISMATCH','请使用该报告固定的程序版本复算',exit_code=5)
    result=analyze(frozen['snapshot'],frozen['month'],frozen['fx'])
    if dumps(result)!=dumps(json.loads((target/'result.json').read_text())) or render(result)!=(target/'report.md').read_text():
        raise ReviewError('REPRODUCE_MISMATCH','相同输入复算不一致',exit_code=6)
    return {'report_id':rid,'verified':True}
