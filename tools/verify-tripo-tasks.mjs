// 回归验证：Tripo 任务中心（徽章+抽屉）+ 生图辅助（image 组折叠区）+ WS 进度事件消费。
// 隔离浏览器：非 GET 一律拦截（点「执行」只走前端报错分支，零真实任务/扣点）。
// GET /api/tripo/tasks 用内存假数据 mock（任务中心数据源），其余 GET 走真实服务。
// 用法：服务跑在 38080，node tools/verify-tripo-tasks.mjs
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9259;
const APP = process.env.APP_BASE || 'http://127.0.0.1:38080';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn(EDGE, ['--headless=new', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${ROOT}/.workbuddy/tmp/tripo-tasks-verify-${Date.now()}`, 'about:blank'], {stdio:'ignore'});

const checks = [];
let ws;
try {
    let target;
    for (let i = 0; i < 40; i++) {
        try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(p => p.type === 'page'); if (target) break; } catch {}
        await sleep(250);
    }
    if (!target) throw Error('No browser target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 1;
    const pending = new Map();
    const errors = [];
    const send = (method, params = {}) => new Promise((res, rej) => {
        const id = seq++;
        const timer = setTimeout(() => { pending.delete(id); rej(Error(`CDP timeout: ${method}`)); }, 30000);
        pending.set(id, m => { clearTimeout(timer); m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result); });
        ws.send(JSON.stringify({id, method, params}));
    });
    ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    const evalJS = async expression => {
        const r = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
        if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result?.value;
    };
    const check = async (name, expr) => {
        const val = await evalJS(expr);
        if (!val) throw Error(`${name}: ${JSON.stringify(val)}`);
        checks.push(name);
        console.log('PASS', name);
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', {cacheDisabled:true});
    await send('Emulation.setDeviceMetricsOverride', {width:1500, height:1050, deviceScaleFactor:1, mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        const nativeFetch = window.fetch.bind(window);
        window.__blockedWrites = [];
        /* 任务中心数据源 mock：一条进行中 + 一条已完成（GET only，POST /tasks/query 走拦截记录） */
        window.__fakeTripoTasks = {success:true, tasks:[
            {task_id:'task-running-001', kind:'image_to_model', status:'running', progress:45, created_at:1789113000000, updated_at:1789113000000},
            {task_id:'task-done-002', kind:'decimate', status:'success', progress:100, credits:60, created_at:1789020000000, updated_at:1789020000000}
        ]};
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            const isTasksGet = method === 'GET' && /\\/api\\/tripo\\/tasks(\\?|$)/.test(url);
            if (isTasksGet) return Promise.resolve(new Response(JSON.stringify(window.__fakeTripoTasks), {status:200, headers:{'Content-Type':'application/json'}}));
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(method + ' ' + url); return Promise.reject(new Error('TEST blocked write: ' + url)); }
            return nativeFetch(input, opts);
        };
        localStorage.setItem('studio-theme', 'dark');
    `});

    /* ========== 智能画布：任务中心 ========== */
    await send('Page.navigate', {url: `${APP}/static/smart-canvas.html`});
    for (let i = 0; i < 90; i++) {
        if (await evalJS(`typeof createTripoNode === 'function' && !!window.TripoActions && !!window.TripoAPI && document.readyState === 'complete'`)) break;
        await sleep(200);
    }
    await evalJS(`document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark');
        scheduleSave = () => {}; addSmartGenerationLog = () => {}; window.TripoUI.refreshBalance = () => {};
        nodes = []; selectedIds = []; viewport = {x:0,y:0,scale:1};
        window.testNode = createTripoNode(60, 120, {skipUndo:true});
        window.testNode.tripoResult = {taskId:'tasks-verify-task', model:'/output/tripo/_verify_sample.glb', preview:'', remoteModel:'', credits:0};
        selectedIds = [window.testNode.id];
        render();`);
    for (let i = 0; i < 40; i++) { if (await evalJS(`!!document.querySelector('[data-tripo-imgassist] .tca-card')`)) break; await sleep(200); }
    /* window.onload 异步链（loadConfig → loadAssetLibrary → TripoTaskCenter.init），徽章要等首轮拉取完成 */
    for (let i = 0; i < 40; i++) { if (await evalJS(`document.querySelector('#tripoTasksSmart .tripo-tasks-badge')?.textContent === '1'`)) break; await sleep(250); }

    const badgeSel = `#tripoTasksSmart .tripo-tasks-badge`;
    const panelSel = `.tripo-tasks-panel`;
    await check('任务中心徽章按钮渲染且初始计数为 1', `(() => { const b = document.querySelector('${badgeSel}');
        return b && !b.hidden && b.textContent === '1'; })()`);
    await evalJS(`document.getElementById('tripoTasksSmart').click()`);
    await sleep(300);
    await check('点击徽章打开任务中心抽屉', `document.querySelector('${panelSel}').classList.contains('open') && document.getElementById('tripoTasksSmart').classList.contains('active')`);
    await check('任务列表渲染 2 项（kind 标签 + 状态 chip）', `(() => {
        const items = [...document.querySelectorAll('${panelSel} .tripo-task-item')];
        const kinds = items.map(i => i.querySelector('.tripo-task-kind')?.textContent || '');
        const chips = items.map(i => i.querySelector('.tripo-task-chip')?.textContent || '');
        return items.length === 2 && kinds[0] === '单图建模' && chips[0] === '进行中' && chips[1] === '已完成'; })()`);
    await check('进行中任务显示 45% 进度条，已完成不显示', `(() => {
        const items = [...document.querySelectorAll('${panelSel} .tripo-task-item')];
        const runBar = items[0].querySelector('.tripo-task-bar i');
        return runBar && runBar.style.width === '45%' && !items[1].querySelector('.tripo-task-bar'); })()`);
    await check('任务 ID 与时间渲染', `(() => {
        const first = document.querySelector('${panelSel} .tripo-task-item');
        return first.querySelector('.tripo-task-id')?.textContent === 'task-running-001' && /\\d{2}-\\d{2} \\d{2}:\\d{2}/.test(first.querySelector('.tripo-task-meta span')?.textContent || ''); })()`);
    await check('完成项显示实际扣费（-60 点）', `document.querySelector('${panelSel} .tripo-task-item:last-child .tripo-task-credits')?.textContent === '-60 点'`);
    await check('头部显示任务数与累计消耗统计', `(() => { const sub = document.querySelector('${panelSel} .tripo-tasks-sub')?.textContent || '';
        return sub.includes('2 个任务') && sub.includes('累计消耗 60 点'); })()`);

    /* WS 进度事件（socket.onmessage 转发路径的下游消费端） */
    await evalJS(`window.dispatchEvent(new CustomEvent('tripo-task-progress', {detail:{task_id:'task-running-001', status:'running', progress:90}}))`);
    await sleep(200);
    await check('WS 进度事件实时推进进度条到 90%', `document.querySelector('${panelSel} .tripo-task-item .tripo-task-bar i').style.width === '90%'`);

    /* 刷新：向 Tripo 批量同步进行中任务（POST /tasks/query 被拦截并记录） */
    await evalJS(`document.querySelector('[data-tasks-refresh]').click()`);
    for (let i = 0; i < 20; i++) { if (await evalJS(`window.__blockedWrites.some(x => x.includes('/api/tripo/tasks/query'))`)) break; await sleep(200); }
    await check('刷新触发上游批量查询（统一端点 /tasks/query）', `window.__blockedWrites.some(x => x.startsWith('POST') && x.includes('/api/tripo/tasks/query'))`);

    await evalJS(`window.dispatchEvent(new CustomEvent('tripo-task-progress', {detail:{task_id:'task-running-001', status:'success', progress:100}}))`);
    await sleep(200);
    await check('WS 终态事件后徽章归零隐藏', `(() => { const b = document.querySelector('${badgeSel}');
        return b.hidden && !document.querySelector('${panelSel} .tripo-task-bar'); })()`);

    await evalJS(`document.querySelector('[data-tasks-close]').click()`);
    await sleep(200);
    await check('关闭按钮收起抽屉', `!document.querySelector('${panelSel}').classList.contains('open') && !document.getElementById('tripoTasksSmart').classList.contains('active')`);

    /* ========== 智能画布：生图辅助（image 组） ========== */
    await check('生成面板含「生图辅助」折叠区（通用设置上方）', `(() => { const body = document.querySelector('.smart-tripo-body');
        const assist = body.querySelector('details.tripo-imgassist');
        const common = [...body.querySelectorAll('.tripo-options-section')].find(s => s.textContent.includes('通用设置'));
        return assist && common && (assist.compareDocumentPosition(common) & Node.DOCUMENT_POSITION_FOLLOWING) > 0; })()`);
    await evalJS(`document.querySelector('details.tripo-imgassist').open = true; document.querySelector('details.tripo-imgassist').dispatchEvent(new Event('toggle'))`);
    await sleep(300);
    await check('生图辅助展开渲染两张卡（四视图 + 图生图）', `(() => { const cards = [...document.querySelectorAll('[data-tripo-imgassist] .tca-card')].map(c => c.dataset.cap);
        return cards.includes('image_to_multiview') && cards.includes('image_to_image') && cards.length === 2; })()`);
    await check('生图辅助卡标注约 20 点', `(() => { const card = document.querySelector('[data-tripo-imgassist] .tca-card[data-cap="image_to_multiview"]');
        return card && /约 20 点/.test(card.querySelector('.tca-cost').textContent); })()`);

    /* 无输入图：执行被前置校验拦截（不发请求） */
    const writesBefore = 0;
    await evalJS(`document.querySelector('[data-tripo-imgassist] .tca-card[data-cap="image_to_multiview"] [data-tca-toggle]').click()`);
    await sleep(150);
    await evalJS(`document.querySelector('[data-tripo-imgassist] .tca-card[data-cap="image_to_multiview"] [data-tca-run]').click()`);
    await sleep(300);
    await check('无输入图时执行被前置校验拦截', `(() => { const err = document.querySelector('.smart-tripo-panel .tripo-error');
        return err && err.textContent.includes('缺少输入图片') && !window.__blockedWrites.some(x => x.includes('/api/tripo/capabilities/')); })()`);

    /* data URL 输入：先上传换 file_token（POST /api/tripo/upload 被拦截记录） */
    await evalJS(`window.testNode.tripoViews = {front:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', back:'', left:'', right:''}; render();`);
    await sleep(400);
    await evalJS(`document.querySelector('[data-tripo-imgassist] .tca-card[data-cap="image_to_multiview"] [data-tca-run]').click()`);
    for (let i = 0; i < 20; i++) { if (await evalJS(`window.__blockedWrites.some(x => x.includes('/api/tripo/upload'))`)) break; await sleep(200); }
    await check('本地输入图先上传换 file_token（/api/tripo/upload）', `(() => { const up = window.__blockedWrites.some(x => x.startsWith('POST') && x.includes('/api/tripo/upload'));
        const err = document.querySelector('.smart-tripo-panel .tripo-error');
        return up && err && err.textContent.includes('blocked write'); })()`);
    await check('上传失败后节点退出运行态且无图片节点落画布', `(() => { return window.testNode.running === false && window.testNode.tripoTaskStatus === '' && nodes.length === 1; })()`);

    /* ========== 经典画布：生图辅助折叠区（内存假画布，同 smoke-classic-canvas 模式） ========== */
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        window.__fakeCanvas = {id:'tripo-imgassist-verify', title:'任务中心验证（内存假画布）', kind:'classic', project:'default',
            nodes:[{id:'tripo-img-1', type:'tripo', x:220, y:160, tripoMode:'image', tripoModelVersion:'P2-20260801',
                tripoTexture:true, tripoPbr:true, tripoQuad:true, tripoOrtho:true, tripoTextureQuality:'standard',
                tripoGeometryQuality:'standard', tripoSmartLowPoly:false, tripoGenerateParts:false, tripoAutofix:false,
                tripoFaceLimit:'', tripoPrompt:'', tripoViews:{front:'', back:'', left:'', right:''}, tripoTaskId:'',
                tripoTaskStatus:'', tripoProgress:0, tripoResult:null, tripoHistory:[], tripoStopped:false,
                tripoModelPanelOpen:false, inputs:[], running:false}],
            connections:[], viewport:{x:0, y:0, scale:1}, logs:[], updated_at:1789113000000};
        const prevFetch = window.fetch.bind(window);
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            if (url.includes('tripo-imgassist-verify')) {
                const body = method === 'GET' ? {canvas: window.__fakeCanvas} : {ok:true, updated_at: window.__fakeCanvas.updated_at};
                return Promise.resolve(new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}}));
            }
            return prevFetch(input, opts);
        };
    `});
    await send('Page.navigate', {url: `${APP}/static/canvas.html?id=tripo-imgassist-verify`});
    for (let i = 0; i < 40; i++) { if (await evalJS(`!!document.querySelector('.tripo-body')`)) break; await sleep(300); }
    await check('经典画布 Tripo 面板含生图辅助折叠区', `(() => { const body = document.querySelector('.tripo-body');
        return body && !!body.querySelector('details.tripo-imgassist'); })()`);
    await evalJS(`(() => { const d = document.querySelector('.tripo-body details.tripo-imgassist'); d.open = true; })()`);
    for (let i = 0; i < 30; i++) { if (await evalJS(`document.querySelectorAll('.tripo-body [data-tripo-imgassist] .tca-card').length === 2`)) break; await sleep(300); }
    await check('经典画布生图辅助渲染两张卡', `(() => { const cards = [...document.querySelectorAll('.tripo-body [data-tripo-imgassist] .tca-card')].map(c => c.dataset.cap);
        return cards.includes('image_to_multiview') && cards.includes('image_to_image') && cards.length === 2; })()`);

    /* ========== 经典画布：任务中心（共享组件同款） ========== */
    for (let i = 0; i < 40; i++) { if (await evalJS(`document.querySelector('#tripoTasksClassic .tripo-tasks-badge')?.textContent === '1'`)) break; await sleep(250); }
    await check('经典画布任务中心徽章渲染（进行中 1）', `(() => { const b = document.querySelector('#tripoTasksClassic .tripo-tasks-badge');
        return b && !b.hidden && b.textContent === '1'; })()`);
    await evalJS(`document.getElementById('tripoTasksClassic').click()`);
    await sleep(400);
    await check('经典画布任务中心抽屉打开并列出 2 项', `(() => { const p = document.querySelector('.tripo-tasks-panel');
        return p.classList.contains('open') && p.querySelectorAll('.tripo-task-item').length === 2; })()`);
    await evalJS(`document.querySelector('[data-tasks-close]').click()`);
    await sleep(200);

    /* 收尾断言 */
    await check('全程零真实写请求（拦截记录全部指向 Tripo 端点）', `(() => { return (window.__blockedWrites || []).every(x => x.includes('/api/tripo/')); })()`);
    if (errors.length) throw Error('页面异常：' + JSON.stringify(errors.slice(0, 5)));
    console.log('PAGE_ERRORS none');
    console.log(`RESULT ok=${checks.length}`);
} finally {
    if (ws) ws.close();
    browser.kill();
}
