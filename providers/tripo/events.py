"""事件出口：把 Tripo 任务进度广播到 /ws/stats。

providers 包不 import main（避免循环依赖），由 main.py 在启动时注入 broadcaster。
未注入时静默降级为不广播（不影响任务本身，前端仍有轮询兜底）。
"""
import asyncio

import httpx

from . import store
from .config import tripo_api_key, tripo_base_url

_broadcaster = None
_watch_timeout_s = 30 * 60      # 单任务最长观察 30 分钟
_watch_interval_s = 5


def set_broadcaster(fn):
    """main.py 启动时调用，注入 async fn(payload_dict)。"""
    global _broadcaster
    _broadcaster = fn


async def _broadcast(task_id, status, progress):
    if not _broadcaster:
        return
    try:
        await _broadcaster({"task_id": task_id, "status": status, "progress": progress})
    except Exception:
        pass


async def watch_task(task_id: str):
    """后台观察一个任务：轮询上游并把进度广播给所有 WS 客户端，终态即停。

    提交端点 fire-and-forget 调用（asyncio.create_task）；异常全部吞掉——
    广播失败不影响业务，前端 pollTask 始终是完成判定的兜底路径。
    """
    if not task_id or not tripo_api_key():
        return
    url = f"{tripo_base_url()}/tasks/{task_id}"
    headers = {"Authorization": f"Bearer {tripo_api_key()}"}
    deadline = asyncio.get_event_loop().time() + _watch_timeout_s
    try:
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(_watch_interval_s)
            status, progress = "", 0
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    resp = await client.get(url, headers=headers)
                if resp.status_code != 200:
                    continue
                data = resp.json()
                if data.get("code") not in (0, None):
                    continue
                task = data.get("data") or {}
                status = str(task.get("status") or "")
                progress = task.get("progress") or 0
            except Exception:
                continue
            store.update(task_id, status=status, progress=progress, credits=task.get("credits_consumed"))
            await _broadcast(task_id, status, progress)
            if status in ("success", "failed", "cancelled", "banned", "expired", "unknown"):
                return
    except Exception:
        pass
