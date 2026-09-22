"""Tripo 配置层：路径、常量、密钥与 base_url 解析。

纯数据与读取函数，不依赖 main.py；密钥惰性读取（os.environ 由 main.py 的 load_env_file 在启动时注入）。
"""
import json
import os

from fastapi import HTTPException

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
API_PROVIDERS_FILE = os.path.join(DATA_DIR, "api_providers.json")

# Tripo API V3（V2 于 2026-11-01 下线）。国内站与国际站 Key 不通用，base_url 区域必须与 Key 匹配。
TRIPO_BASE_URL = "https://openapi.tripo3d.com/v3"
TRIPO_OUTPUT_DIR = os.path.join(OUTPUT_DIR, "tripo")
os.makedirs(TRIPO_OUTPUT_DIR, exist_ok=True)
TRIPO_TASK_TYPES = {"text_to_model", "image_to_model", "multiview_to_model", "texture_model", "convert_model", "refine_model"}
# V3 按能力拆分独立端点，不再使用 POST /task + type 字段
TRIPO_TASK_ENDPOINTS = {
    "text_to_model": "/generation/text-to-model",
    "image_to_model": "/generation/image-to-model",
    "multiview_to_model": "/generation/multiview-to-model",
    "texture_model": "/models/texture",
    "convert_model": "/models/convert",
    "refine_model": "/models/refine",
}
# V3 生成类任务必须显式传 model_version；V2 旧版本号统一回落到官方服务端默认（v3.1）
TRIPO_GENERATION_TASK_TYPES = {"text_to_model", "image_to_model", "multiview_to_model"}
TRIPO_DEFAULT_MODEL_VERSION = "v3.1-20260211"
TRIPO_LEGACY_MODEL_VERSIONS = {
    "", "default", "v1.3-20240522", "v1.4-20240625", "v2.0-20240919",
    "turbo-v1.0-20250506", "v2.5-20260210",
}
TRIPO_LEGACY_BASE_URLS = {
    "https://api.tripo3d.com/v2/openapi": "https://openapi.tripo3d.com/v3",
    "https://api.tripo3d.ai/v2/openapi": "https://openapi.tripo3d.ai/v3",
}
# 上游文档存在分歧，提交时做一次「参数校验失败自动回退」（见 client.submit_task）：
# 1) 模型字段名：官方 JS/Go SDK 用 model，V3 文档回显用 model_version；
# 2) geometry_quality 取值：官方 Changelog 写 detailed，阿里云最新文档写 ultra。
TRIPO_MODEL_FIELD_ALIASES = ("model_version", "model")
TRIPO_GEO_QUALITY_ALIASES = {"ultra": "detailed", "detailed": "ultra", "high": "ultra"}
# models/texture 只接受这两个贴图版本（官方 SDK versions.rs）
TRIPO_TEXTURE_MODEL_VERSIONS = {"v3.0-20250812", "v2.5-20250123"}
TRIPO_TEXTURE_QUALITIES = {"standard", "detailed", "extreme"}
TRIPO_BOOL_PARAMS = ("texture", "pbr", "quad", "auto_size", "smart_low_poly", "generate_parts", "autofix")
TRIPO_STR_PARAMS = ("texture_quality", "texture_alignment", "orientation", "style", "geometry_quality")
TRIPO_INT_PARAMS = ("face_limit", "texture_seed")


def normalize_tripo_base_url(url):
    """旧 V2 地址自动映射到同区域 V3 端点（国内 .com / 国际 .ai 互不通用）。"""
    root = str(url or "").strip().rstrip("/")
    return TRIPO_LEGACY_BASE_URLS.get(root.lower(), root)


def _provider_base_url():
    """从 data/api_providers.json 直读 tripo 条目的 base_url（只取这个字段，与 main.py 的归一化结果一致）。"""
    try:
        if os.path.exists(API_PROVIDERS_FILE):
            with open(API_PROVIDERS_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
            for item in raw:
                if isinstance(item, dict) and item.get("id") == "tripo":
                    url = str(item.get("base_url") or "").strip()
                    if url:
                        return url
    except Exception:
        pass
    return ""


def tripo_base_url():
    """优先使用 API 设置里 Tripo 平台的 base_url（支持国内/国际站切换）。"""
    url = _provider_base_url()
    return normalize_tripo_base_url(url) if url else TRIPO_BASE_URL


def tripo_api_key():
    return (os.environ.get("TRIPO_API_KEY") or "").strip()


def tripo_headers():
    key = tripo_api_key()
    if not key:
        raise HTTPException(status_code=400, detail="未配置 Tripo API Key，请在 API 设置中为 Tripo 3D 平台填写密钥")
    return {"Authorization": f"Bearer {key}"}


def tripo_error_detail(resp):
    try:
        data = resp.json()
        return data.get("message") or data.get("error") or str(data)[:300]
    except Exception:
        return (resp.text or "")[:300]
