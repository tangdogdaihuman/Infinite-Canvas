"""Tripo 路由层（薄）：只做 HTTP 语义，全部委托 service / outputs。

挂在 main.py 的 app.include_router(router, prefix="/api/tripo") 下，
路径与旧实现逐一对应，签名保持不变（画布前端零改动）。
"""
import httpx
from fastapi import APIRouter, HTTPException

from . import service, store
from .config import tripo_base_url, tripo_error_detail, tripo_headers
from .outputs import download_remote

router = APIRouter()


@router.get("/balance")
async def tripo_balance():
    return await service.balance()


@router.post("/upload")
async def tripo_upload(payload: dict):
    return await service.upload_image(payload)


@router.post("/task")
async def tripo_create_task(payload: dict):
    return await service.create_task(payload)


@router.get("/task/{task_id}")
async def tripo_query_task(task_id: str):
    return await service.query_task(task_id)


@router.post("/download")
async def tripo_download(payload: dict):
    return await download_remote(
        payload.get("url"),
        kind=payload.get("kind"),
        name_hint=payload.get("name"),
    )


@router.get("/capabilities")
async def tripo_capabilities():
    """能力元数据：前端能力卡由它驱动渲染。"""
    return {"success": True, "capabilities": service.list_capabilities()}


@router.post("/capabilities/{cap_id}")
async def tripo_submit_capability(cap_id: str, payload: dict):
    """统一提交入口：注册表校验 → 组装 → 提交。"""
    return await service.submit_capability(cap_id, payload)


@router.get("/tasks")
async def tripo_tasks_archive(limit: int = 200):
    """本机任务档案（data/tripo_tasks.json）：创建时间倒序。"""
    return {"success": True, "tasks": store.list_recent(min(max(limit, 1), 500))}


@router.post("/tasks/query")
async def tripo_tasks_query(payload: dict):
    """批量查询上游任务状态：POST /tasks/list 的代理。"""
    ids = payload.get("task_ids") or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(status_code=400, detail="缺少 task_ids 列表")
    ids = [str(t).strip() for t in ids if str(t).strip()][:50]
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{tripo_base_url()}/tasks/list", headers=tripo_headers(), json={"task_ids": ids})
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Tripo 批量查询失败：{tripo_error_detail(resp)}")
    data = resp.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=400, detail=f"Tripo 批量查询失败：{data.get('message') or data}")
    tasks = data.get("data") or []
    for t in tasks if isinstance(tasks, list) else []:
        store.update(t.get("task_id"), status=t.get("status"), progress=t.get("progress"), credits=t.get("credits_consumed"))
    return {"success": True, "tasks": tasks}
