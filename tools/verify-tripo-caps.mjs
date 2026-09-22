// 回归验证：能力卡（capability-actions.js）——元数据驱动的「减面 / 导出转换」卡在双画布渲染与交互。
// 隔离浏览器：非 GET 一律拦截（点「执行」只会走前端报错分支，不产生真实任务/扣点）。
// 用法：服务跑在 38080，node tools/verify-tripo-caps.mjs
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9257;
const APP = process.env.APP_BASE || 'http://127.0.0.1:38080';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn(EDGE, ['--headless=new', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${ROOT}/.workbuddy/tmp/tripo-caps-verify-${Date.now()}`, 'about:blank'], {stdio:'ignore'});

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
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(method + ' ' + url); return Promise.reject(new Error('TEST blocked write')); }
            return nativeFetch(input, opts);
        };
        localStorage.setItem('studio-theme', 'dark');
    `});

    /* ========== 智能画布：设置面板里的能力卡 ========== */
    await send('Page.navigate', {url: `${APP}/static/smart-canvas.html`});
    for (let i = 0; i < 90; i++) {
        if (await evalJS(`typeof createTripoNode === 'function' && !!window.TripoActions && !!window.TripoAPI && document.readyState === 'complete'`)) break;
        await sleep(200);
    }
    await evalJS(`document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark');
        scheduleSave = () => {}; addSmartGenerationLog = () => {}; window.TripoUI.refreshBalance = () => {};
        nodes = []; selectedIds = []; viewport = {x:0,y:0,scale:1};
        window.testNode = createTripoNode(60, 120, {skipUndo:true});
        window.testNode.tripoResult = {taskId:'caps-verify-task', model:'/output/tripo/_verify_sample.glb', preview:'', remoteModel:'', credits:0};
        selectedIds = [window.testNode.id];
        render();`);
    for (let i = 0; i < 40; i++) { if (await evalJS(`!!document.querySelector('[data-wb-cards="mesh"] .tca-card')`)) break; await sleep(200); }
    /* 工作台 4-Tab：切到「加工」验证（Tab 切换只切 class，卡片挂载一次） */
    await evalJS(`document.querySelector('[data-wb-tab="mesh"]').click()`);
    await sleep(200);

    await check('能力元数据端点可达且缓存', `(async () => { const r = await fetch('/api/tripo/capabilities'); const d = await r.json();
        return d.capabilities.length >= 15 && d.capabilities.some(c => c.id === 'decimate'); })()`);
    await check('工作台渲染 4 个 Tab（生成/加工/动画/导出）', `(() => { const tabs = [...document.querySelectorAll('.tripo-wb-tabs [data-wb-tab]')].map(b => b.dataset.wbTab);
        return tabs.join(',') === 'generate,mesh,rig,export'
            && document.querySelector('[data-wb-tab="mesh"]').classList.contains('active')
            && document.querySelector('[data-wb-pane="mesh"]').classList.contains('active')
            && !document.querySelector('[data-wb-pane="generate"]').classList.contains('active'); })()`);
    await check('能力卡按 Tab 分组渲染（加工 5 / 动画 3 / 导出 1，refine 已下架）', `(() => {
        const mesh = [...document.querySelectorAll('[data-wb-cards="mesh"] .tca-card')].map(c => c.dataset.cap);
        const rig = [...document.querySelectorAll('[data-wb-cards="rig"] .tca-card')].map(c => c.dataset.cap);
        const exp = [...document.querySelectorAll('[data-wb-cards="export"] .tca-card')].map(c => c.dataset.cap);
        return mesh.length === 5 && ['texture','decimate','segment','complete','stylize'].every(id => mesh.includes(id)) && !mesh.includes('refine')
            && rig.join(',') === 'rig_check,rig,retarget' && exp.join(',') === 'convert'; })()`);
    await check('生图辅助（image 组）不混入能力 Tab', `![...document.querySelectorAll('[data-wb-cards] .tca-card')].some(c => ['text_to_image','image_to_image','image_to_multiview','edit_multiview','import_model'].includes(c.dataset.cap))`);
    await check('有产物时能力 Tab 无占位提示', `!document.querySelector('.tripo-wb-needs')`);

    /* 展开 + 参数表单 */
    await evalJS(`document.querySelector('.tca-card[data-cap="decimate"] [data-tca-toggle]').click()`);
    await sleep(150);
    await check('减面卡展开且 4 个参数渲染', `(() => { const card = document.querySelector('.tca-card[data-cap="decimate"]');
        return card.classList.contains('open') && card.querySelectorAll('[data-cap-field]').length === 4
            && !!card.querySelector('[data-cap-field="face_limit"]') && !!card.querySelector('[data-cap-field="quad"]'); })()`);
    await check('默认值正确（face_limit=-1 / bake=true）', `(() => { const card = document.querySelector('.tca-card[data-cap="decimate"]');
        return card.querySelector('[data-cap-field="face_limit"]').value === '-1' && card.querySelector('[data-cap-field="bake"]').checked === true; })()`);

    /* 展开状态在重绘后保留（进度刷新会重挂卡） */
    await evalJS(`window.testNode.tripoProgress = 42; render();`);
    await sleep(400);
    await check('重绘后展开状态与草稿保留', `(() => { const card = document.querySelector('.tca-card[data-cap="decimate"]');
        return card && card.classList.contains('open') && !!card.querySelector('[data-cap-field="face_limit"]'); })()`);

    /* 草稿：改 face_limit 后重绘保留 */
    await evalJS(`document.querySelector('.tca-card[data-cap="decimate"] [data-cap-field="face_limit"]').value = '8000';
        document.querySelector('.tca-card[data-cap="decimate"] [data-cap-field="face_limit"]').dispatchEvent(new Event('change'));
        render();`);
    await sleep(400);
    await check('参数草稿跨重绘保留（8000）', `document.querySelector('.tca-card[data-cap="decimate"] [data-cap-field="face_limit"]').value === '8000'`);

    /* 导出卡：18 参数 + 分组表单 */
    await evalJS(`document.querySelector('.tca-card[data-cap="convert"] [data-tca-toggle]').click()`);
    await sleep(150);
    await check('导出卡 18 个参数全部渲染', `document.querySelectorAll('.tca-card[data-cap="convert"] [data-cap-field]').length === 18`);
    await check('导出枚举项正确（FBX 预设/贴图格式/朝向）', `(() => { const card = document.querySelector('.tca-card[data-cap="convert"]');
        return [...card.querySelector('[data-cap-field="fbx_preset"]').options].map(o => o.value).join(',') === 'blender,mixamo,3dsmax'
            && [...card.querySelector('[data-cap-field="export_orientation"]').options].map(o => o.value).join(',') === '+x,-x,+y,-y'; })()`);

    /* 新卡：拆件/补洞/绑骨链/风格化 */
    await check('拆件卡无参数（REST 契约仅 input+model，粒度/连通性是 ComfyUI 参数面）', `(() => { const card = document.querySelector('.tca-card[data-cap="segment"]');
        return card && card.querySelectorAll('[data-cap-field]').length === 0; })()`);
    await check('补洞卡提示需先拆件', `(() => { const card = document.querySelector('.tca-card[data-cap="complete"]');
        return card && card.querySelector('.tca-desc').textContent.includes('先对模型跑拆件'); })()`);
    await check('绑骨卡参数齐全（骨骼类型含空默认/引擎 v2.5/规格/格式）', `(() => { const card = document.querySelector('.tca-card[data-cap="rig"]');
        const rt = card.querySelector('[data-cap-field="rig_type"]');
        return rt.value === '' && card.querySelector('[data-cap-field="model"]').value === 'v2.5-20260210'
            && card.querySelector('[data-cap-field="spec"]').value === 'tripo'
            && card.querySelector('[data-cap-field="out_format"]').value === 'glb'; })()`);
    await check('重定向卡默认 walk + 烘焙开', `(() => { const card = document.querySelector('.tca-card[data-cap="retarget"]');
        return card.querySelector('[data-cap-field="animation"]').value === 'preset:walk'
            && card.querySelector('[data-cap-field="bake_animation"]').checked === true; })()`);
    await check('风格化卡四风格枚举', `(() => { const opts = [...document.querySelector('.tca-card[data-cap="stylize"] [data-cap-field="style"]').options].map(o => o.value);
        return opts.join(',') === 'lego,voxel,voronoi,minecraft'; })()`);
    await check('绑骨检测显示免费标签', `document.querySelector('.tca-card[data-cap="rig_check"] .tca-cost').textContent === '免费'`);

    /* 绑骨检测（info 型输出）：桩掉 fetch 提交与轮询，验证「显示结论、不替换产物」 */
    await evalJS(`document.querySelector('[data-wb-tab="rig"]').click(); document.querySelector('.tca-card[data-cap="rig_check"] [data-tca-toggle]').click()`);
    await evalJS(`(() => {
        const native = window.fetch.bind(window);
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            if (url.includes('/api/tripo/capabilities/rig_check')) {
                return Promise.resolve(new Response(JSON.stringify({success:true, task_id:'rig-check-stub'}), {status:200, headers:{'Content-Type':'application/json'}}));
            }
            return native(input, opts);
        };
        window.__rigCheckCalls = [];
        window.TripoAPI.pollTask = async (id, onProgress) => { window.__rigCheckCalls.push(id);
            const t = {status:'success', progress:100, task_id:id, output:{riggable:true, rig_type:'biped'}};
            onProgress && onProgress(t); return t; };
        return true;
    })()`);
    await evalJS(`document.querySelector('.tca-card[data-cap="rig_check"] [data-tca-run]').click()`);
    await sleep(500);
    await check('绑骨检测：提交到统一端点且轮询一次', `window.__rigCheckCalls.length === 1 && window.__rigCheckCalls[0] === 'rig-check-stub'`);
    await check('绑骨检测：展示结论（可绑骨·biped）', `(() => { const info = document.querySelector('.tca-card[data-cap="rig_check"] .tca-info');
        return info && info.textContent.includes('可绑骨：是') && info.textContent.includes('biped'); })()`);
    await check('绑骨检测：不替换节点产物', `window.testNode.tripoResult.taskId === 'caps-verify-task'
        && window.testNode.tripoResult.model === '/output/tripo/_verify_sample.glb'`);
    await evalJS(`window.TripoAPI.pollTask = (id, onProgress, interval, shouldStop) => (async () => { while(true){ await new Promise(r=>setTimeout(r,interval||2500));
        if(shouldStop && shouldStop()) { const e = new Error('已停止等待'); e.code='stopped'; throw e; }
        const data = await window.fetch('/api/tripo/task/' + id).then(r=>r.json()); const task = data.task||{};
        try{ onProgress && onProgress(task); }catch(e){}
        if(task.status==='success') return task; if(task.status==='failed') throw new Error(task.error||'failed'); } })();`);

    /* 执行按钮：写请求被拦截 → 前端报错分支（不产生真实任务）；Tab 状态跨重绘保留 */
    await evalJS(`document.querySelector('[data-wb-tab="mesh"]').click()`);
    await sleep(150);
    await evalJS(`document.querySelector('.tca-card[data-cap="decimate"] [data-tca-run]').click()`);
    await sleep(600);
    await check('执行被拦截后进入报错分支（无真实任务）', `(() => { const err = window.testNode.tripoError || '';
        return err.includes('blocked') && window.testNode.running === false; })()`);
    await check('Tab 状态跨重绘保留（仍在加工页）', `document.querySelector('[data-wb-pane="mesh"]').classList.contains('active')`);
    await check('拦截记录指向统一提交端点', `window.__blockedWrites.length === 1
        && window.__blockedWrites[0].includes('POST') && window.__blockedWrites[0].includes('/api/tripo/capabilities/decimate')`);

    /* running 状态下按钮禁用 */
    await evalJS(`window.testNode.running = true; window.testNode.tripoError = ''; render();`);
    await sleep(400);
    await check('任务进行中执行钮禁用', `document.querySelector('.tca-card[data-cap="decimate"] [data-tca-run]').disabled === true`);
    await evalJS(`window.testNode.running = false; render();`);

    /* ========== 经典画布：节点内的能力卡 ========== */
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        window.__fakeCaps = {id:'caps-verify-classic-20260923', title:'能力卡验证（内存假画布）', kind:'classic', project:'default',
          nodes:[{id:'tripo-caps-1', type:'tripo', x:220, y:160, tripoMode:'image', tripoModelVersion:'v3.1-20260211',
            tripoTexture:true, tripoPbr:true, tripoQuad:false, tripoOrtho:true, tripoTextureQuality:'standard',
            tripoGeometryQuality:'standard', tripoSmartLowPoly:false, tripoGenerateParts:false, tripoAutofix:false,
            tripoFaceLimit:'', tripoPrompt:'', tripoViews:{front:'',back:'',left:'',right:''}, tripoTaskId:'',
            tripoTaskStatus:'', tripoProgress:0,
            tripoResult:{taskId:'caps-classic-task', model:'/output/tripo/_verify_sample.glb', preview:'', remoteModel:'', credits:0},
            tripoHistory:[], tripoStopped:false, tripoModelPanelOpen:false, inputs:[], running:false}],
          connections:[], viewport:{x:0,y:0,scale:1}, logs:[], updated_at:1789113000000};
        const origFetch3 = window.fetch.bind(window);
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            if (url.includes('caps-verify-classic')) {
                const body = method === 'GET' ? {canvas:window.__fakeCaps} : {ok:true, updated_at:window.__fakeCaps.updated_at};
                return Promise.resolve(new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}}));
            }
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(method + ' ' + url); return Promise.reject(new Error('TEST blocked write')); }
            return origFetch3(input, opts);
        };
    `});
    await send('Page.navigate', {url: `${APP}/static/canvas.html?id=caps-verify-classic-20260923`});
    await sleep(7000);
    for (let i = 0; i < 40; i++) { if (await evalJS(`!!document.querySelector('.tripo-caps-mount .tca-card')`)) break; await sleep(300); }
    await check('经典画布：节点内渲染 7 张能力卡（refine 已下架）', `(() => { const cards = [...document.querySelectorAll('.tripo-caps-mount .tca-card')].map(c => c.dataset.cap);
        return ['decimate','segment','complete','rig_check','rig','retarget','stylize','convert'].every(id => cards.includes(id)) && !cards.includes('refine'); })()`);
    await evalJS(`document.querySelector('.tripo-caps-mount .tca-card[data-cap="decimate"] [data-tca-toggle]').click()`);
    await sleep(150);
    await check('经典画布：减面卡可展开', `document.querySelector('.tripo-caps-mount .tca-card[data-cap="decimate"]').classList.contains('open')`);

    /* 副作用：经典画布阶段未产生任何写请求（导航后计数从零开始） */
    const writes = await evalJS(`window.__blockedWrites.length`);
    if (writes !== 0) throw Error(`经典画布阶段不应有写请求，实际 ${await evalJS('JSON.stringify(window.__blockedWrites)')}`);
    const realErrors = errors.filter(e => !/blocked write|Failed to load resource/i.test(e));
    if (realErrors.length) throw Error(`页面 JS 异常: ${realErrors.join(' | ')}`);
    console.log('PASS 经典画布阶段零写请求、无页面异常');

    console.log(`\nRESULT ok=${checks.length + 1}`);
} catch (err) {
    console.log('\nRESULT FAIL:', err.message);
    process.exitCode = 1;
} finally {
    try { ws?.close(); } catch {}
    try { browser.kill(); } catch {}
}
