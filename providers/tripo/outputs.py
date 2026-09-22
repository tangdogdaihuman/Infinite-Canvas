"""产物管线：远端产物下载落盘 + 魔数后缀纠正。

Tripo CDN 的 URL 后缀与实际内容偶尔不符（如 rendered_image_url 结尾是 .webp、
内容却是 PNG），而前端按扩展名选预览器（glb/gltf → GLTFLoader，fbx → FBXLoader），
后缀写错会直接预览失败，因此保存前以魔数为准纠正。
"""
import os
import re
import time

import httpx
from fastapi import HTTPException

from .config import TRIPO_OUTPUT_DIR

_OUTPUT_URL_PREFIX = "/output/tripo"


def sniff_binary_ext(content: bytes) -> str:
    """按文件魔数判定扩展名。识别不出时返回空串。"""
    head = content[:16]
    if head[:4] == b"glTF":
        return ".glb"
    if head[:7] == b"Kaydara" or head[:5] == b"; FBX":
        return ".fbx"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if head[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if head[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    if head[:2] == b"PK":
        return ".zip"
    return ""


def _clean_fragment(value: str, max_len: int) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "", value or "")[:max_len]


def _name_for(url: str, kind: str, name_hint: str, ext: str) -> str:
    return f"tripo_{int(time.time())}_{kind}{('_' + name_hint) if name_hint else ''}{ext}"


async def download_remote(url: str, kind: str = "model", name_hint: str = "") -> dict:
    """下载远端产物并落盘到 /output/tripo/，返回 {url, name, size}。"""
    url = (url or "").strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="无效的下载地址")
    kind = _clean_fragment(kind or "model", 20) or "model"
    name_hint = _clean_fragment(name_hint, 40)
    ext = ".glb"
    path_part = url.split("?", 1)[0]
    tail = path_part.rsplit("/", 1)[-1]
    if "." in tail:
        ext = "." + tail.rsplit(".", 1)[-1].lower()[:8]
    fname = _name_for(url, kind, name_hint, ext)
    fpath = os.path.join(TRIPO_OUTPUT_DIR, fname)
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        resp = await client.get(url)
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="Tripo 文件下载失败")
    # 魔数优先：前端按扩展名选预览器，后缀错会直接预览失败
    sniffed = sniff_binary_ext(resp.content)
    if sniffed and sniffed != ext:
        ext = sniffed
        fname = _name_for(url, kind, name_hint, ext)
        fpath = os.path.join(TRIPO_OUTPUT_DIR, fname)
    with open(fpath, "wb") as fh:
        fh.write(resp.content)
    return {"success": True, "url": f"{_OUTPUT_URL_PREFIX}/{fname}", "name": fname, "size": len(resp.content)}
