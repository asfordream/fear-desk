import importlib.util
import json
import os
import secrets
import socket
import subprocess
import sys
from pathlib import Path
from .common import ReviewError, private_dir

def broker_python():
    # A service virtualenv may omit the already installed broker SDK.
    return os.environ.get("REVIEW_BROKER_PYTHON",sys.executable)

def doctor(port=11111):
    with socket.socket() as s:
        s.settimeout(2); reachable=s.connect_ex(("127.0.0.1",port)) == 0
    installed=importlib.util.find_spec("futu") is not None
    if broker_python()!=sys.executable:
        try:
            probe=subprocess.run([broker_python(),"-c","import importlib.util; print(int(importlib.util.find_spec('futu') is not None))"],capture_output=True,text=True,timeout=3)
            installed=probe.returncode==0 and probe.stdout.strip()=="1"
        except (OSError,subprocess.TimeoutExpired):installed=False
    return {"python":sys.version.split()[0],"sdk_installed":installed,
        "opend_reachable":reachable,"host":"127.0.0.1","port":port,"account_permission":"UNVERIFIED"}

def query(data_dir, action, **kwargs):
    d=private_dir(data_dir); key_path=d/"identity.key"
    if not key_path.exists():
        key_path.write_text(secrets.token_hex(32));key_path.chmod(0o600)
    request={"action":action,"key":key_path.read_text().strip(),**kwargs}
    try:
        p=subprocess.run([broker_python(),"-m","review.futu_worker"],input=json.dumps(request),
                         text=True,capture_output=True,timeout=55)
    except subprocess.TimeoutExpired:
        raise ReviewError("OPEND_TIMEOUT","OpenD 查询超过55秒","检查登录后重试；离线导入仍可使用",3)
    try: result=json.loads(p.stdout)
    except (json.JSONDecodeError,ValueError):
        raise ReviewError("SDK_PROCESS_FAILED","SDK 进程未返回有效数据","检查 futu SDK 安装",3)
    if "error" in result: raise ReviewError(result["error"],result["message"],"检查 OpenD 登录、市场权限与券商配置",3)
    return result
