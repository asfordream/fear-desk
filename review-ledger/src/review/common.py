from __future__ import annotations
import csv
import hashlib
import json
import os
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

class ReviewError(Exception):
    def __init__(self, code, message, remedy="", exit_code=2):
        super().__init__(message)
        self.code, self.message, self.remedy, self.exit_code = code, message, remedy, exit_code
    def as_dict(self):
        return dict(code=self.code, message=self.message, remedy=self.remedy)

def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)

def digest(value):
    return hashlib.sha256((value if isinstance(value, bytes) else dumps(value).encode())).hexdigest()

def now():
    return datetime.now(timezone.utc).isoformat()

def decimal(value, *, optional=False, positive=False, nonnegative=False):
    if value is None or str(value).strip() == "":
        if optional: return None
        raise ReviewError("MISSING_NUMBER", "缺少必需数值")
    try: result = Decimal(str(value))
    except InvalidOperation: raise ReviewError("INVALID_NUMBER", "数值格式无效")
    if not result.is_finite() or (positive and result <= 0) or (nonnegative and result < 0):
        raise ReviewError("INVALID_NUMBER", "数值超出允许范围")
    return result

def month_bounds(month):
    try:
        start = date.fromisoformat(month + "-01")
    except ValueError: raise ReviewError("INVALID_MONTH", "月份格式应为 YYYY-MM")
    end = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    return start.isoformat(), end.isoformat()

def private_dir(path):
    p = Path(path); p.mkdir(parents=True, exist_ok=True); p.chmod(0o700); return p

def write_json(path, value):
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    temp = p.with_suffix(p.suffix + ".tmp")
    temp.write_text(dumps(value) + "\n"); temp.chmod(0o600); os.replace(temp, p)

def csv_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ReviewError("CSV_HEADER", "CSV 缺少表头或存在重复表头")
        rows = list(reader)
        if any(None in row for row in rows): raise ReviewError("CSV_WIDTH", "CSV 行字段数量超出表头")
        return rows

def export_csv(path, rows, fields=None):
    fields = fields or sorted({k for row in rows for k in row}) or ["status"]
    def safe(v):
        if v is None: return ""
        s = dumps(v) if isinstance(v, (dict, list)) else str(v)
        # Preserve negative numeric amounts, escape possible spreadsheet formulas.
        if s.lstrip().startswith(("=", "+", "-", "@")) or s.startswith(("\t", "\r")):
            try: numeric = Decimal(s).is_finite()
            except InvalidOperation: numeric = False
            if not numeric: s = "'" + s
        return s
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader(); writer.writerows({k:safe(v) for k,v in r.items()} for r in rows)
    Path(path).chmod(0o600)
