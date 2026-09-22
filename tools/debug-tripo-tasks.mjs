import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9263;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${ROOT}/.workbuddy/tmp/tripo-dbg2-${Date.now()}`,'about:blank'], {stdio:'ignore'});
let ws;
try {
    let target;
    for (let i = 0; i < 40; i++) { try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(p => p.type === 'page'); if (target) break; } catch {} await sleep(250); }
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 1; const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => { const id = seq++; const timer = setTimeout(() => { pending.delete(id); rej(Error('timeout')); }, 20000); pending.set(id, m => { clearTimeout(timer); m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result); }); ws.send(JSON.stringify({id, method, params})); });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const evalJS = async expression => { const r = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true}); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description); return r.result?.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    await send('Network.setCacheDisabled', {cacheDisabled:true});
    await send('Page.addScriptToEvaluateOnNewDocument', {source:`
        const nativeFetch = window.fetch.bind(window);
        window.__blockedWrites = [];
        window.__fakeTripoTasks = {success:true, tasks:[
            {task_id:'task-running-001', kind:'image_to_model', status:'running', progress:45, created_at:1789113000000, updated_at:1789113000000},
            {task_id:'task-done-002', kind:'decimate', status:'success', progress:100, created_at:1789020000000, updated_at:1789020000000}
        ]};
        window.fetch = (input, opts = {}) => {
            const url = String(typeof input === 'string' ? input : (input && input.url) || '');
            const method = String((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
            const isTasksGet = method === 'GET' && /\\/api\\/tripo\\/tasks(\\?|$)/.test(url);
            if (isTasksGet) return Promise.resolve(new Response(JSON.stringify(window.__fakeTripoTasks), {status:200, headers:{'Content-Type':'application/json'}}));
            if (method !== 'GET' && method !== 'HEAD') { window.__blockedWrites.push(method + ' ' + url); return Promise.reject(new Error('TEST blocked write: ' + url)); }
            return nativeFetch(input, opts);
        };
    `});
    await send('Page.navigate', {url: 'http://127.0.0.1:38080/static/smart-canvas.html'});
    for (let i = 0; i < 60; i++) { if (await evalJS(`document.readyState === 'complete' && typeof tripoTasksState !== 'undefined'`)) break; await sleep(300); }
    await sleep(3000);
    const dbg = await evalJS(`JSON.stringify({
        tasks: tripoTasksState.tasks.map(t => t.task_id + ':' + t.status),
        badge: document.getElementById('tripoTasksBadge')?.outerHTML
    })`);
    console.log(dbg);
} finally { if (ws) ws.close(); browser.kill(); }
