"""Tripo V3 接入包。

分层：config（配置/常量）→ client（HTTP/回退）→ service（业务编排）→ router（薄路由）。
产物下载统一走 outputs（魔数后缀纠正）。包内不 import main，避免循环依赖。
"""
from .router import router

__all__ = ["router"]
