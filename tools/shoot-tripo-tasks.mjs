// 截图：任务中心抽屉 + 生图辅助折叠区（智能画布 + 经典画布）。
// 数据全 mock（GET /api/tripo/tasks 假档案、假画布），零真实写。
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9265;
const OUT = ROOT + '/outputs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${ROOT}/.workbuddy/tmp/tripo-shots-${Date.now()}`, 'about:blank'], {stdio:'ignore'});
let ws;
try {
    fs.mkdirSync(OUT, {recursive:true});
    let target;
    for (let i = 0; i < 40; i++) { try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(p => p.type === 'page'); if (target) break; } catch {} await sleep(250); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 1; const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => { const id = seq++; const timer = setTimeout(() => { pending.delete(id); rej(Error('timeout')); }, 30000); pending.set(id, m => { clearTimeout(timer); m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result); }); ws.send(JSON.stringify({id, method, params})); });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const evalJS = async expression => { const r = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true}); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description); return r.result?.value; };
    const shot = async name => { const r = await send('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64')); console.log('SHOT', name); };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Network.setCacheDisabled', {cacheDisabled:true});
    await send('Emulation.setDeviceMetricsOverride', {width:1500, height:1050, deviceScaleFactor:1, mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        const nativeFetch = window.fetch.bind(window);
        window.__fakeTripoTasks = {success:true, tasks:[
            {task_id:'task-running-001', kind:'image_to_model', status:'running', progress:45, created_at:1789113000000, updated_at:1789113000000},
            {task_id:'task-done-002', kind:'decimate', status:'success', progress:100, credits:30, created_at:1789020000000, updated_at:1789020000000},
            {task_id:'task-done-003', kind:'retarget', status:'success', progress:100, credits:10, created_at:1789000000000, updated_at:1789000000000}
        ]};
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            const isTasksGet = method === 'GET' && /\\/api\\/tripo\\/tasks(\\?|$)/.test(url);
            if (isTasksGet) return Promise.resolve(new Response(JSON.stringify(window.__fakeTripoTasks), {status:200, headers:{'Content-Type':'application/json'}}));
            return nativeFetch(input, opts);
        };
        localStorage.setItem('studio-theme', 'dark');
    `});

    /* 智能画布：任务中心 + 生图辅助 */
    await send('Page.navigate', {url: 'http://127.0.0.1:38080/static/smart-canvas.html'});
    for (let i = 0; i < 90; i++) { if (await evalJS(`typeof createTripoNode === 'function' && !!window.TripoActions && document.readyState === 'complete'`)) break; await sleep(200); }
    for (let i = 0; i < 40; i++) { if (await evalJS(`(window.tripoTasksState?.tasks?.length || 0) === 3`)) break; await sleep(250); }
    await evalJS(`document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark');
        scheduleSave = () => {}; addSmartGenerationLog = () => {}; window.TripoUI.refreshBalance = () => {};
        nodes = []; selectedIds = []; viewport = {x:0,y:0,scale:1};
        window.testNode = createTripoNode(500, 420, {skipUndo:true});
        window.testNode.tripoResult = {taskId:'shot-task', model:'/output/tripo/tripo_1790070709_model.fbx', preview:'', remoteModel:'', credits:0};
        selectedIds = [window.testNode.id];
        render();`);
    await sleep(2500);
    await evalJS(`document.getElementById('tripoTasksSmart').click()`);
    await sleep(900);
    await shot('tripo-任务中心-抽屉-20260923.png');
    await evalJS(`document.querySelector('[data-tasks-close]').click()`);
    await sleep(250);
    /* 工作台 4-Tab：加工页（mesh 组 6 卡） */
    await evalJS(`document.querySelector('[data-wb-tab="mesh"]').click()`);
    await evalJS(`(() => { const c = document.querySelector('[data-wb-cards="mesh"] .tca-card[data-cap="decimate"]'); if (c) c.classList.add('open'); })()`);
    await sleep(900);
    await shot('tripo-工作台-加工Tab-20260923.png');
    /* 生成页：展开生图辅助 */
    await evalJS(`document.querySelector('[data-wb-tab="generate"]').click()`);
    await sleep(200);
    await evalJS(`(() => { const d = document.querySelector('details.tripo-imgassist'); if (d) d.open = true; })()`);
    await sleep(1200);
    await shot('tripo-生图辅助-智能画布-20260923.png');

    /* 经典画布：生图辅助 */
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        window.__fakeCanvas = {id:'tripo-shot-classic', title:'截图（内存假画布）', kind:'classic', project:'default',
            nodes:[{id:'tripo-shot-1', type:'tripo', x:260, y:180, tripoMode:'image', tripoModelVersion:'P2-20260801',
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
            if (url.includes('tripo-shot-classic')) {
                const body = method === 'GET' ? {canvas: window.__fakeCanvas} : {ok:true, updated_at: window.__fakeCanvas.updated_at};
                return Promise.resolve(new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}}));
            }
            return prevFetch(input, opts);
        };
    `});
    await send('Page.navigate', {url: 'http://127.0.0.1:38080/static/canvas.html?id=tripo-shot-classic'});
    for (let i = 0; i < 40; i++) { if (await evalJS(`!!document.querySelector('.tripo-body')`) ) break; await sleep(300); }
    await sleep(1500);
    await evalJS(`(() => { const d = document.querySelector('.tripo-body details.tripo-imgassist'); if (d) d.open = true;
        const card = document.querySelector('.tripo-body .tca-card[data-cap="image_to_multiview"]'); if (card) card.classList.add('open'); })()`);
    await sleep(1500);
    await shot('tripo-生图辅助-经典画布-20260923.png');
    console.log('DONE');
} finally { if (ws) ws.close(); browser.kill(); }
