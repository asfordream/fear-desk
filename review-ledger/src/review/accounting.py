"""Deterministic economic FIFO. No SDK or I/O and no inferred opening positions."""
from __future__ import annotations
from collections import defaultdict
from copy import deepcopy
from decimal import Decimal as D
from .common import digest

VERSION='fifo-0.2.0'
ZERO=D(0)

def allocate(total, quantities):
    """Decimal allocation with last-member residual; None means unknown, never zero."""
    if total is None:return [None for _ in quantities]
    den=sum(quantities,ZERO)
    if den<=0:raise ValueError('allocation quantities must be positive')
    out=[];remaining=total
    for q in quantities[:-1]:
        value=total*q/den;out.append(value);remaining-=value
    return out+[remaining]

def scope(f):return (f['account'],f['symbol'],f.get('currency'),f.get('market'),f.get('environment','REAL'))

def compute(snapshot,month):
    from .common import month_bounds
    from datetime import datetime,timezone
    start,end=month_bounds(month)
    fills=[f for f in snapshot['fills'] if (f.get('trade_date') or '')[:10]<end]
    events=[e for e in snapshot['events'] if e['trade_date'][:10]<end]
    openings={scope(o):o for o in snapshot['openings'] if o['as_of']<end}
    buckets=defaultdict(list)
    for f in fills:buckets[scope(f)].append(f)
    for e in events:buckets.setdefault(scope(e),[])
    for k in openings:buckets.setdefault(k,[])
    issues=[];invalid=set();dependencies=defaultdict(set);states={};results=[]
    blocked_refs={x['ref'] for x in snapshot['exceptions'] if x['code'] in ('REVISION_CONFLICT','POSSIBLE_DUPLICATE')}
    def problem(key,code,detail):
        issues.append(dict(code=code,ref='|'.join(str(x) for x in key),detail=detail));invalid.add(key)
    for event in events:
        if event.get('target_symbol'):
            k=scope(event);dependencies[k].add((k[0],event['target_symbol'],k[2],k[3],k[4]))
    for key,rows in buckets.items():
        opening=openings.get(key)
        if opening is None:problem(key,'MISSING_OPENING','缺少期初批次或期初空仓证据');continue
        if any(start<=r['trade_date'][:10]<opening['as_of'] for r in rows):
            problem(key,'OPENING_AFTER_ACTIVITY','期初晚于月内成交，无法覆盖整月');continue
        rows=[r for r in rows if r['trade_date'][:10]>=opening['as_of']]
        critical=[r for r in rows if any(x!='MISSING_FEE' for x in r['issues']) or r['id'] in blocked_refs]
        if critical:problem(key,'INSTRUMENT_BLOCKED','关键字段、方向、重复或修订冲突未解决；受影响记录数='+str(len(critical)));continue
        multipliers={r['multiplier'] for r in rows}
        if opening.get('multiplier'):multipliers.add(opening['multiplier'])
        if len({D(x) for x in multipliers})!=1:problem(key,'METADATA_CONFLICT','乘数缺失或变更，需有据公司行动');continue
        lots=[]
        for lot in opening.get('lots',[]):
            lots.append(dict(id=lot['lot_id'],direction=lot['direction'],qty=D(lot['qty']),price=D(lot['price']),
                fee=D(lot['fee']) if lot.get('fee') is not None else None,opened_at=lot['opened_at'],source='opening'))
        states[key]={'lots':lots,'multiplier':D(next(iter(multipliers)))}
    stream=[dict(r,event=False) for r in fills if scope(r) in openings and r['trade_date'][:10]>=openings[scope(r)]['as_of']]
    stream += [dict(e,event=True) for e in events if scope(e) in openings and e['trade_date'][:10]>=openings[scope(e)]['as_of']]
    def timestamp(row):
        value=row.get('executed_at') or row['trade_date']
        try:
            dt=datetime.fromisoformat(value)
            return dt.astimezone(timezone.utc).isoformat() if dt.tzinfo else value
        except (ValueError,TypeError):return ''
    ties=defaultdict(list)
    for r in stream:ties[(scope(r),timestamp(r))].append(r)
    for (key,_),rows in ties.items():
        if len(rows)>1 and (any(not r.get('sequence') for r in rows) or len({r['sequence'] for r in rows})!=len(rows)):
            problem(key,'AMBIGUOUS_ORDER','同时间无唯一券商序号')
    stream.sort(key=lambda r:(timestamp(r),int(r.get('sequence') or 0),r['id']))
    for row in stream:
        key=scope(row)
        if key in invalid or key not in states:continue
        state=states[key];lots=state['lots'];multiplier=state['multiplier']
        event=row['event'];transfer=event and row['event_type'] in ('ASSIGNMENT','EXERCISE')
        target=None
        if event:
            if transfer:
                # Only explicitly evidenced standard short-put assignment and long-call exercise are enabled.
                supported=(row['event_type']=='ASSIGNMENT' and row.get('cp')=='P' and row['direction']=='SHORT') or (row['event_type']=='EXERCISE' and row.get('cp')=='C' and row['direction']=='LONG')
                metadata=[f for f in buckets[key] if f.get('asset_type')=='OPTION']
                mismatch=any(f.get('cp')!=row.get('cp') or D(f['strike'])!=D(row.get('strike') or '0') for f in metadata)
                if mismatch:
                    problem(key,'EVENT_METADATA_CONFLICT','事件行权价/CP与已验证合约字段不一致');continue
                if not supported or not row.get('target_symbol') or row.get('deliverable')!='STANDARD_SHARES':
                    problem(key,'UNSUPPORTED_LIFECYCLE','仅支持有据标准卖put指派/买call行权接股；其他事件须人工核对');continue
                target=(key[0],row['target_symbol'],key[2],key[3],key[4]);dependencies[key].add(target)
                if target not in states or target in invalid or states[target]['multiplier']!=1:
                    problem(key,'MISSING_DELIVERY_OPENING','交付股票缺少有效期初/证券元数据');continue
                if row['trade_date'][:10]<openings[target]['as_of'] or any(l['qty']>0 and l['direction']!='LONG' for l in states[target]['lots']):
                    problem(key,'UNSUPPORTED_DELIVERY_NETTING','交付与股票期初/空头库存冲突');continue
                if not row.get('strike'):
                    problem(key,'MISSING_STRIKE','行权价缺失');continue
            elif row['event_type']!='EXPIRE_WORTHLESS':
                problem(key,'UNSUPPORTED_LIFECYCLE','尚未启用该生命周期路径');continue
            side='SELL' if row['direction']=='LONG' else 'BUY_TO_CLOSE';mode='CLOSE';price=ZERO
        else:side=row['side'];mode=row['open_close'];price=D(row['price'])
        qty=D(row['qty']);fee=D(row['fee']) if row.get('fee') is not None else None
        direction=('LONG' if side=='BUY' else 'SHORT') if mode=='OPEN' else ('LONG' if side=='SELL' else 'SHORT')
        if (mode=='OPEN' and side not in ('BUY','SELL_SHORT','SELL')) or (mode=='CLOSE' and side not in ('SELL','BUY_TO_CLOSE','BUY')):
            problem(key,'DIRECTION_CONFLICT','买卖和开平字段冲突');continue
        if mode=='OPEN':
            if any(l['qty']>0 and l['direction']!=direction for l in lots):problem(key,'HEDGED_INVENTORY_UNSUPPORTED','同合约双向库存需专门的头寸模式');continue
            lots.append(dict(id=row['id'],direction=direction,qty=qty,price=price,fee=fee,opened_at=row['trade_date'],source='fill'));continue
        available=sum((l['qty'] for l in lots if l['direction']==direction),ZERO)
        if available<qty:problem(key,'ORPHAN_CLOSE','平仓数量超过有据库存');continue
        if event and not transfer and row.get('expiry') and row['trade_date'][:10]<row['expiry']:
            problem(key,'INVALID_EXPIRY_EVENT','作废事件早于到期日');continue
        remaining=qty;remaining_fee=fee
        for lot in lots:
            if remaining==0:break
            if lot['qty']==0 or lot['direction']!=direction:continue
            matched=min(remaining,lot['qty'])
            open_fee=allocate(lot['fee'],[matched,lot['qty']-matched])[0] if matched<lot['qty'] else lot['fee']
            close_fee=allocate(remaining_fee,[matched,remaining-matched])[0] if matched<remaining else remaining_fee
            combined_fee=open_fee+close_fee if open_fee is not None and close_fee is not None else None
            gross=(price-lot['price'])*matched*multiplier*(1 if direction=='LONG' else -1)
            net=gross-combined_fee if combined_fee is not None else None
            transfer_details={}
            if transfer:
                stock_price=D(row['strike'])+lot['price']*(1 if direction=='LONG' else -1)
                states[target]['lots'].append(dict(id=row['id'],direction='LONG',qty=matched*multiplier,price=stock_price,
                    fee=combined_fee,opened_at=row['trade_date'],source='lifecycle',origin_id=lot['id']))
                transfer_details=dict(kind='COST_TRANSFER',target_symbol=target[1],transferred_qty=str(matched*multiplier),
                    transferred_price=str(stock_price),transferred_fee=str(combined_fee) if combined_fee is not None else None)
                gross=ZERO;net=ZERO if combined_fee is not None else None
            results.append(dict(id=digest([lot['id'],row['id'],str(matched),str(remaining)]),account=key[0],symbol=key[1],
                currency=key[2],market=key[3],environment=key[4],open_id=lot['id'],close_id=row['id'],qty=str(matched),
                opened_at=lot['opened_at'],closed_at=row['trade_date'],gross=str(gross),
                fee=('0' if transfer else str(combined_fee)) if net is not None else None,net=str(net) if net is not None else None,
                direction=direction,algorithm=VERSION,**({'kind':'REALIZED'}|transfer_details)))
            lot['qty']-=matched;remaining-=matched
            if lot['fee'] is not None:lot['fee']-=open_fee
            if remaining_fee is not None:remaining_fee-=close_fee
    # Errors invalidate all dependent delivery inventory as well, never leave a partially computed gain.
    changed=True
    while changed:
        changed=False
        for source,targets in dependencies.items():
            if source in invalid:
                for target in targets-invalid:
                    problem(target,'DEPENDENT_LIFECYCLE_BLOCKED','来源期权事件核算异常');changed=True
    results=[m for m in results if (m['account'],m['symbol'],m['currency'],m['market'],m['environment']) not in invalid]
    open_lots=[]
    for key,state in states.items():
        if key in invalid:continue
        for lot in state['lots']:
            if lot['qty']>0:open_lots.append({**{k:(str(v) if isinstance(v,D) else v) for k,v in lot.items()},
                'account':key[0],'symbol':key[1],'currency':key[2],'market':key[3]})
    monthly=[m for m in results if m['closed_at'][:7]==month and m['kind']=='REALIZED']
    return {'matches':results,'monthly_matches':monthly,'open_lots':open_lots,'issues':issues,'algorithm':VERSION}

def metrics(values):
    xs=[D(x) for x in values];n=len(xs);wins=[x for x in xs if x>0];losses=[x for x in xs if x<0]
    aw=sum(wins,ZERO)/len(wins) if wins else None;al=-sum(losses,ZERO)/len(losses) if losses else None
    return {'n':n,'wins':len(wins),'losses':len(losses),'flat':n-len(wins)-len(losses),
        'win_rate':str(D(len(wins))/n) if n else None,'ev':str(sum(xs,ZERO)/n) if n else None,
        'avg_win':str(aw) if aw is not None else None,'avg_loss':str(al) if al is not None else None,
        'payoff_ratio':str(aw/al) if aw is not None and al else None,
        'top3_win_concentration':str(sum(sorted(wins,reverse=True)[:3],ZERO)/sum(wins,ZERO)) if wins else None,
        'top3_loss_concentration':str(sum(sorted(losses)[:3],ZERO)/sum(losses,ZERO)) if losses else None,
        'sample_label':'样本不足' if n<10 else '低样本' if n<20 else '历史描述，未证实未来优势'}
