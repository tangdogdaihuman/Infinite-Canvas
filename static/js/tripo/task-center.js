/* Tripo 任务中心（双画布共享组件）。
 * 用法：window.TripoTaskCenter.init({button, mountTo, topOffset})
 *   button    徽章按钮元素或选择器（必填；徽章 <em class="tripo-tasks-badge"> 自动注入）
 *   mountTo   抽屉挂载容器元素或选择器（默认 document.body）
 *   topOffset 抽屉距视口顶部像素（默认 70）
 * 抽屉 DOM 与样式全部由本文件动态注入，不依赖各画布的 CSS 文件（按钮自身的样式由画布定义）。
 * 数据源：GET /api/tripo/tasks（本机档案）+ POST /api/tripo/tasks/query（上游批量同步）；
 * 实时刷新：监听 window 'tripo-task-progress'（两画布的 /ws/stats onmessage 均转发此事件）。
 * 依赖：tripo-common.js 先于本文件引入（可无——本文件自带 escapeHtml/tl 兜底）。 */
(function(){
'use strict';

const CSS = `
.tripo-tasks-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#2fc98f;color:#0c1210;
  font-size:10px;font-weight:900;font-style:normal;display:inline-flex;align-items:center;justify-content:center;margin-left:5px}
.tripo-tasks-badge[hidden]{display:none}
.tripo-tasks-panel{position:fixed;right:22px;top:70px;z-index:57;width:390px;max-width:calc(100vw - 44px);
  max-height:min(430px, calc(100vh - 96px));min-height:0;display:flex;flex-direction:column;border:1px solid var(--line);
  border-radius:18px;background:var(--panel);color:var(--text);box-shadow:0 22px 58px var(--shadow);
  backdrop-filter:blur(20px);overflow:hidden;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);
  transition:opacity .16s ease, transform .16s ease, visibility .16s ease}
.tripo-tasks-panel.open{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}
.tripo-tasks-head{min-height:54px;padding:10px 12px 8px;border-bottom:1px solid var(--line);display:flex;align-items:center;
  justify-content:space-between;gap:12px}
.tripo-tasks-title{color:var(--text);font-size:15px;line-height:1.2;font-weight:900}
.tripo-tasks-sub{margin-top:3px;color:var(--muted);font-size:11px;line-height:1.3;font-weight:650}
.tripo-tasks-actions{display:flex;align-items:center;gap:6px}
.tripo-tasks-mini{width:26px;height:26px;border-radius:9px;background:transparent;color:var(--muted);display:inline-flex;
  align-items:center;justify-content:center;border:1px solid transparent;cursor:pointer}
.tripo-tasks-mini:hover{color:var(--text);background:var(--card);border-color:var(--line)}
.tripo-tasks-mini i,.tripo-tasks-mini svg{width:13px;height:13px}
.tripo-tasks-body{flex:1;min-height:0;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px;
  scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.42) transparent}
.tripo-task-item{border:1px solid var(--line);border-radius:12px;background:var(--card);padding:9px 10px;
  display:flex;flex-direction:column;gap:6px}
.tripo-task-row{display:flex;align-items:center;gap:8px;min-width:0}
.tripo-task-kind{font-size:12px;font-weight:800;color:var(--text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tripo-task-id{font-size:10px;color:var(--faint);font-family:ui-monospace, monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tripo-task-chip{flex:none;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px}
.tripo-task-chip.queued{background:var(--soft);color:var(--muted)}
.tripo-task-chip.running{background:rgba(59,130,246,.14);color:#2563eb}
.tripo-task-chip.success{background:rgba(34,197,94,.14);color:#16a34a}
.tripo-task-chip.failed,.tripo-task-chip.banned,.tripo-task-chip.expired,.tripo-task-chip.unknown{background:rgba(239,68,68,.14);color:#dc2626}
.tripo-task-chip.cancelled{background:rgba(148,163,184,.18);color:var(--muted)}
.tripo-task-bar{height:4px;border-radius:999px;background:var(--soft);overflow:hidden}
.tripo-task-bar i{display:block;height:100%;border-radius:999px;background:#2fc98f;transition:width .4s ease}
.tripo-task-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--faint);font-weight:650}
.tripo-task-credits{color:#7fe0bc;font-weight:800}
.tripo-tasks-empty{padding:26px 10px;text-align:center;color:var(--faint);font-size:11.5px;font-weight:650}
@media (max-width:900px){
  .tripo-tasks-panel{right:14px;top:86px;width:calc(100vw - 28px);max-height:calc(100vh - 100px)}
}
`;

function esc(str){
    return String(str == null ? '' : str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
/* i18n：有 StudioI18n 用它，缺 key 回退中文 */
function tl(key, fallback){
    const v = window.StudioI18n?.t?.(key);
    return (v && v !== key) ? v : fallback;
}

const KIND_LABELS = {
    text_to_model:'文生模型', image_to_model:'单图建模', multiview_to_model:'四视图建模',
    texture_model:'贴图', convert_model:'格式转换', refine_model:'精修',
    decimate:'减面', segment:'拆件', complete:'补全', texture:'贴图', refine:'精修', stylize:'风格化',
    rig_check:'绑骨检测', rig:'自动绑骨', retarget:'动画重定向', convert:'格式转换',
    text_to_image:'文生概念图', image_to_image:'图生图', image_to_multiview:'单图生四视图',
    edit_multiview:'编辑四视图', import_model:'导入外部模型'
};
const TERMINAL = ['success','failed','cancelled','banned','expired','unknown'];
const STATUS_LABELS = {queued:'排队中', running:'进行中', success:'已完成', failed:'失败', cancelled:'已取消', banned:'封禁', expired:'已过期', unknown:'未知'};

const state = {tasks:[], loading:false, panel:null, btn:null, badge:null, inited:false};

function taskTime(ts){
    const t = new Date(Number(ts) || 0);
    if(isNaN(t.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

function renderBody(){
    const body = state.panel?.querySelector('.tripo-tasks-body');
    if(!body) return;
    if(state.loading){
        body.innerHTML = `<div class="tripo-tasks-empty">${esc(tl('smart.tripoTaskLoading', '加载中…'))}</div>`;
        return;
    }
    if(!state.tasks.length){
        body.innerHTML = `<div class="tripo-tasks-empty">${esc(tl('smart.tripoTaskEmpty', '暂无任务记录'))}</div>`;
        return;
    }
    body.innerHTML = state.tasks.map(t => {
        const status = t.status || 'queued';
        const pct = Math.max(0, Math.min(100, Number(t.progress || 0)));
        const label = KIND_LABELS[t.kind] || t.kind || '任务';
        const showBar = !TERMINAL.includes(status);
        const credits = Number(t.credits);
        const creditsText = (!showBar && Number.isFinite(credits) && credits > 0) ? `<span class="tripo-task-credits">-${credits} 点</span>` : '';
        return `<div class="tripo-task-item" data-task-id="${esc(t.task_id || '')}">
            <div class="tripo-task-row">
                <span class="tripo-task-kind">${esc(label)}</span>
                <span class="tripo-task-chip ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>
            </div>
            <div class="tripo-task-row">
                <span class="tripo-task-id" title="${esc(t.task_id || '')}">${esc(t.task_id || '')}</span>
            </div>
            ${showBar ? `<div class="tripo-task-bar"><i style="width:${pct}%"></i></div>` : ''}
            <div class="tripo-task-meta">
                <span>${esc(taskTime(t.created_at))}</span>
                ${showBar ? `<span>${pct}%</span>` : creditsText}
            </div>
        </div>`;
    }).join('');
    renderSub();
}

function renderSub(){
    const sub = state.panel?.querySelector('.tripo-tasks-sub');
    if(!sub) return;
    const total = state.tasks.reduce((sum, t) => sum + (Number(t.credits) > 0 ? Number(t.credits) : 0), 0);
    sub.textContent = total > 0
        ? `${state.tasks.length} 个任务 · 累计消耗 ${total} 点`
        : `${state.tasks.length} 个任务`;
}

function updateBadge(){
    if(!state.badge) return;
    const count = state.tasks.filter(t => !TERMINAL.includes(t.status)).length;
    state.badge.hidden = count === 0;
    state.badge.textContent = count > 99 ? '99+' : String(count);
}

async function fetchTasks(sync){
    state.loading = true;
    renderBody();
    try {
        if(sync){
            const pending = state.tasks.filter(t => !TERMINAL.includes(t.status)).map(t => t.task_id).slice(0, 50);
            if(pending.length){
                try { await fetch('/api/tripo/tasks/query', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_ids:pending})}); }
                catch(e){ /* 上游同步失败不阻塞本地档案展示 */ }
            }
        }
        const res = await fetch('/api/tripo/tasks?limit=200');
        const data = await res.json().catch(() => null);
        state.tasks = (data && data.tasks) || [];
    } catch(e){
        state.tasks = [];
    } finally {
        state.loading = false;
        renderBody();
        updateBadge();
    }
}

function toggle(open){
    if(!state.panel || !state.btn) return;
    const willOpen = open !== undefined ? open : !state.panel.classList.contains('open');
    state.panel.classList.toggle('open', willOpen);
    state.btn.classList.toggle('active', willOpen);
    if(willOpen) fetchTasks(false);
}

function buildPanel(mountTo, topOffset){
    const panel = document.createElement('aside');
    panel.className = 'tripo-tasks-panel';
    panel.setAttribute('aria-label', 'Tripo 任务中心');
    if(topOffset) panel.style.top = `${topOffset}px`;
    panel.innerHTML = `
        <div class="tripo-tasks-head">
            <div>
                <div class="tripo-tasks-title">${esc(tl('smart.tripoTaskCenter', 'Tripo 任务中心'))}</div>
                <div class="tripo-tasks-sub"></div>
            </div>
            <div class="tripo-tasks-actions">
                <button class="tripo-tasks-mini" data-tasks-refresh type="button" title="${esc(tl('smart.tripoTaskRefresh', '刷新（向 Tripo 同步进行中任务状态）'))}"><i data-lucide="refresh-cw"></i></button>
                <button class="tripo-tasks-mini" data-tasks-close type="button" title="关闭" aria-label="关闭任务中心"><i data-lucide="x"></i></button>
            </div>
        </div>
        <div class="tripo-tasks-body"></div>`;
    (mountTo || document.body).appendChild(panel);
    ['pointerdown','mousedown','click','dblclick','wheel','contextmenu'].forEach(type => panel.addEventListener(type, e => e.stopPropagation()));
    panel.querySelector('[data-tasks-refresh]').onclick = e => { e.stopPropagation(); fetchTasks(true); };
    panel.querySelector('[data-tasks-close]').onclick = e => { e.stopPropagation(); toggle(false); };
    window.lucide?.createIcons({root:panel});
    return panel;
}

function init(opts = {}){
    if(state.inited) return;
    const btn = typeof opts.button === 'string' ? document.querySelector(opts.button) : opts.button;
    if(!btn) return;
    const mountTo = typeof opts.mountTo === 'string' ? document.querySelector(opts.mountTo) : opts.mountTo;
    state.btn = btn;
    state.panel = buildPanel(mountTo, opts.topOffset);
    /* 徽章注入按钮（按钮自身样式由各画布定义） */
    state.badge = document.createElement('em');
    state.badge.className = 'tripo-tasks-badge';
    state.badge.hidden = true;
    btn.appendChild(state.badge);
    btn.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    /* WS 进度实时刷新：更新缓存并按需重绘（抽屉开着才重绘列表，徽章总是更新） */
    window.addEventListener('tripo-task-progress', ev => {
        const d = ev.detail || {};
        const hit = state.tasks.find(t => t.task_id === d.task_id);
        if(!hit) return;
        if(d.status) hit.status = d.status;
        hit.progress = Number(d.progress || 0);
        updateBadge();
        if(state.panel.classList.contains('open')) renderBody();
    });
    /* 首次静默拉取：徽章初始就有数（抽屉未开不渲染列表） */
    fetchTasks(false);
    state.inited = true;
}

/* 样式只注一次 */
if(typeof document !== 'undefined' && !document.getElementById('tripo-tasks-style')){
    const style = document.createElement('style');
    style.id = 'tripo-tasks-style';
    style.textContent = CSS;
    document.head.appendChild(style);
}

window.TripoTaskCenter = {init, refresh: fetchTasks, toggle};
})();
