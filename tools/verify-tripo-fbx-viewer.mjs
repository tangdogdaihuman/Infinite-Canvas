// 回归验证：Tripo 3D 节点预览器能否同时吃 GLB 和 FBX（quad/低模任务只产出 FBX）。
// 隔离浏览器运行：不写用户画布（拦截所有非 GET 请求）、不调计费接口（只读本地已下载的模型文件）。
// 用法：先启动服务（run.bat，默认 38080），再 node tools/verify-tripo-fbx-viewer.mjs
// 取材：自动取 output/tripo 下最新的 .fbx；GLB 用同目录的 _verify_sample.glb（three.js 官方 Flamingo 样本，77KB）
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9238;
const APP = process.env.APP_BASE || 'http://127.0.0.1:38080';
const ROOT = 'D:/software/Infinite_Canvas';
const OUT = `${ROOT}/outputs`;
const TRIPO_DIR = `${ROOT}/output/tripo`;

function newestFile(dir, ext) {
    let best = null, bestTime = 0;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.toLowerCase().endsWith(ext)) continue;
        const t = fs.statSync(path.join(dir, name)).mtimeMs;
        if (t > bestTime) { bestTime = t; best = name; }
    }
    return best;
}
const fbxName = newestFile(TRIPO_DIR, '.fbx');
const glbName = fs.existsSync(`${TRIPO_DIR}/_verify_sample.glb`) ? '_verify_sample.glb' : null;
const FBX = fbxName ? `/output/tripo/${fbxName}` : '';
const GLB = glbName ? `/output/tripo/${glbName}` : '';
console.log(`fixture: fbx=${fbxName || '(none)'} glb=${glbName || '(none)'}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn(EDGE, ['--headless=new', '--no-first-run', `--remote-debugging-port=${PORT}`,
    '--enable-unsafe-swiftshader', `--user-data-dir=D:/software/Infinite_Canvas/.workbuddy/tmp/tripo-fbx-verify-${Date.now()}`,
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
    const screenshot = async name => {
        const shot = await send('Page.captureScreenshot', {format:'png'});
        fs.mkdirSync(OUT, {recursive:true});
        fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, 'base64'));
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
            const method = String(opts.method || input.method || 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(String(input.url || input)); return Promise.reject(new Error('TEST blocked write')); }
            return nativeFetch(input, opts);
        };
        localStorage.setItem('studio-theme', 'dark');
    `});
    await send('Page.navigate', {url: `${APP}/static/smart-canvas.html`});
    for (let i = 0; i < 90; i++) {
        if (await evalJS(`typeof createTripoNode === 'function' && !!window.TripoUI && document.readyState === 'complete'`)) break;
        await sleep(200);
    }
    await evalJS(`document.documentElement.classList.add('theme-dark'); document.body.classList.add('theme-dark');
        scheduleSave = () => {}; addSmartGenerationLog = () => {}; window.TripoUI.refreshBalance = () => {};
        nodes = []; selectedIds = []; viewport = {x:0,y:0,scale:1};
        window.testNode = createTripoNode(60, 120, {skipUndo:true});
        window.testNode.tripoResult = {taskId:'verify', model:'${FBX || '/output/tripo/_missing.fbx'}', preview:'', remoteModel:'', credits:35};
        render();`);

    // 1. 纯逻辑：格式识别
    await check('格式识别 fbx/glb/obj',
        `TripoUI.detectModelFormat('${FBX || '/output/tripo/a.fbx'}').kind === 'fbx'
         && TripoUI.detectModelFormat('${GLB || '/output/tripo/a.glb'}').kind === 'gltf'
         && TripoUI.detectModelFormat('/output/tripo/a.glb?x=1').kind === 'gltf'
         && TripoUI.detectModelFormat('/output/tripo/a.obj').kind === 'unsupported'
         && TripoUI.modelFormatLabel('${FBX || '/output/tripo/a.fbx'}') === 'FBX'`);

    // 2. 下载按钮标签跟随真实后缀
    await check('下载按钮标签显示 FBX（不是硬编码 GLB）',
        `document.querySelector('.tripo-action-btn[href]') !== null
         && document.querySelector('.tripo-action-btn[href]').textContent.trim() === 'FBX'`);

    // 3. 依赖是否完整（FBXLoader 需要 fflate + NURBSCurve/NURBSUtils）
    await check('vendor 内的 FBXLoader 及其依赖可加载',
        `(async () => { const m = await import('/static/vendor/js/three-examples/loaders/FBXLoader.js'); return typeof m.FBXLoader === 'function'; })()`);

    // 4. 真机解析：同一个 FBX 文件，FBXLoader 能出网格
    if (FBX) {
        await check('FBXLoader 解析真实 Tripo FBX 成功',
            `(async () => {
                const {FBXLoader} = await import('/static/vendor/js/three-examples/loaders/FBXLoader.js');
                const obj = await new FBXLoader().loadAsync('${FBX}');
                let meshes = 0; obj.traverse(o => { if (o.isMesh) meshes++; });
                return meshes > 0;
            })()`);
    } else {
        skip('FBXLoader 解析真实 Tripo FBX', 'output/tripo 下没有 .fbx 产物');
    }

    // 5. 回归：GLTFLoader 路径没被破坏
    if (GLB) {
        await check('GLTFLoader 解析 GLB 样本仍正常',
            `(async () => {
                const {GLTFLoader} = await import('/static/vendor/js/three-examples/loaders/GLTFLoader.js');
                const g = await new GLTFLoader().loadAsync('${GLB}');
                return !!g.scene;
            })()`);
    } else {
        skip('GLTFLoader 解析 GLB 样本', '缺少 _verify_sample.glb 样本');
    }

    // 6. 端到端：节点预览区真的渲染出 canvas（需要 WebGL，headless 下可能不可用）
    const webgl = await evalJS(`(() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch(e){ return false; } })()`);
    if (!webgl) {
        skip('FBX 在节点预览区渲染出 canvas', 'headless 环境无 WebGL');
    } else if (!FBX) {
        skip('FBX 在节点预览区渲染出 canvas', '缺少 fbx 产物');
    } else {
        await evalJS(`window.TripoUI.mountViewer(document.querySelector('[data-tripo-viewer-stage]'), '${FBX}')`);
        await sleep(2500);
        const state = await evalJS(`(() => { const st = document.querySelector('[data-tripo-viewer-stage]');
            return {canvas: !!st.querySelector('canvas'), fallback: st.querySelector('.tripo-viewer-fallback')?.textContent || ''}; })()`);
        if (!state.canvas) throw Error(`FBX 预览未渲染: ${JSON.stringify(state)}`);
        if (state.fallback) throw Error(`FBX 预览回落文案: ${state.fallback}`);
        checks.push('FBX 在节点预览区渲染出 canvas');
        console.log('PASS FBX 在节点预览区渲染出 canvas');
        await screenshot('tripo-fbx-preview-verify-20260922');

        // 7. 切换成 GLB 也要能渲染
        if (GLB) {
            await evalJS(`window.TripoUI.mountViewer(document.querySelector('[data-tripo-viewer-stage]'), '${GLB}')`);
            await sleep(2000);
            await check('换 GLB 后预览区正常渲染', `!!document.querySelector('[data-tripo-viewer-stage] canvas')
                && !document.querySelector('[data-tripo-viewer-stage] .tripo-viewer-fallback')`);
        } else {
            skip('换 GLB 后预览区正常渲染', '缺少 _verify_sample.glb 样本');
        }
    }

    // 8. 副作用检查：没有发出任何写请求 / 页面无 JS 异常
    const writes = await evalJS(`window.__blockedWrites.length`);
    if (writes) throw Error(`测试期间出现写请求: ${await evalJS('JSON.stringify(window.__blockedWrites)')}`);
    const realErrors = errors.filter(e => !/blocked write|Failed to load resource/i.test(e));
    if (realErrors.length) throw Error(`页面 JS 异常: ${realErrors.join(' | ')}`);
    console.log('PASS 无写请求、无页面异常');

    const shot = await send('Page.captureScreenshot', {format:'png'});
    fs.mkdirSync(OUT, {recursive:true});
    fs.writeFileSync(`${OUT}/tripo-glb-preview-verify-20260922.png`, Buffer.from(shot.data, 'base64'));
    console.log(`\nRESULT ok=${checks.length} skipped=${skipped}`);
} catch (err) {
    console.log('\nRESULT FAIL:', err.message);
    process.exitCode = 1;
} finally {
    try { ws?.close(); } catch {}
    try { browser.kill(); } catch {}
}
