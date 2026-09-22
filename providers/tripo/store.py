"""任务档案：data/tripo_tasks.json，记录本机发起的每个 Tripo 任务。

用途：断点续跑、批量查询、成本统计的本地数据源（查询时顺带更新状态）。
遵循项目约定：每个 JSON 存储一把锁、读写幂等。
"""
import json
import os
import threading
import time

from .config import DATA_DIR

STORE_FILE = os.path.join(DATA_DIR, "tripo_tasks.json")
_LOCK = threading.Lock()
_MAX_RECORDS = 500


def _load():
    try:
        if os.path.exists(STORE_FILE):
            with open(STORE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save(records):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(STORE_FILE, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=1)
    except Exception as e:
        print(f"保存 Tripo 任务档案失败: {e}")


def record(task_id: str, kind: str, params=None):
    """新建任务记录（已存在则跳过——同一 task_id 不重复记账）。"""
    if not task_id:
        return
    with _LOCK:
        records = _load()
        if task_id in records:
            return
        records[task_id] = {
            "kind": kind,
            "status": "queued",
            "progress": 0,
            "params": params or {},
            "created_at": int(time.time() * 1000),
            "updated_at": int(time.time() * 1000),
        }
        # 只保留最近的 N 条，避免无限膨胀
        if len(records) > _MAX_RECORDS:
            keep = sorted(records.items(), key=lambda kv: kv[1].get("created_at", 0))[-_MAX_RECORDS:]
            records = dict(keep)
        _save(records)


def update(task_id: str, status=None, progress=None, credits=None):
    """查询任务后回写状态/实际扣费（轻量，失败静默——档案缺失不影响业务）。"""
    if not task_id:
        return
    with _LOCK:
        records = _load()
        rec = records.get(task_id)
        if not rec:
            return
        changed = False
        if status and rec.get("status") != status:
            rec["status"] = status
            changed = True
        if progress is not None and rec.get("progress") != progress:
            rec["progress"] = progress
            changed = True
        if credits is not None and rec.get("credits") != credits:
            rec["credits"] = credits
            changed = True
        if changed:
            rec["updated_at"] = int(time.time() * 1000)
            _save(records)


def list_recent(limit=200):
    """按创建时间倒序返回任务档案（本地视角，供任务中心/统计用）。"""
    with _LOCK:
        records = _load()
    items = sorted(records.items(), key=lambda kv: kv[1].get("created_at", 0), reverse=True)
    return [{"task_id": tid, **meta} for tid, meta in items[:limit]]
