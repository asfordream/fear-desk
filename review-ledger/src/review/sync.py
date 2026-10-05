from collections import defaultdict
from datetime import date,timedelta
from decimal import Decimal as D
from .accounting import allocate
from .common import ReviewError,digest,month_bounds,write_json,now
from .connector import query
from .ingest import import_rows

TIMEZONES={'US':'America/New_York','HK':'Asia/Hong_Kong','HKCC':'Asia/Shanghai','JP':'Asia/Tokyo'}

def transform(response,month):
    """Fees only attach when the complete order fill quantity is present in the response."""
    results=response['results'];raw=results.get('fills',{}).get('rows',[])
    orders={o['order_id']:o for o in results.get('orders',{}).get('rows',[])}
    fees={f['order_id']:f for f in results.get('fees',{}).get('rows',[])}
    by_order=defaultdict(list)
    for row in raw:by_order[row['order_id']].append(row)
    assigned={}
    for oid,rows in by_order.items():
        order=orders.get(oid);fee=fees.get(oid)
        quantities=[D(str(x['qty'])) for x in rows]
        if not order or not fee or sum(quantities)!=D(str(order['dealt_qty'])):continue
        if order.get('order_status') not in ('FILLED_ALL','CANCELLED_PART','CANCELLED_ALL','FAILED','DELETED'):continue
        parts=allocate(D(str(fee['fee_amount'])),quantities)
        assigned.update({r['deal_id']:str(part) for r,part in zip(rows,parts)})
    rows=[];out_of_scope=0
    for r in raw:
        if r['create_time'][:7]!=month or r['deal_market']!=response['query']['market']:
            out_of_scope+=1;continue
        o=orders.get(r['order_id'],{})
        row=dict(fill_id=r['deal_id'],order_id=r['order_id'],symbol=r['code'],side=r['trd_side'],
            trade_date=r['create_time'],qty=str(r['qty']),price=str(r['price']),fee=assigned.get(r['deal_id']),
            market=r['deal_market'],timezone=TIMEZONES.get(r['deal_market']),currency=o.get('currency'))
        # Contract symbols alone don't prove a multiplier or adjusted deliverable. Keep unknowns explicit.
        rows.append(row)
    return rows,out_of_scope

def sync_month(store,account,month,market='US',port=11111,firm='FUTUSECURITIES'):
    start,end=month_bounds(month)
    request_start=(date.fromisoformat(start)-timedelta(days=1)).isoformat()
    # Date-only parameters work with installed SDK; fetch padding and filter local market month.
    import time
    for attempt in range(1,4):
        try:
            response=query(store.root,'history',account=account,start=request_start,end=end,market=market,port=port,firm=firm)
        except ReviewError as exc:
            response={'query':{'account':account,'market':market,'start':request_start,'end':end},
                'results':{'fills':{'status':'FAILED','reason':exc.code},'orders':{'status':'UNVERIFIED'},'fees':{'status':'UNVERIFIED'}}}
        path=store.root/'raw'/(now().replace(':','-')+'-'+market+'.json');write_json(path,response)
        with store.db:
            store.add_document('sync_attempt',path.name,{'account':account,'month':month,'market':market,
                'attempt':attempt,'status':response['results']['fills']['status'],'coverage':'UNVERIFIED','source':str(path)})
        if response['results']['fills']['status']=='OK':break
        if attempt<3:time.sleep(attempt)

    if response['results']['fills']['status']!='OK':
        with store.db:
            store.add_document('sync_attempt',str(path.name),{'account':account,'month':month,'market':market,
                'status':'FAILED','source':str(path),'results':{k:v['status'] for k,v in response['results'].items()}})
        return {'status':'FAILED','source':str(path),'results':response['results']}
    rows,outside=transform(response,month)
    result=import_rows(store,rows,{'account':account,'provider':'futu'},digest(response),path.name)
    with store.db:
        store.add_document('sync_attempt',str(path.name),{'account':account,'month':month,'market':market,
            'status':'QUERIED','coverage':'UNVERIFIED','source':str(path),
            'rows':len(rows),'boundary_rows_excluded':outside,'results':{k:v['status'] for k,v in response['results'].items()}})
    return {**result,'source':str(path),'boundary_rows_excluded':outside,'coverage':'UNVERIFIED',
            'fees_attached':sum(r['fee'] is not None for r in rows)}
