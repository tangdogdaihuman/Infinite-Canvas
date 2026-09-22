/* Tripo 能力卡渲染器（双画布共用，元数据驱动）。
 * 从 GET /api/tripo/capabilities 拉取能力声明，按 ParamSpec 自动生成参数表单。
 * 新能力上线只需后端注册表加一行，前端零改动。
 *
 * 宿主契约：TripoActions.mount(container, host, opts)
 *   host.taskId()      → 原始任务 id（上游模型任务的 task_id）
 *   host.node          → 画布节点（读写 running/tripoTaskStatus/tripoProgress/tripoError）
 *   host.refresh()     → 重绘并保存（各画布自己的 render/refreshNodes + scheduleSave）
 *   host.onResult(capId, result)  → 加工类完成（结果替换节点产物并进历史）
 *   host.onDownload(capId, result)→ 导出类完成（触发浏览器下载）
 *   host.onImageResult(capId, result) → 生图类完成（result.image，画布落成图片节点）
 *   host.inputImage()  → 生图类输入图（本地路径/data URL 会先上传换 file_token）
 *   opts.ids           → 只渲染这些能力（默认 8 卡加工组）
 */
(function(){
'use strict';

const CSS = `
.tca-wrap{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.tca-card{border:1px solid #2a313d;border-radius:10px;background:#171b22;overflow:hidden}
.tca-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;
  color:#cfd6e0;padding:9px 12px;font-size:12.5px;cursor:pointer;text-align:left}
.tca-head:hover{background:#1c222b}
.tca-name{font-weight:600;flex:1}
.tca-cost{font-size:11px;color:#7fe0bc;background:#1e3a33;border-radius:999px;padding:1px 8px;white-space:nowrap}
.tca-caret{color:#5f6b7d;font-size:11px;transition:transform .15s}
.tca-card.open .tca-caret{transform:rotate(180deg)}
.tca-body{padding:0 12px 12px;display:none}
.tca-card.open .tca-body{display:block}
.tca-desc{font-size:11.5px;color:#5f6b7d;margin:2px 0 10px;line-height:1.5}
.tca-info{font-size:12px;color:#7fe0bc;background:#1e3a33;border:1px solid #2fc98f44;border-radius:8px;
  padding:6px 10px;margin:0 0 10px;line-height:1.5}
.tca-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-bottom:10px}
.tca-field{display:flex;flex-direction:column;gap:4px}
.tca-field.wide{grid-column:1 / -1}
.tca-label{font-size:11.5px;color:#93a0b4}
.tca-hint{font-size:10.5px;color:#5f6b7d}
.tca-input,.tca-select{background:#10141a;border:1px solid #2a313d;border-radius:7px;color:#e6eaf0;
  padding:5px 8px;font-size:12px;outline:none;width:100%}
.tca-input:focus,.tca-select:focus{border-color:#2fc98f66}
.tca-check{display:flex;align-items:center;gap:7px;font-size:12px;color:#cfd6e0;cursor:pointer;padding-top:18px}
.tca-check input{accent-color:#2fc98f;width:14px;height:14px}
.tca-run{width:100%;border:none;border-radius:8px;background:#2fc98f;color:#0c1210;font-weight:600;
  font-size:12.5px;padding:8px 0;cursor:pointer}
.tca-run:hover{background:#3bdda3}
.tca-run:disabled{background:#2a313d;color:#5f6b7d;cursor:not-allowed}
.tca-empty{font-size:12px;color:#5f6b7d;padding:4px 0}
/* 生图辅助折叠区（经典画布没有 .tripo-options 样式，这里自带一份通用样式） */
details.tripo-imgassist{border:1px solid #2a313d;border-radius:10px;background:#171b22;margin:8px 0;overflow:hidden}
details.tripo-imgassist>summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;
  color:#cfd6e0;font-size:12.5px;list-style:none;font-weight:600}
details.tripo-imgassist>summary::-webkit-details-marker{display:none}
details.tripo-imgassist>summary::marker{content:""}
details.tripo-imgassist>summary::after{content:"▾";color:#5f6b7d;font-size:11px;margin-left:auto;transition:transform .15s}
details.tripo-imgassist[open]>summary::after{transform:rotate(180deg)}
details.tripo-imgassist .tripo-imgassist-mount{padding:0 12px 12px}
`;

let capsCache = null;
function loadCaps(){
    if(!capsCache){
        capsCache = fetch('/api/tripo/capabilities')
            .then(r => r.json())
            .then(d => (d && d.capabilities) || [])
            .catch(() => []);
    }
    return capsCache;
}

/* 每个节点的草稿与展开状态（节点对象做键，重绘后恢复，不写节点 schema） */
const drafts = new WeakMap();
const openState = new WeakMap();
const draftFor = node => { let d = drafts.get(node); if(!d){ d = {}; drafts.set(node, d); } return d; };
const openFor = node => { let s = openState.get(node); if(!s){ s = new Set(); openState.set(node, s); } return s; };
/* HTML 属性值转义：草稿值会回填进 value="..."，防引号破属性注入 */
const escAttr = str => String(str == null ? '' : str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));

function fieldHtml(p, value){
    const v = value !== undefined ? value : p.default;
    const hint = p.hint ? `<div class="tca-hint">${escAttr(p.hint)}</div>` : '';
    if(p.type === 'bool'){
        return `<label class="tca-check" data-field="${p.name}">
            <input type="checkbox" data-cap-field="${p.name}" ${v ? 'checked' : ''}>
            <span>${escAttr(p.label)}</span>${hint ? '' : ''}</label>`;
    }
    if(p.type === 'enum'){
        const opts = (p.options || []).map(o => `<option value="${escAttr(o)}" ${o === v ? 'selected' : ''}>${escAttr(o)}</option>`).join('');
        return `<div class="tca-field" data-field="${p.name}"><span class="tca-label">${escAttr(p.label)}</span>
            <select class="tca-select" data-cap-field="${p.name}">${opts}</select>${hint}</div>`;
    }
    if(p.type === 'int' || p.type === 'float'){
        const step = p.type === 'int' ? '1' : 'any';
        const attrs = `${p.min !== null && p.min !== undefined ? `min="${p.min}"` : ''} ${p.max !== null && p.max !== undefined ? `max="${p.max}"` : ''}`;
        return `<div class="tca-field" data-field="${p.name}"><span class="tca-label">${escAttr(p.label)}</span>
            <input class="tca-input" type="number" step="${step}" ${attrs} data-cap-field="${p.name}" value="${escAttr(v ?? '')}">${hint}</div>`;
    }
    /* str / list：单行文本，list 用逗号分隔 */
    const ph = p.type === 'list' ? (p.hint || '逗号分隔') : (p.hint || '');
    return `<div class="tca-field wide" data-field="${p.name}"><span class="tca-label">${escAttr(p.label)}</span>
        <input class="tca-input" type="text" data-cap-field="${p.name}" value="${escAttr(v ?? '')}" placeholder="${escAttr(ph)}"></div>`;
}

function collectParams(cardEl, cap){
    const params = {};
    cardEl.querySelectorAll('[data-cap-field]').forEach(el => {
        const name = el.dataset.capField;
        const spec = (cap.params || []).find(p => p.name === name);
        if(!spec) return;
        if(spec.type === 'bool'){ params[name] = el.checked; return; }
        const raw = (el.value ?? '').toString().trim();
        if(raw === '') return;
        params[name] = raw;
    });
    return params;
}

function cardHtml(cap, draft, isOpen, busy, infoText){
    const fields = (cap.params || []).map(p => fieldHtml(p, draft[p.name])).join('');
    const cost = cap.cost === 0 ? '免费' : `约 ${cap.cost} 点`;
    const info = infoText ? `<div class="tca-info">${escAttr(infoText)}</div>` : '';
    return `<div class="tca-card ${isOpen ? 'open' : ''}" data-cap="${escAttr(cap.id)}">
        <button class="tca-head" type="button" data-tca-toggle>
            <span class="tca-name">${escAttr(cap.label)}</span>
            <span class="tca-cost">${escAttr(cost)}</span>
            <span class="tca-caret">▾</span>
        </button>
        <div class="tca-body">
            ${cap.desc ? `<div class="tca-desc">${escAttr(cap.desc)}</div>` : ''}
            ${info}
            ${fields ? `<div class="tca-fields">${fields}</div>` : ''}
            <button class="tca-run" type="button" data-tca-run ${busy ? 'disabled' : ''}>${busy ? '任务进行中…' : '执行'}</button>
        </div>
    </div>`;
}

/* WS 进度推送（type=tripo_task，smart-canvas 转发成 tripo-task-progress 事件）。
 * 只做进度条平滑，不改变完成判定——pollTask 轮询始终是唯一事实源。 */
const PROGRESS_EVENT = 'tripo-task-progress';

function bindProgressListener(node, host){
    const handler = ev => {
        const d = ev.detail || {};
        if(d.task_id !== node.tripoWatchTaskId) return;
        if(d.status) node.tripoTaskStatus = d.status;
        node.tripoProgress = Math.max(0, Math.min(100, Number(d.progress || 0)));
        host.refresh();
    };
    window.addEventListener(PROGRESS_EVENT, handler);
    return () => window.removeEventListener(PROGRESS_EVENT, handler);
}

async function runCapability(cap, cardEl, host){
    const node = host.node;
    if(node.running) return;
    const params = collectParams(cardEl, cap);
    draftFor(node)[cap.id] = {...draftFor(node)[cap.id], ...params};
    /* 按输入形态组装请求体：model_task 用原始任务 id；image 用输入图（本地路径先转 file_token）；none 仅 prompt */
    let inputRef = '';
    if((cap.input_kind || 'model_task') === 'model_task'){
        inputRef = host.taskId();
        if(!inputRef){ node.tripoError = '请先生成 3D 模型'; host.refresh(); return; }
    } else if(cap.input_kind === 'image'){
        inputRef = (host.inputImage && host.inputImage()) || '';
        if(!inputRef){ node.tripoError = '缺少输入图片（请先上传或连线输入图片）'; host.refresh(); return; }
    } else if(!String(params.prompt || '').trim()){
        node.tripoError = '缺少提示词';
        host.refresh();
        return;
    }
    node.running = true;
    node.tripoError = '';
    node.tripoTaskStatus = 'queued';
    node.tripoProgress = 0;
    host.refresh();
    let unbindProgress = null;
    try {
        if(cap.input_kind === 'image' && /^(\/|data:|blob:)/.test(inputRef)){
            /* 本地相对路径 / data URL 上游取不到，先上传换成 file_token */
            const up = await window.TripoAPI.uploadImage(inputRef);
            inputRef = up.token;
        }
        const payload = cap.input_kind === 'model_task'
            ? {original_task_id: inputRef, ...params}
            : cap.input_kind === 'image'
            ? {input: inputRef, ...params}
            : {...params};
        const res = await fetch(`/api/tripo/capabilities/${cap.id}`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => null);
        if(!res.ok) throw new Error((data && data.detail) || `${res.status} ${res.statusText}`);
        /* WS 推进度（5s 一跳），pollTask（2.5s 一跳）兜底；两者都写同一份节点状态 */
        node.tripoWatchTaskId = data.task_id;
        unbindProgress = bindProgressListener(node, host);
        const task = await window.TripoAPI.pollTask(data.task_id, t => {
            node.tripoTaskStatus = t.status || '';
            node.tripoProgress = Number(t.progress || 0);
            host.refresh();
        }, 2500);
        if(cap.output === 'info'){
            /* 判定类（绑骨检测）：展示结论，不替换节点产物 */
            const out = task.output || {};
            const ok = out.riggable === true || out.riggable === 'true';
            const parts = [`可绑骨：${ok ? '是' : '否'}`];
            if(out.rig_type) parts.push(`建议骨骼：${out.rig_type}`);
            draftFor(node)['__info_' + cap.id] = parts.join(' · ');
            host.refresh();
            if(window.toast) window.toast(parts.join(' · '));
        } else if(cap.group === 'image'){
            /* 生图类：产物是图片（task.output.generated_image），落成画布图片节点而非模型历史 */
            const remote = task.output?.generated_image || '';
            if(!remote) throw new Error('Tripo 未返回生成图片');
            let image = remote;
            try { image = (await window.TripoAPI.download(remote, 'image', cap.id)).url; } catch(e){}
            const result = {taskId: task.task_id || '', image, name:`tripo_${cap.id}_${task.task_id || ''}`};
            host.onImageResult?.(cap.id, result);
        } else {
            const result = await window.TripoAPI.finalizeOutputs(task);
            result.capability = cap.id;
            if(cap.group === 'export') host.onDownload?.(cap.id, result);
            else host.onResult?.(cap.id, result);
        }
    } catch(err){
        node.tripoError = err?.message || String(err);
        if(window.toast) window.toast(node.tripoError);
    } finally {
        if(unbindProgress) unbindProgress();
        node.tripoWatchTaskId = '';
        node.running = false;
        node.tripoTaskStatus = '';
        host.refresh();
    }
}

async function mount(container, host, opts={}){
    if(!container || !host?.node) return;
    /* 默认渲染：网格全家桶 + 绑骨动画链 + 导出。refine 已下架（legacy 端点仅吃旧版草稿任务，
     * 当前模型阵容 H3.1/P2/P1 直出成品，提交必被上游拒——见 capabilities.py 注释）。
     * 生图辅助（image 组）在生成 Tab 的「生图辅助」区另行挂载 */
    const ids = opts.ids || ['decimate', 'segment', 'complete', 'rig_check', 'rig', 'retarget', 'stylize', 'convert'];
    const caps = (await loadCaps()).filter(c => ids.includes(c.id) && c.enabled !== false);
    if(!container.isConnected) return;
    if(!caps.length){ container.innerHTML = `<div class="tca-empty">能力列表加载失败</div>`; return; }
    const draft = draftFor(host.node);
    const opens = openFor(host.node);
    const busy = Boolean(host.node.running);
    container.innerHTML = `<div class="tca-wrap">${caps.map(cap => cardHtml(cap, draft[cap.id] || {}, opens.has(cap.id), busy, draft['__info_' + cap.id])).join('')}</div>`;
    container.querySelectorAll('.tca-card').forEach(cardEl => {
        const cap = caps.find(c => c.id === cardEl.dataset.cap);
        if(!cap) return;
        cardEl.querySelector('[data-tca-toggle]').addEventListener('click', e => {
            e.stopPropagation();
            if(opens.has(cap.id)) opens.delete(cap.id); else opens.add(cap.id);
            cardEl.classList.toggle('open', opens.has(cap.id));
        });
        cardEl.querySelectorAll('[data-cap-field]').forEach(el => {
            el.addEventListener('change', () => { draftFor(host.node)[cap.id] = {...draftFor(host.node)[cap.id], ...collectParams(cardEl, cap)}; });
            el.addEventListener('pointerdown', e => e.stopPropagation());
            el.addEventListener('dblclick', e => e.stopPropagation());
        });
        cardEl.querySelector('[data-tca-run]').addEventListener('click', e => {
            e.stopPropagation();
            runCapability(cap, cardEl, host);
        });
    });
}

/* 样式只注一次 */
if(typeof document !== 'undefined' && !document.getElementById('tca-style')){
    const style = document.createElement('style');
    style.id = 'tca-style';
    style.textContent = CSS;
    document.head.appendChild(style);
}

window.TripoActions = {mount};
})();
