"""Isolated SDK process. Only selected read calls; raw IDs never leave this process."""
from __future__ import annotations
import contextlib
import hashlib
import hmac
import io
import json
import logging
import re
import sys
from .common import dumps, now

ALLOWED = frozenset({"get_acc_list", "history_deal_list_query", "history_order_list_query", "order_fee_query", "position_list_query"})

def read_call(ctx, method, **kwargs):
    if method not in ALLOWED: raise ValueError("READ_ONLY")
    return getattr(ctx, method)(**kwargs)

def run(request):
    import futu
    from futu.common.ft_logger import logger
    logger.file_level = logging.CRITICAL + 1
    logger.console_level = logging.CRITICAL + 1
    key = bytes.fromhex(request["key"])
    def pseudonym(kind, value):
        return kind + "-" + hmac.new(key, str(value).encode(), hashlib.sha256).hexdigest()[:16]
    ctx = futu.OpenSecTradeContext(filter_trdmarket=request.get("market", "US"),
        host="127.0.0.1", port=request.get("port",11111), security_firm=request.get("firm","FUTUSECURITIES"))
    try:
        ctx.set_sync_query_connect_timeout(10)
        ret, data = read_call(ctx,"get_acc_list")
        if ret != futu.RET_OK: return {"error":"ACCOUNT_QUERY_FAILED", "message":"账户读取失败；请检查 OpenD 登录和券商配置"}
        accounts = data.to_dict("records")
        public = [{"account":pseudonym("acct",r["acc_id"]), "tail":str(r.get("card_num",""))[-4:],
            "environment":r["trd_env"], "type":r["acc_type"], "markets":r["trdmarket_auth"],
            "firm":r["security_firm"], "status":r["acc_status"]} for r in accounts]
        base = {"sdk_version":futu.__version__, "observed_at":now(), "accounts":public}
        if request["action"] == "accounts": return base
        matches = [r for r in accounts if pseudonym("acct",r["acc_id"]) == request["account"] and r["trd_env"] == "REAL"]
        if len(matches) != 1: return {"error":"ACCOUNT_NOT_FOUND","message":"指定实盘账户不可见；请重新运行 accounts"}
        account = matches[0]
        common = dict(acc_id=int(account["acc_id"]), trd_env=futu.TrdEnv.REAL)
        def clean(rows):
            out=[]
            for r in rows:
                cleaned={}
                for k,v in r.items():
                    if k in {"acc_id","card_num","uni_card_num","user_id","remark","last_err_msg"}: continue
                    if k in {"deal_id","order_id"}: v=pseudonym(k,str(v))
                    # Convert numpy scalar values without leaking objects.
                    if hasattr(v,"item"): v=v.item()
                    cleaned[k]=v
                out.append(cleaned)
            return out
        def safe_error(value):
            message=str(value)
            for record in accounts:
                for field in ("acc_id","card_num","uni_card_num"):
                    private=str(record.get(field,""))
                    if private and private != "N/A": message=message.replace(private,"[账户]")
            return re.sub(r"\d{7,}","[标识]",message)[:500]
        results={}
        for method, name in [("history_deal_list_query","fills"),("history_order_list_query","orders")]:
            market_arg={"deal_market" if name=="fills" else "order_market":request.get("market","US")}
            ret, frame = read_call(ctx,method,start=request["start"],end=request["end"],**market_arg,**common)
            results[name] = {"status":"OK" if ret == futu.RET_OK else "FAILED"}
            if ret == futu.RET_OK:
                results[name]["rows"] = clean(frame.to_dict("records"))
                if name == "orders": order_ids = [str(x) for x in frame["order_id"].tolist()]
            else:
                # SDK errors may embed private IDs, so don't return raw text.
                results[name]["reason"] = safe_error(frame)
        fees=[]
        if results["orders"]["status"] == "OK":
            import time
            for offset in range(0,len(order_ids),400):
                if offset: time.sleep(3.1)
                ret, frame = read_call(ctx,"order_fee_query",order_id_list=order_ids[offset:offset+400],**common)
                if ret != futu.RET_OK:
                    results["fees"]={"status":"PARTIAL","rows":fees,"reason":safe_error(frame)}; break
                fees.extend(clean(frame.to_dict("records")))
            else: results["fees"]={"status":"OK","rows":fees}
        else: results["fees"]={"status":"UNVERIFIED","rows":[]}
        return {**base,"query":{"account":request["account"],"start":request["start"],"end":request["end"],"market":request.get("market","US")},"results":results,
            "coverage":"UNVERIFIED", "lifecycle_events":"UNVERIFIED", "historical_month_end":"UNVERIFIED"}
    finally: ctx.close()

if __name__ == "__main__":
    try:
        request=json.loads(sys.stdin.read())
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result=run(request)
    except Exception as exc:
        result={"error":"SDK_ERROR","message":"SDK 查询失败", "exception_type":type(exc).__name__}
    print(dumps(result))
