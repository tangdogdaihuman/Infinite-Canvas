"""业务编排：余额、上传、任务创建/查询的请求体组装与结果归一化。

只依赖 config / client，不感知 HTTP 路由层；提交前的参数规则（生成类必须带
model_version、贴图版本白名单、P1 参数剔除）全部收口在这里。
"""
import asyncio
import base64

import httpx
from fastapi import HTTPException

from . import capabilities as cap_registry
from . import events, store
from .client import submit_task
from .config import (
    TRIPO_BOOL_PARAMS,
    TRIPO_DEFAULT_MODEL_VERSION,
    TRIPO_GENERATION_TASK_TYPES,
    TRIPO_INT_PARAMS,
    TRIPO_LEGACY_MODEL_VERSIONS,
    TRIPO_STR_PARAMS,
    TRIPO_TASK_TYPES,
    TRIPO_TEXTURE_MODEL_VERSIONS,
    TRIPO_TEXTURE_QUALITIES,
    tripo_base_url,
    tripo_error_detail,
    tripo_headers,
)


async def balance() -> dict:
    """查询账户余额（余额接口同时充当 key/地址连通性校验）。"""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{tripo_base_url()}/account/balance", headers=tripo_headers())
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Tripo 余额查询失败：{tripo_error_detail(resp)}")
    data = resp.json()
    if data.get("code") not in (0, None):
        raise HTTPException(status_code=400, detail=f"Tripo 余额查询失败：{data.get('message') or data}")
    payload = data.get("data") if isinstance(data.get("data"), dict) else data
    payload = payload or {}
    return {"success": True, "balance": payload.get("balance"), "frozen": payload.get("frozen"), "raw": payload}


async def upload_image(payload: dict) -> dict:
    """上传图片（base64）→ file_token。"""
    name = (payload.get("name") or "image.png").strip() or "image.png"
    data_b64 = payload.get("data_base64") or ""
    if data_b64.startswith("data:") and "," in data_b64:
        data_b64 = data_b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(data_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="图片数据解码失败")
    if not raw:
        raise HTTPException(status_code=400, detail="图片数据为空")
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(f"{tripo_base_url()}/files", headers=tripo_headers(), files={"file": (name, raw)})
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Tripo 图片上传失败：{tripo_error_detail(resp)}")
    data = resp.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=400, detail=f"Tripo 图片上传失败：{data.get('message') or data}")
    token = (data.get("data") or {}).get("file_token") or (data.get("data") or {}).get("image_token")
    if not token:
        raise HTTPException(status_code=400, detail=f"Tripo 上传未返回 file_token：{data}")
    return {"success": True, "file_token": token}


def build_task_body(payload: dict) -> tuple:
    """按 task_type 组装上游请求体。返回 (task_type, body, stripped_params)。"""
    task_type = (payload.get("task_type") or "").strip()
    if task_type not in TRIPO_TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"不支持的 Tripo 任务类型：{task_type}")
    body = {}
    model_version = (payload.get("model_version") or "").strip()
    if task_type in TRIPO_GENERATION_TASK_TYPES:
        if model_version.lower() in TRIPO_LEGACY_MODEL_VERSIONS:
            model_version = ""
        body["model_version"] = model_version or TRIPO_DEFAULT_MODEL_VERSION
    elif model_version:
        body["model_version"] = model_version
    file_tokens = payload.get("file_tokens") or []
    file_types = payload.get("file_types") or []
    if task_type == "image_to_model":
        if not file_tokens:
            raise HTTPException(status_code=400, detail="缺少输入图片")
        body["file"] = {"type": (file_types[0] if file_types else "png"), "file_token": file_tokens[0]}
    elif task_type == "multiview_to_model":
        if len(file_tokens) < 4:
            raise HTTPException(status_code=400, detail="四视图模式需要 4 张图片（前/后/左/右）")
        body["files"] = [
            {"type": (file_types[i] if i < len(file_types) else "png"), "file_token": token}
            for i, token in enumerate(file_tokens[:4])
        ]
        body["ortho_projection"] = bool(payload.get("ortho_projection", True))
    elif task_type == "text_to_model":
        prompt = (payload.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="缺少提示词")
        body["prompt"] = prompt
        negative = (payload.get("negative_prompt") or "").strip()
        if negative:
            body["negative_prompt"] = negative
    elif task_type in ("texture_model", "convert_model", "refine_model"):
        original = (payload.get("original_task_id") or "").strip()
        if not original:
            raise HTTPException(status_code=400, detail="缺少原始任务 ID")
        if task_type == "refine_model":
            body["draft_model_task_id"] = original
        else:
            body["original_model_task_id"] = original
        if task_type == "convert_model":
            body["format"] = (payload.get("format") or "GLB").strip().upper()
    stripped = []
    for key in TRIPO_BOOL_PARAMS:
        if payload.get(key) is not None:
            body[key] = bool(payload.get(key))
    for key in TRIPO_STR_PARAMS:
        val = payload.get(key)
        if isinstance(val, str):
            val = val.strip()
        if val:
            body[key] = val
    for key in TRIPO_INT_PARAMS:
        if payload.get(key) not in (None, ""):
            try:
                body[key] = int(payload.get(key))
            except (TypeError, ValueError):
                pass
    if body.get("texture_quality") and body["texture_quality"] not in TRIPO_TEXTURE_QUALITIES:
        body["texture_quality"] = "standard"
    # models/texture 只接受 v3.0 / v2.5 两个贴图版本，其它值直接丢弃（让服务端用默认）
    if task_type == "texture_model" and body.get("model_version") not in TRIPO_TEXTURE_MODEL_VERSIONS:
        if body.pop("model_version", None):
            stripped.append("model_version")
    # P1 不接受这些几何参数（即使传 false/null 也会被上游拒绝）
    if str(body.get("model_version") or "").upper().startswith("P1"):
        for key in ("quad", "smart_low_poly", "generate_parts", "geometry_quality"):
            if body.pop(key, None) is not None:
                stripped.append(key)
    return task_type, body, stripped


async def create_task(payload: dict) -> dict:
    """创建任务并解析上游响应 → task_id。"""
    task_type, body, stripped = build_task_body(payload)
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await submit_task(client, task_type, body)
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Tripo 任务创建失败：{tripo_error_detail(resp)}")
    data = resp.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=400, detail=f"Tripo 任务创建失败：{data.get('message') or data}")
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        raise HTTPException(status_code=400, detail=f"Tripo 未返回 task_id：{data}")
    store.record(task_id, task_type, params=body)
    # 生成三模式同样挂后台观察器：任务中心/WS 进度推送覆盖全部 Tripo 任务（前端 pollTask 仍是兜底）
    asyncio.create_task(events.watch_task(task_id))
    return {"success": True, "task_id": task_id, "request": body, "stripped_params": stripped}


def normalize_task_output(task: dict) -> dict:
    """V3 输出字段名归一化为前端读取的键名（model/pbr_model/rendered_image）。"""
    output = task.get("output")
    if isinstance(output, dict):
        model_url = output.get("model_url")
        if model_url:
            output.setdefault("model", model_url)
            output.setdefault("pbr_model", model_url)
            output.setdefault("base_model", model_url)
        # 动画重定向等任务返回 model_urls 数组（多动作各一个文件），取首个作为主产物
        model_urls = output.get("model_urls")
        if isinstance(model_urls, list) and model_urls and not output.get("model"):
            output["model"] = model_urls[0]
            output.setdefault("pbr_model", model_urls[0])
        if output.get("rendered_image_url"):
            output.setdefault("rendered_image", output["rendered_image_url"])
        if output.get("generated_image_url"):
            output.setdefault("generated_image", output["generated_image_url"])
    if task.get("error_message") and not task.get("error"):
        task["error"] = task["error_message"]
    return task


async def query_task(task_id: str) -> dict:
    """查询单个任务并归一化输出字段（顺带回写任务档案）。"""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{tripo_base_url()}/tasks/{task_id}", headers=tripo_headers())
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Tripo 任务查询失败：{tripo_error_detail(resp)}")
    data = resp.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=400, detail=f"Tripo 任务查询失败：{data.get('message') or data}")
    task = data.get("data") or {}
    store.update(task_id, status=task.get("status"), progress=task.get("progress"), credits=task.get("credits_consumed"))
    return {"success": True, "task": normalize_task_output(task)}


# ---------- 能力注册表驱动：统一提交 ----------

def list_capabilities() -> list:
    """前端能力卡的元数据源。"""
    return cap_registry.list_public()


def _clean_params(cap, payload: dict) -> tuple:
    """按注册表 ParamSpec 校验/裁剪参数。返回 (clean, stripped_unknown)。"""
    clean, stripped = {}, []
    declared = {p.name for p in cap.params}
    allowed_in = {"original_task_id", "input"} if cap.input_kind == "image" else {"original_task_id"}
    for key in sorted(set(payload) - declared - allowed_in):
        stripped.append(key)
    for p in cap.params:
        if p.name not in payload or payload.get(p.name) is None:
            continue
        value = payload.get(p.name)
        label = p.label or p.name
        if p.type == "bool":
            clean[p.name] = bool(value)
        elif p.type in ("int", "float"):
            try:
                num = int(value) if p.type == "int" else float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"参数「{label}」格式不正确")
            if p.min is not None and num < p.min or p.max is not None and num > p.max:
                raise HTTPException(status_code=400, detail=f"参数「{label}」超出范围（{p.min} ~ {p.max}）")
            clean[p.name] = num
        elif p.type == "enum":
            text = str(value).strip()
            if p.options and text not in p.options:
                raise HTTPException(status_code=400, detail=f"参数「{label}」只支持：{' / '.join(p.options)}")
            if text:
                clean[p.name] = text
        elif p.type == "str":
            text = str(value).strip()
            if text:
                clean[p.name] = text
        elif p.type == "list":
            items = [x.strip() for x in str(value).replace("\n", ",").split(",") if x.strip()]
            if items:
                clean[p.name] = items[:20]
    # 分能力参数规则（官方 wire 契约，收口在这里）：
    # retarget：单个动作键 animation 传字符串，多个动作键 animations 传数组（AnimationInput 的单/多形态）
    if cap.id == "retarget":
        anims = clean.pop("animation", None) or []
        if len(anims) == 1:
            clean["animation"] = anims[0]
        elif anims:
            clean["animations"] = anims
        bad = [a for a in anims if not str(a).startswith("preset:")]
        if bad:
            raise HTTPException(status_code=400, detail=f"动作只支持 preset:* 预设（如 preset:walk），收到：{bad}")
    return clean, stripped


async def submit_capability(cap_id: str, payload: dict) -> dict:
    """统一提交入口：校验 → 组装 → 提交 → task_id。支持三类输入。"""
    cap = cap_registry.get_capability(cap_id)
    if not cap:
        raise HTTPException(status_code=404, detail=f"未知能力：{cap_id}")
    if not cap.enabled:
        raise HTTPException(status_code=400, detail=f"「{cap.label}」尚未开放，请关注后续版本")
    clean, stripped = _clean_params(cap, payload)
    body = dict(clean)
    if cap.input_kind == "model_task":
        original = str(payload.get("original_task_id") or "").strip()
        if not original:
            raise HTTPException(status_code=400, detail="缺少原始任务 ID（请先生成模型）")
        body[cap.id_field] = original
    elif cap.input_kind == "image":
        input_ref = str(payload.get("input") or "").strip()
        if not input_ref:
            raise HTTPException(status_code=400, detail="缺少输入（图片/模型的 URL、file_token 或上游任务 ID）")
        body["input"] = input_ref
    elif cap.input_kind == "none":
        if not str(body.get("prompt") or "").strip():
            raise HTTPException(status_code=400, detail="缺少提示词")
    if cap.engine:
        body[cap.engine_field] = cap.engine  # V3 新端点字段名 model；legacy 端点 model_version（见 Capability 注释）
    if cap.id == "convert":
        body.setdefault("format", "GLB")
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await submit_task(client, cap.endpoint, body)
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"Tripo {cap.label}失败：{tripo_error_detail(resp)}")
    data = resp.json()
    if data.get("code") != 0:
        raise HTTPException(status_code=400, detail=f"Tripo {cap.label}失败：{data.get('message') or data}")
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        raise HTTPException(status_code=400, detail=f"Tripo 未返回 task_id：{data}")
    store.record(task_id, cap.id, params=body)
    # 后台观察进度并经 /ws/stats 广播（前端轮询仍是完成判定的兜底）
    asyncio.create_task(events.watch_task(task_id))
    return {"success": True, "task_id": task_id, "capability": cap.id, "request": body, "stripped_params": stripped}
