// 回归验证：模型放大预览模态框（双击打开 / 贴图列表 + 贴图贴模型预览 / 四态显示模式
// （贴图材质/白膜/白膜+线框/纯线框）/ Maya 式鼠标映射 / F 键回到中心 / 统计 / 尺寸 / 退出方式）。
// 隔离浏览器运行：拦截所有非 GET 请求，不写用户画布、不调计费接口。
// 取材：output/tripo/_verify_textured.glb（带 5 张贴图的 GLB 样本）+ 目录下最新 .fbx（素模，验证无贴图降级）。
// 用法：服务跑在 38080，node tools/verify-tripo-preview-modal.mjs
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9253;
const APP = process.env.APP_BASE || 'http://127.0.0.1:38080';
const OUT = `${ROOT}/outputs`;
const TRIPO_DIR = `${ROOT}/output/tripo`;

function newestFile(dir, ext) {
    let best = null, bestTime = 0;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.toLowerCase().endsWith(ext) || name.startsWith('_verify')) continue;
        const t = fs.statSync(path.join(dir, name)).mtimeMs;
        if (t > bestTime) { bestTime = t; best = name; }
    }
    return best;
}
const GLB_TEX = '/output/tripo/_verify_textured.glb';
const FBX_BARE = newestFile(TRIPO_DIR, '.fbx');
console.log(`fixture: textured=${GLB_TEX} bareFbx=${FBX_BARE || '(none)'}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn(EDGE, ['--headless=new', '--no-first-run', `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-swiftshader', `--user-data-dir=${ROOT}/.workbuddy/tmp/tripo-modal-verify-${Date.now()}`,
    'about:blank'], {stdio:'ignore'});

const checks = [];
let skipped = 0;
let ws;
try {
    let target;
    for (let i = 0; i < 40; i++) {
        try {
            target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(p => p.type === 'page');
            if (target) break;
        } catch {}
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
    const skip = (name, why) => { skipped++; console.log('SKIP', name, '—', why); };
    const dblclick = selector => evalJS(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
        if(!el) return 'MISSING:' + ${JSON.stringify(selector)};
        el.dispatchEvent(new MouseEvent('dblclick', {bubbles:true, cancelable:true})); return 'ok'; })()`);
    const modalOpen = `!!document.querySelector('.tpm-backdrop.open')`;
    const waitOpen = async () => { for (let i = 0; i < 50; i++) { if (await evalJS(modalOpen + ' && !!document.querySelector(".tpm-stage canvas") && !document.querySelector("[data-tpm-stats]").textContent.includes("加载中")')) return; await sleep(200); } throw Error('modal not ready'); };
    const closeModal = async () => { await evalJS(`window.TripoPreviewModal?.close()`); await sleep(150); };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', {cacheDisabled:true});
    await send('Emulation.setDeviceMetricsOverride', {width:1500, height:1050, deviceScaleFactor:1, mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        const nativeFetch = window.fetch.bind(window);
        window.__blockedWrites = [];
        window.fetch = (input, opts = {}) => {
            const method = String(opts.method || input.method || 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(String(input.url || input)); return Promise.reject(new Error('TEST blocked write')); }
            return nativeFetch(input, opts);
        };
        localStorage.setItem('studio-theme', 'dark');
    `});

    /* ========== 智能画布 ========== */
    await send('Page.navigate', {url: `${APP}/static/smart-canvas.html`});
    for (let i = 0; i < 90; i++) {
        if (await evalJS(`typeof createTripoNode === 'function' && !!window.TripoUI && !!window.TripoPreviewModal && document.readyState === 'complete'`)) break;
        await sleep(200);
    }
    await evalJS(`document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark');
        scheduleSave = () => {}; addSmartGenerationLog = () => {}; window.TripoUI.refreshBalance = () => {};
        nodes = []; selectedIds = []; viewport = {x:0,y:0,scale:1};
        window.testNode = createTripoNode(60, 120, {skipUndo:true});
        window.testNode.tripoResult = {taskId:'modal-verify', model:'${GLB_TEX}', preview:'', remoteModel:'', credits:0};
        render();`);
    /* Esc 探针提前安装（与阶梯复现探明的可用模式一致） */
    await evalJS(`document.addEventListener('keydown', e => { if(e.key === 'Escape') window.__escProbe = (window.__escProbe || 0) + 1; }, true); window.__escProbe = 0;`);
    await sleep(400);

    await check('组件已挂载（TripoPreviewModal）', `['open','close','toggle','isOpen'].every(k => typeof TripoPreviewModal[k] === 'function')`);

    // 1. 双击节点 → 打开
    await dblclick('.image-node');
    await waitOpen();
    await check('双击节点打开放大预览（含 WebGL 画布）', modalOpen + ` && !!document.querySelector('.tpm-stage canvas')`);

    // 2. Esc 退出（注意：Escape 不产文本，CDP 必须用 rawKeyDown 才会下发 DOM keydown；
    //    会话内首个 Input 域事件可能被吞，先发一次 mouseMoved 暖管，再重试 Esc）
    const escOnce = async () => {
        await send('Input.dispatchKeyEvent', {type:'rawKeyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
        await sleep(300);
        return evalJS('window.__escProbe');
    };
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', x:700, y:500});
    await sleep(150);
    let escHits = await escOnce();
    if (!escHits) escHits = await escOnce();
    console.log('  [diag] escProbe =', escHits);
    await check('Esc 退出预览（按键事件已送达且模态关闭）', `window.__escProbe >= 1 && !document.querySelector('.tpm-backdrop.open')`);

    // 3. 重新打开后继续其余检查
    await dblclick('.image-node');
    await waitOpen();
    await check('再次双击节点重新打开', modalOpen);

    // 2. 面数/顶点统计
    await check('面数与顶点统计显示', `(() => { const t = document.querySelector('[data-tpm-stats]').textContent;
        return t.includes('三角面') && t.includes('顶点') && /\\d/.test(t) && !t.includes('NaN'); })()`);

    // 3. 尺寸信息
    await check('尺寸信息显示（X × Y × Z）', `(() => { const t = document.querySelector('[data-tpm-dims]').textContent;
        return (t.match(/×/g) || []).length === 2 && t.includes('尺寸'); })()`);

    // 4. 贴图切换（带贴图 GLB：应有多张贴图按钮；点击后贴图实时贴到模型上）
    await check('贴图列表提取（≥3 张，含颜色/法线）', `(() => { const btns = [...document.querySelectorAll('.tpm-map-btn')].map(b => b.textContent);
        return btns.length >= 3 && btns.some(t => t.includes('颜色')) && btns.some(t => t.includes('法线')); })()`);
    await check('默认选中第一张并显示 2D 贴图', `document.querySelector('.tpm-map-btn.active') !== null
        && document.querySelector('.tpm-map-view').classList.contains('show')
        && document.querySelector('.tpm-map-view').width > 0`);
    await check('装载后默认显示模式为贴图材质（点击贴图才进入贴图预览）', `TripoPreviewModal._state.displayMode === 'texture'`);
    await evalJS(`document.querySelectorAll('.tpm-map-btn')[1].click()`);
    await sleep(200);
    await check('切换贴图后激活态跟随', `document.querySelectorAll('.tpm-map-btn')[1].classList.contains('active')
        && document.querySelector('.tpm-map-view').classList.contains('show')`);
    await check('点击贴图后实时贴到模型上（mapview + 全网格 map 生效）', `(() => { const S = TripoPreviewModal._state;
        if(S.displayMode !== 'mapview' || !S.mapPreviewMat || !S.mapPreviewMat.map) return false;
        let n = 0, ok = true;
        S.model.traverse(o => { if(o.isMesh && !o.userData.__wireOverlay){ n++; if(o.material !== S.mapPreviewMat) ok = false; } });
        return n > 0 && ok; })()`);
    const shotMapview = await send('Page.captureScreenshot', {format:'png'});
    fs.mkdirSync(OUT, {recursive:true});
    fs.writeFileSync(`${OUT}/tripo-预览模态框-贴图贴模型-20260923.png`, Buffer.from(shotMapview.data, 'base64'));

    // 5. 显示模式按钮组（四态：贴图材质 / 白膜 / 白膜+线框 / 纯线框）
    await check('显示模式按钮组渲染四态', `(() => { const btns = [...document.querySelectorAll('.tpm-mode-btn')].map(b => b.dataset.tpmMode);
        return btns.join(',') === 'texture,clay,claywire,wire'; })()`);
    await evalJS(`document.querySelector('[data-tpm-mode="texture"]').click()`);
    await sleep(150);
    await check('贴图材质按钮恢复原材质', `(() => { const S = TripoPreviewModal._state; let ok = true;
        S.model.traverse(o => { if(o.isMesh && !o.userData.__wireOverlay && o.material !== S.originalMats.get(o.uuid)) ok = false; });
        return ok && document.querySelector('[data-tpm-mode="texture"]').classList.contains('active'); })()`);
    await evalJS(`document.querySelector('[data-tpm-mode="clay"]').click()`);
    await sleep(150);
    await check('白膜模式应用到全部网格', `(() => { const S = TripoPreviewModal._state; let ok = true, n = 0;
        S.model.traverse(o => { if(o.isMesh && !o.userData.__wireOverlay){ n++; if(o.material !== S.clayMat) ok = false; } });
        return n > 0 && ok && S.wireOverlays.length === 0; })()`);
    await evalJS(`document.querySelector('[data-tpm-mode="claywire"]').click()`);
    await sleep(150);
    await check('白膜+线框叠加：白膜底材 + 每网格一个线框 overlay', `(() => { const S = TripoPreviewModal._state; let ok = true, n = 0;
        S.model.traverse(o => { if(o.isMesh && !o.userData.__wireOverlay){ n++; if(o.material !== S.clayMat) ok = false;
            if(!o.children.some(c => c.userData.__wireOverlay && c.material === S.wireMat)) ok = false; } });
        return n > 0 && ok && S.wireOverlays.length === n; })()`);
    const shotClaywire = await send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(`${OUT}/tripo-预览模态框-白膜加线框-20260923.png`, Buffer.from(shotClaywire.data, 'base64'));
    await evalJS(`document.querySelector('[data-tpm-mode="wire"]').click()`);
    await sleep(150);
    await check('纯线框模式保留（整网格换线框材质）', `(() => { const S = TripoPreviewModal._state; let ok = true, n = 0;
        S.model.traverse(o => { if(o.isMesh && !o.userData.__wireOverlay){ n++; if(o.material !== S.wireMat) ok = false; } });
        return n > 0 && ok && S.wireOverlays.length === 0; })()`);
    await evalJS(`document.querySelector('[data-tpm-mode="texture"]').click()`);
    await sleep(150);
    await check('切回贴图材质后 overlay 全部清理', `(() => { const S = TripoPreviewModal._state;
        return S.wireOverlays.length === 0 && S.displayMode === 'texture'; })()`);

    // 6. Maya 式交互：中键平移映射 + F 键回到物体中心
    await check('鼠标映射为 Maya 式（左键旋转/中键平移/右键平移）', `(() => { const S = TripoPreviewModal._state;
        const PAN = S.mods.THREE.MOUSE.PAN, ROTATE = S.mods.THREE.MOUSE.ROTATE;
        const mb = S.controls.mouseButtons;
        return mb.LEFT === ROTATE && mb.MIDDLE === PAN && mb.RIGHT === PAN; })()`);
    await evalJS(`(() => { const S = TripoPreviewModal._state;
        window.__camHome = JSON.stringify(S.camera.position.toArray());
        S.camera.position.set(88, 99, 111); S.controls.target.set(5, 5, 5); return true; })()`);
    await send('Input.dispatchKeyEvent', {type:'rawKeyDown', key:'f', code:'KeyF', windowsVirtualKeyCode:70});
    await sleep(300);
    await check('F 键回到物体中心（相机与注视点复位）', `(() => { const S = TripoPreviewModal._state;
        return JSON.stringify(S.camera.position.toArray()) === window.__camHome
            && S.controls.target.length() < 0.0001; })()`);

    // 7. 截图（模态打开、原材质恢复后的完整状态），随后关闭按钮退出
    const shot1 = await send('Page.captureScreenshot', {format:'png'});
    fs.mkdirSync(OUT, {recursive:true});
    fs.writeFileSync(`${OUT}/tripo-预览模态框-贴图与统计-20260923.png`, Buffer.from(shot1.data, 'base64'));
    await evalJS(`document.querySelector('[data-tpm-close]').click()`);
    await sleep(250);
    await check('关闭按钮退出预览', `!document.querySelector('.tpm-backdrop.open')`);

    // 9. 背景双击退出
    await dblclick('.image-node');
    await waitOpen();
    await evalJS(`document.querySelector('.tpm-backdrop').dispatchEvent(new MouseEvent('dblclick', {bubbles:true, cancelable:true}))`);
    await sleep(250);
    await check('背景双击退出预览', `!document.querySelector('.tpm-backdrop.open')`);

    // 10. 素模 FBX 的降级（无贴图提示，统计仍正常）
    if (FBX_BARE) {
        await evalJS(`window.testNode.tripoResult = {taskId:'modal-verify-fbx', model:'/output/tripo/${FBX_BARE}', preview:'', remoteModel:'', credits:0}; render();`);
        await sleep(300);
        await dblclick('.image-node');
        await waitOpen();
        await check('素模 FBX 打开成功且统计正常', `(() => { const t = document.querySelector('[data-tpm-stats]').textContent;
            return t.includes('三角面') && /\\d/.test(t) && !t.includes('NaN'); })()`);
        await check('素模显示无贴图提示（降级优雅）', `document.querySelector('.tpm-map-empty') !== null`);
        await closeModal();
    } else {
        skip('素模 FBX 降级', 'output/tripo 下没有 .fbx 产物');
    }

    /* ========== 经典画布 ========== */
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        window.__fakeCanvas2 = {id:'modal-verify-classic-20260923', title:'预览模态验证（内存假画布）', kind:'classic', project:'default',
          nodes:[{id:'tripo-modal-1', type:'tripo', x:220, y:160, tripoMode:'image', tripoModelVersion:'v3.1-20260211',
            tripoTexture:true, tripoPbr:true, tripoQuad:false, tripoOrtho:true, tripoTextureQuality:'standard',
            tripoGeometryQuality:'standard', tripoSmartLowPoly:false, tripoGenerateParts:false, tripoAutofix:false,
            tripoFaceLimit:'', tripoPrompt:'', tripoViews:{front:'',back:'',left:'',right:''}, tripoTaskId:'',
            tripoTaskStatus:'', tripoProgress:0,
            tripoResult:{taskId:'classic-modal', model:'${GLB_TEX}', preview:'', remoteModel:'', credits:0},
            tripoHistory:[], tripoStopped:false, tripoModelPanelOpen:false, inputs:[], running:false}],
          connections:[], viewport:{x:0,y:0,scale:1}, logs:[], updated_at:1789113000000};
        const origFetch2 = window.fetch.bind(window);
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            if (url.includes('modal-verify-classic')) {
                const body = method === 'GET' ? {canvas:window.__fakeCanvas2} : {ok:true, updated_at:window.__fakeCanvas2.updated_at};
                return Promise.resolve(new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}}));
            }
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(method + ' ' + url); return Promise.reject(new Error('TEST blocked write')); }
            return origFetch2(input, opts);
        };
    `});
    await send('Page.navigate', {url: `${APP}/static/canvas.html?id=modal-verify-classic-20260923`});
    await sleep(7000);
    const classicReady = await evalJS(`!!document.querySelector('.tripo-body') && !!window.TripoPreviewModal`);
    if (!classicReady) throw Error('经典画布未就绪');
    await dblclick('.tripo-body');
    await waitOpen();
    await check('经典画布：双击模型节点打开放大预览', modalOpen + ` && !!document.querySelector('.tpm-stage canvas')`);
    await closeModal();
    await check('经典画布：关闭后正常返回', `!document.querySelector('.tpm-backdrop.open') && !!document.querySelector('.tripo-body')`);

    /* 副作用检查 */
    const writes = await evalJS(`window.__blockedWrites.length`);
    if (writes) throw Error(`测试期间出现写请求: ${await evalJS('JSON.stringify(window.__blockedWrites)')}`);
    const realErrors = errors.filter(e => !/blocked write|Failed to load resource/i.test(e));
    if (realErrors.length) throw Error(`页面 JS 异常: ${realErrors.join(' | ')}`);
    console.log('PASS 无写请求、无页面异常');

    console.log(`\nRESULT ok=${checks.length} skipped=${skipped}`);
} catch (err) {
    console.log('\nRESULT FAIL:', err.message);
    process.exitCode = 1;
} finally {
    try { ws?.close(); } catch {}
    try { browser.kill(); } catch {}
}
