# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

无限画布 (Infinite Canvas) — 本地部署的 AI 图像/视频/3D 生成工作台。FastAPI 单体后端 + 无构建步骤的原生 JS 前端。上游仓库 `github.com/hero8152/Infinite-Canvas`（本仓库 `origin` 即上游，分支 `main`）。UI 与代码注释以中文为主。许可：禁止商业用途（详见 README / LICENSE）。

## 常用命令

**优先用仓库内置解释器 `python\python.exe`（Python 3.10.11，依赖已预装）。** 系统或其他环境里的 Python 通常缺 `fastapi`/`requests`，会直接在 `import main` 处报 `ModuleNotFoundError`。

```bash
# 运行（Windows 推荐）：自动选内置 python、杀掉占用端口的本项目旧实例、3 秒后开浏览器
run.bat
# 直接用解释器跑（APP_PORT 控制端口，默认 38080，host 0.0.0.0）
python\python.exe main.py

# 安装依赖（离线 wheel 在 packages/，cp314 win_amd64；requirements.txt 仅 7 个包）
安装依赖.bat          # Windows：先试离线 packages/，失败再联网
pip install -r requirements.txt

# 测试：唯一测试文件是 tests/test_canvas_log_cleanup.py（unittest）
python\python.exe -m unittest discover -s tests -v

# 前端 i18n 校验（唯一的自动化检查；退出码非 0 表示有问题）
node static/js/i18n/validate-i18n.js     # 当前输出 "i18n ok: 1051 keys"
```

### 测试现状与坑

- **`python -m unittest tests.test_canvas_log_cleanup -v` 跑不起来**：`tests/` 下没有 `__init__.py`，会报 `ModuleNotFoundError: No module named 'tests'`；加 `-t .` 同样失败（`Start directory is not importable`）。必须用上面的 `discover -s tests` 形式。
- **该测试文件当前 14/14 全部 ERROR**，根因是 `main.py` 里已不存在它引用的符号：`delete_canvas_log`、`DeleteCanvasLogRequest`、`collect_local_media_urls`、`generated_media_path_from_url`（grep 计数均为 0）。git 历史里能找到 `Merge pull request #166 … pr-canvas-media-cleanup`，但 HEAD 的 `main.py` 已不含该功能实现——测试是残留死角。要用它就得把画布日志清理功能补回 `main.py`，否则应删除该测试；不要为了让它变绿去改测试断言。
- 测试模式：用 `@patch.object(main, "ASSETS_DIR", …)` 重定向**模块级路径常量**到 `tempfile` 目录（见下），基于 `unittest.IsolatedAsyncioTestCase`。这些常量的名字是被测试依赖的契约（`OUTPUT_OUTPUT_DIR`、`CANVAS_DIR`、`CONVERSATION_DIR`、`MEDIA_PREVIEW_DIR`、`GLOBAL_CONFIG_FILE`、`ASSET_LIBRARY_PATH` 等），改名会连带破坏测试。
- 没有 lint / formatter / type-check 配置，没有 CI 配置（无 `.github/`、无 `.cursorrules`、无 `CLAUDE.md`、无 `AGENTS.md`）。

## 架构

### main.py — 单体后端（19,342 行，169 个路由装饰器）

所有服务端逻辑都在这一个文件里。169 个端点按 method 分布：post 84 / get 55 / delete 13 / patch 11 / put 5 / websocket 1。定位区域靠下面这些锚点，不要靠逐行读：

- **常量区 L160-400** 集中了全部配置：
  - 更新源 L165-178：`APP_VERSION`、`GITHUB_*`（repo/version/tree/raw/update-notes）与 `MODELSCOPE_*`（**同一套更新能力的 ModelScope 镜像**，`MODELSCOPE_FILE_API_ROOT` 走 `/api/v1/studio/daniel8152/Infinite-Canvas/repo?Revision=master&File=…`）。注意注释里的坑：ModelScope `.ai` 命名空间是小写 `daniel8152`，路径大小写敏感。更新逻辑同时支持 GitHub 和 ModelScope 两条来源，改一处别漏另一处。
  - **路径常量 L217-253**：`BASE_DIR`、`WORKFLOW_DIR`、`WORKFLOW_PATH`（默认 `workflows/Z-Image.json`）、`STATIC_DIR`、`STATIC_RUNNINGHUB_*`、`OUTPUT_DIR`、`ASSETS_DIR`、`OUTPUT_INPUT_DIR`、`OUTPUT_OUTPUT_DIR`、`ASSET_LIBRARY_DIR`、`LOCAL_UPLOAD_DIR`、`HISTORY_FILE`、`API_ENV_FILE`、`DATA_DIR`、`CONVERSATION_DIR`、`CANVAS_DIR`、`MEDIA_PREVIEW_DIR`、`ASSET_LIBRARY_PATH`、`PROMPT_LIBRARY_PATH`、`API_PROVIDERS_FILE`、`RUNNINGHUB_WORKFLOW_STORE_FILE`、`SHARED_FOLDERS_FILE`、`GLOBAL_CONFIG_FILE`、`STORAGE_SETTINGS_FILE`。另有 `CANVAS_TRASH_RETENTION_MS = 30 天`、`LOCAL_IMAGE_IMPORT_MAX_BYTES`（默认 50MB）、`LOCAL_IMAGE_IMPORT_EXTS`。
  - **锁 L299-308**：每个 JSON 存储一把 `threading.Lock`——`QUEUE_LOCK`、`HISTORY_LOCK`、`GLOBAL_CONFIG_LOCK`、`CONVERSATION_LOCK`、`CANVAS_LOCK`、`LOAD_LOCK`、`RUNNINGHUB_WORKFLOW_LOCK`、`UPDATE_LOCK`，外加 `QUEUE` 列表和 `NEXT_TASK_ID` 计数器。**约定：任何读写对应存储的 handler 都必须取对应的 `_LOCK`**，这是并发正确性的主要防线。
- **Provider 体系**：`data/api_providers.json` 存 provider 配置（本仓库实测 144KB），`API/.env` 存 key。`SUPPORTED_PROVIDER_PROTOCOLS`（L317）枚举协议：`openai` / `apimart` / `gemini` / `gemini-cli` / `volcengine` / `runninghub` / `jimeng` / `codex` / `tripo`。另有独立枚举 `SUPPORTED_IMAGE_REQUEST_MODES`（L318）控制单 provider 内部的请求形态：`openai` / `openai-json` / `openai-video-proxy` / `openai-responses` / `tudou-async`。周边还有 `LINGJING_DEFAULT_BASE_URL`（apistudio.vip）、`AGNES_*`、`RUNNINGHUB_*`、`VOLCENGINE_*`、`JIMENG_*`、`CODEX_*`、`GEMINI_CLI_*` 各自的默认模型/base_url 常量。文生图统一走 `generate_ai_image()` 分发到 `generate_<provider>_provider_image()`；视频是独立的 per-provider 函数。`FIXED_PROTOCOL_PROVIDER_IDS` 里的 provider 协议不可改。
- **本地 ComfyUI 生成**：`POST /api/generate`（L18456）是主入口。全局任务队列（`QUEUE` + `QUEUE_LOCK` + `NEXT_TASK_ID`），多实例负载均衡（`COMFYUI_INSTANCES` env + `reserve_best_backend()`），并在实例间同步输入图片（`/view` 探测 + `/upload/image` 推送）。
- **云端生成**：`POST /generate`（L18261）走 ModelScope 异步任务轮询。
- **画布与回收站**：`/api/canvases`（L16382 起）一族，含 `/api/canvases/trash`、`/{canvas_id}/touch`、`/{canvas_id}/meta`、`/{canvas_id}/restore`、`/{canvas_id}/purge`。回收站保留期即 `CANVAS_TRASH_RETENTION_MS`（30 天）。任务侧有 `/api/canvas-image-tasks`（L14802）、`/api/canvas-comfy-tasks`（L14855），`/api/media-preview`（L7127）生成缩略图缓存。
- **路由家族地图**（按前缀计数，用于快速定位）：`/api/asset-library`(18)、`/api/local-assets`(11)、`/api/runninghub`(11)、`/api/canvases`(11)、`/api/prompt-libraries`(11)、`/api/jimeng`(7)、`/api/providers`(6)、`/api/shared-folders`(6)、`/api/workflows`(6)、`/api/tripo`(5)、`/api/midjourney`(4)、`/api/conversations`(4)、`/api/projects`(4)、`/api/smart-canvas`(3，另有 L11803 的 minimax-export、L16784 的 group-export、L16498 的 prompt-templates)、`/api/storage-files`(3)、`/api/ai`(3)、`/api/comfyui`(3)、`/api/canvas-assets`(3)、`/api/canvas-workflows`(3)、`/api/chat`(3)、`/api/storage-settings`(2)、`/api/config`(2)、`/api/history`(2)、`/api/codex`(2)、`/api/gemini-cli`(2)、`/api/angle`(2)，以及 `/ws/stats`、`/api/app-info`、`/api/check-update`、`/api/update-from-github`、`/api/update-backups`、`/api/update-rollback`、`/api/upload`、`/api/view`、`/api/download-output`、`/api/models`、`/api/queue_status`、`/` 等。
- **工作流系统**：`workflows/*.json` 是 ComfyUI **API 格式**节点图；同名 `*.config.json` 定义前端表单字段（`fields[]` 每项含 `node` / `input` / `type` / `bind_prompt`）。测试端点把表单值写进 `params[node][input]` 后复用 `generate()`。新增工作流 = 加一对 `xxx.json` + `xxx.config.json`（当前只有 `LTXDirectorv2-API`、`MiniMax_H3` 带 config）。
- **WebSocket `/ws/stats`**（L201）：`ConnectionManager` 广播 `broadcast_canvas_updated` / `broadcast_asset_library_updated`，做多客户端（浏览器 + PS UXP 面板）同步；`client_id` 用于排除发送者自己。
- **启动迁移**（`@app.on_event("startup")`，L180 起的 `startup_event`）：先 `sync_static_html_versions()` 重写 HTML 里的 `?v=` 缓存参数，再做资产库目录归整、双重扩展名修复（`foo.png.png`）、内容/扩展名不符纠正（WebP 冒充 `.png`）。**每次启动都跑，改这些数据结构时必须保持幂等。** HTML 响应由中间件打 `Cache-Control: no-cache`（L1567-1571）。
- **uvicorn 启动 L19335-19342**：`port = int(os.getenv("APP_PORT") or "38080")`，`host="0.0.0.0"`，**故意设 `ws_ping_interval=None, ws_ping_timeout=None`**——PS UXP 面板不应答协议层 pong，默认 20s ping/超时会把它每隔一会儿踢下线。客户端靠应用层心跳 + 断线重连兜底，别"修好"这个参数。

### static/ — 无构建前端（原生 JS，单文件巨大）

每个 HTML 页面对应同名 js/css，无打包、无框架、无模块系统。改动后浏览器需硬刷新（`Ctrl+Shift+R`），版本参数由 `sync_static_html_versions()` 在启动时统一重写。

- 主页面：`index.html`（128KB，AI Studio 入口）、`canvas.html` + `js/canvas.js`（830KB，普通无限画布，节点式，含 `js/ltx-director-timeline.js` 154KB 时间轴模块）、`smart-canvas.html` + `js/smart-canvas.js`（1,012KB，智能画布，卡片/节点式编排）、`canvas-list.html`（画布列表）、`asset-manager.html`（素材库）、`api-settings.html` / `comfyui-settings.html`（设置页）。
- 单模型终端页：`klein.html`、`zimage.html`、`enhance.html`、`angle.html`、`online.html`、`gpt-chat.html`（115KB）。
- `js/` 下的共享模块：`theme.js`、`i18n.js`、`image-preview.js`、`touch-mouse.js`、`tripo-common.js`、`history-bulk-manager.js`（被 5 个单模型页复用）。
- `static/runninghub/` 存 RunningHub 的本地注册表：`api_providers.json`、`models_registry.json`、`thumbnails/`。
- **i18n 架构**：`js/i18n.js` 是个加载器，内含硬编码 `const VERSION`，按序注入 `i18n-core.js` → `i18n/common.js` → `i18n/studio.js` → `i18n/api-settings.js` → `i18n/canvas.js` → `i18n/smart-canvas.js` → `i18n/comfyui-settings.js`，再调 `window.StudioI18n.apply()`。字典按页面分文件。词条引用形式：`data-i18n(-xxx)` 属性、`tr('key')`、`trf('key')`、`tf('key')`。`js/i18n/validate-i18n.js` 用 `vm` 沙箱加载所有字典，检查 zh/en 缺失、**mojibake 乱码**（正则含 `� 璁 娴 澶 鎻 鐢 鍙 杈 绋 鏂 涓`）、以及 HTML/JS 中引用但未定义的 key——**这就是本仓库唯一的"测试"，改 i18n 或页面后跑它**。
- **历史快照备份文件，不要编辑也不要当现状参考**：`*.broken-before-stable-*`、`*.mojibake-backup`、`*.stable-before-*`（存在于 `static/css/` 与 `static/js/`，如 `smart-canvas.js.mojibake-backup` 941KB）。它们的存在说明这个仓库**踩过严重的编码/乱码事故**：所有中文内容按 UTF-8 读写，写文件时别用非 UTF-8 编码，别用会二次转码的 shell 重定向。
- 已知杂物：`static/js/i18n(1)/` 是带括号的目录（只含一个 `smart-canvas.js`），属误产生的重复副本；`static/js/i18n` 才是生效目录。

### 数据与媒体

**JSON 文件即数据库**，没有 ORM、没有迁移框架，全部走 `json.load`/`json.dump` + 对应的 `_LOCK`。

`data/`：`api_providers.json`（provider 配置）、`asset_library.json`、`prompt_libraries.json`、`projects.json`、`canvases/*.json`（每个画布一个文件，30 天回收站保留期）、`conversations/`、`media_previews/`（缩略图缓存，本仓库已积累 1000+ 文件）。`storage_settings.json`、`runninghub_workflows.json`、`shared_folders.json` **都是首次写入时才创建**——目录里没有是正常的，不是坏了。同理根目录 `global_config.json` 也是懒创建。

媒体：`assets/input`（上传/参考图）、`assets/output`（生成结果，**新版生成产物落这里**）、`assets/library`（素材库实体）、`assets/uploads`（本地导入）；根 `output/` 现在只剩 `output/tripo/`（旧版输出与 tripo 3D），不要以为生成结果还在那。存储路径可被 `data/storage_settings.json` 重定向，键为 `upload` / `generated` / `local`（见 `DEFAULT_STORAGE_DIRS`），由 `apply_storage_settings()` 与 `_storage_abs_path()` 生效。

### 周边组件

- `CLI/`：按平台组织的第三方 CLI 安装/登录脚本——`windows/`、`macos/`、`linux/` 下的 `openai`（Codex）、`gemini`、`jimeng`（即梦）。`windows/openai/vendor/` 带 `gpt-image-2-skill-*.tgz` 预编译包（x64 / arm64 各 4MB+）。后端通过 shell 调这些 CLI；jimeng 在 Windows 上走 WSL（`jimeng_use_wsl()`），消耗即梦会员积分生图/生视频。`tools/jimeng_cli_install.ps1` 与 `tools/jimeng_cli_login.ps1` 是同一套脚本的副本。
- `tools/chrome-local-asset-importer/`：Chrome 插件（MV3），批量抓网页素材进素材库。`tools/photoshop-asset-connector/`：PS UXP 面板，经 WebSocket 直连画布调用全部能力（与 `ws_ping_interval=None` 直接相关）。
- `packages/`：离线 pip wheel，供无网环境安装。
- `python/`：内置 Python **3.10.11** 运行时，依赖已装好，脚本与测试优先用它。

### 已有文档（不要重写，按需更新）

`README.md`（项目介绍/许可/赞助链接）、`新手运行与使用教程.md`（面向零基础用户的超长教程）、`MAC-使用说明.md`、`运行说明.txt`、`CLI/README.md`、`tools/*/README.md`。注意教程里写的入口名是网盘整包里的 `启动服务.bat`（**GitHub 源码包中不存在**，源码入口是 `run.bat`），也提到 `python.zip`（同样只存在于网盘包）。

## 约定

- 中文注释、中文 commit message（历史提交形如"修复bug"、"更新功能"、"更新协议"、"GPT CLI"）。
- `VERSION` 文件用日期格式（当前 `2026.08.04`），每次发布递增；前端 i18n 加载器里的 `VERSION` 常量是独立的一套（`2026.07.04.rec-ui.1`），别混。
- **已知不一致（改动前先确认）**：`main.py` L165 的 `APP_VERSION = "2026.06.03"` 与 `VERSION` 文件的 `2026.08.04` 已经脱节。`/api/app-info` 用的是 `current_app_version()`，判断"当前版本"时以它/`VERSION` 为准，别信 `APP_VERSION`。
- 前端改动后 HTML 的 `?v=` 版本参数由启动函数自动重写，但手动编辑 HTML 时要注意这个参数的存在。
- 端口默认 38080（刻意避开 3000/5000/8000/8080 等热门端口）；改端口只设 `APP_PORT`，`run.bat` 与 `main.py` 共用该变量，`run.bat` 会自动清掉占用该端口的本项目旧实例。
- 上游更新包会覆盖 `static/` 等目录结构，个人数据只在 `API/`、`data/`、`assets/`、`output/`、`workflows/custom/`——涉及升级/自更新逻辑时不要动这几处。
