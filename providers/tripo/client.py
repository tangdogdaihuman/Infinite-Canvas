"""TripoHttpClient：唯一懂 HTTP 的层。

负责：请求头、超时、字段名/取值别名回退。上游文档对 model 字段名与
geometry_quality 取值存在分歧，这里做一次「400 参数校验失败自动回退」——
只在错误信息确实指向正在尝试的字段时才继续，不会重复建任务、不会重复扣点。
"""
from .config import (
    TRIPO_GEO_QUALITY_ALIASES,
    TRIPO_TASK_ENDPOINTS,
    tripo_base_url,
    tripo_error_detail,
    tripo_headers,
)


async def submit_task(client, endpoint, body):
    """提交 Tripo 任务，对上游字段名/取值分歧做一次自动回退。返回最后一个响应对象。

    endpoint 可以是 TRIPO_TASK_ENDPOINTS 的键（如 "text_to_model"），
    也可以直接是 V3 路径（如 "/mesh/decimate"）——能力注册表驱动的新端点走后者。
    """
    path = TRIPO_TASK_ENDPOINTS.get(endpoint, endpoint)
    url = f"{tripo_base_url()}{path}"
    headers = {**tripo_headers(), "Content-Type": "application/json"}
    attempts = [dict(body)]
    # 回退 1：geometry_quality 取值别名
    gq = body.get("geometry_quality")
    if gq in TRIPO_GEO_QUALITY_ALIASES:
        alt = dict(body)
        alt["geometry_quality"] = TRIPO_GEO_QUALITY_ALIASES[gq]
        attempts.append(alt)
    # 回退 2：模型字段名 model_version <-> model
    if "model_version" in body:
        alt = dict(body)
        alt["model"] = alt.pop("model_version")
        attempts.append(alt)
    resp = None
    for i, attempt in enumerate(attempts):
        resp = await client.post(url, headers=headers, json=attempt)
        if resp.status_code == 200:
            return resp
        if resp.status_code != 400:
            return resp
        detail = tripo_error_detail(resp).lower()
        # 只在错误信息确实指向我们正在试的字段时才继续回退
        relevant = ("geometry_quality" in detail) or ("model" in detail) or ("version" in detail)
        if not relevant:
            return resp
    return resp
