"""Unconfirmed grouping suggestions from validated FIFO connectivity, never strategy facts."""
from collections import defaultdict
from .accounting import compute
from .common import digest

def propose(snapshot,month):
    accounting=compute(snapshot,month)
    occupied={i for g in snapshot['groups'] for i in g['member_ids']}
    adjacency=defaultdict(set)
    for m in accounting['matches']:
        a,b=m['open_id'],m['close_id']
        if a in occupied or b in occupied:continue
        adjacency[a].add(b);adjacency[b].add(a)
    known={f['id']:f for f in snapshot['fills']}
    for o in snapshot['openings']:
        for l in o.get('lots',[]):known[l['lot_id']]={**o,'trade_date':l['opened_at']}
    for e in snapshot['events']:known[e['id']]=e
    open_ids={l['id'] for l in accounting['open_lots']}
    visited=set();out=[]
    for seed in sorted(adjacency):
        if seed in visited:continue
        pending=[seed];component=set()
        while pending:
            key=pending.pop()
            if key in component:continue
            component.add(key);pending.extend(adjacency[key]-component)
        visited|=component
        if component&open_ids or any(x not in known for x in component):continue
        if max(known[x]['trade_date'] for x in component)[:7]!=month:continue
        members=sorted(component);out.append(dict(group_id='candidate-'+digest(members)[:16],version=0,
            member_ids=members,strategy='UNCLASSIFIED',confirmed='false',note='[推断] FIFO关联形成已闭合成员候选；策略和对冲/roll关系需本人确认'))
    return out
