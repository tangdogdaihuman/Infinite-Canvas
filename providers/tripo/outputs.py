"""产物管线：远端产物下载落盘 + 魔数后缀纠正。

Tripo CDN 的 URL 后缀与实际内容偶尔不符（如 rendered_image_url 结尾是 .webp、
内容却是 PNG），而前端按扩展名选预览器（glb/gltf → GLTFLoader，fbx → FBXLoader），
后缀写错会直接预览失败，因此保存前以魔数为准纠正。
"""
import ipaddress
import os
import re
import time
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from .config import TRIPO_OUTPUT_DIR

_OUTPUT_URL_PREFIX = "/output/tripo"


def _assert_public_url(url: str):
    """SSRF 防御（个人本地应用级别）：拒绝指向本机/内网的**字面量**地址。

    注意：不做 DNS 解析预检——本机常开 Clash 等代理（fake-ip 段属保留地址），
    域名解析结果不代表真实连接目标（httpx 走代理时连的是代理服务器），
    解析预检会把所有域名误杀；字面量拦截已覆盖最常见的 SSRF 直连探测。
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的下载地址")
    if not host:
        raise HTTPException(status_code=400, detail="无效的下载地址")
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".internal"):
        raise HTTPException(status_code=400, detail="不允许下载内网地址")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return  # 普通域名（CDN 等）放行，交由 httpx/系统代理完成真实连接
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
        raise HTTPException(status_code=400, detail="不允许下载内网地址")


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
    _assert_public_url(url)
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
