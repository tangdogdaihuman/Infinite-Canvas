// 经典画布（canvas.js）Tripo 冒烟：用内存假画布 + fetch 拦截验证节点渲染。
// 用法: node tools/smoke-classic-canvas.mjs   （需 38080 服务在跑）
// 原理: canvas.html 无 id / 无效 id 都会跳回 canvas-list.html，因此必须拦截
//       /api/canvases/<假id> 返回内存假画布（GET/POST 都被 hook），其余非 GET 一律
//       reject 并记录。页面停在编辑器态、完整渲染 Tripo 节点，全程零真实写盘。
// 断言: 模型目录（H3.1/P2.0/P1.0）、P2 固定价 110、Quad 开关显示、
//       分件/低模/几何精度不显示、节点 4 槽、无页面异常、无真实写请求。
// 注意: 经典画布复选框选择器是 [data-field="tripoQuad"]（智能画布才是 [data-tripo-check]）。
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// 仓库根目录按脚本自身位置推导，避免写死盘符（历史上写死过 G:/Infinite_Canvas，换盘后脚本直接失效）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 9243;
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--no-first-run','--disable-gpu',`--remote-debugging-port=${port}`,`--user-data-dir=${ROOT}/.workbuddy/tmp/smoke-canvas-${Date.now()}`,'about:blank'], {stdio:'ignore'});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
let ws;
try {
  let target;
  for(let i=0;i<40;i++){ try{ const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find(t=>t.type==='page'); if(target) break; }catch{} await sleep(250); }
  if(!target) throw Error('no target');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let seq=1; const pending=new Map(); const errors=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} if(m.method==='Runtime.exceptionThrown'){errors.push((m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text||'').split('\n')[0]);}};
  const send=(method,params={})=>new Promise((res,rej)=>{const id=seq++;const timer=setTimeout(()=>{pending.delete(id);rej(Error('timeout '+method));},15000);pending.set(id,m=>{clearTimeout(timer);m.error?rej(Error(JSON.stringify(m.error))):res(m.result)});ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__blockedWrites=[];
    window.__fakeCanvas={id:'smoke-test-nonexistent-20260911',title:'冒烟验证（内存假画布，不落盘）',kind:'classic',project:'default',
      nodes:[{id:'tripo-smoke-1',type:'tripo',x:220,y:160,tripoMode:'multiview',tripoModelVersion:'P2-20260801',tripoTexture:true,tripoPbr:true,tripoQuad:true,tripoOrtho:true,tripoTextureQuality:'standard',tripoGeometryQuality:'standard',tripoSmartLowPoly:false,tripoGenerateParts:false,tripoAutofix:false,tripoFaceLimit:'',tripoPrompt:'',tripoViews:{front:'',back:'',left:'',right:''},tripoTaskId:'',tripoTaskStatus:'',tripoProgress:0,tripoResult:null,tripoHistory:[],tripoStopped:false,tripoModelPanelOpen:false,inputs:[],running:false}],
      connections:[],viewport:{x:0,y:0,scale:1},logs:[],updated_at:1789113000000};
    const origFetch=window.fetch.bind(window);
    window.fetch=(input,opts={})=>{
      const url=String(typeof input==='string'?input:(input&&input.url)||'');
      const method=String((opts&&opts.method)||(input&&input.method)||'GET').toUpperCase();
      if(url.includes('smoke-test-nonexistent')){
        const body=method==='GET'?{canvas:window.__fakeCanvas}:{ok:true,updated_at:window.__fakeCanvas.updated_at};
        return Promise.resolve(new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}}));
      }
      if(method!=='GET'&&method!=='HEAD'){ window.__blockedWrites.push(method+' '+url); return Promise.reject(new Error('TEST blocked write: '+url)); }
      return origFetch(input,opts);
    };`});
  await send('Page.navigate',{url:'http://127.0.0.1:38080/static/canvas.html?id=smoke-test-nonexistent-20260911'});
  await sleep(7000);
  const r = await send('Runtime.evaluate',{expression:`JSON.stringify((()=>{
    const T=window.TripoUI;
    const nodeEl=document.querySelector('[data-id="tripo-smoke-1"]')||document.querySelector('.node');
    const body=nodeEl?nodeEl.querySelector('.tripo-body'):null;
    return {
      page:location.pathname.split('/').pop(),
      tripo:typeof T,
      models:T?T.MODELS.map(m=>m.id).join(','):'none',
      estP2:T?JSON.stringify(T.estimateCredits({mode:'multiview',modelId:'P2-20260801',texture:true})):'-',
      nodeFound:!!nodeEl,
      bodyFound:!!body,
      quadSwitch:body?!!body.querySelector('[data-field="tripoQuad"]'):null,
      partsSwitch:body?!!body.querySelector('[data-field="tripoGenerateParts"]'):null,
      lowPolySwitch:body?!!body.querySelector('[data-field="tripoSmartLowPoly"]'):null,
      geoField:body?!!body.querySelector('.tripo-geo-select'):null,
      estText:(nodeEl?nodeEl.querySelector('.tripo-estimate b')?.textContent:'')||'',
      modelName:(nodeEl?nodeEl.querySelector('.tripo-model-current-name')?.textContent:'')||'',
      currentHtml:(nodeEl?nodeEl.querySelector('.tripo-model-current')?.outerHTML:'').slice(0,240),
      slots:nodeEl?nodeEl.querySelectorAll('.tripo-slot').length:-1,
      blockedWrites:window.__blockedWrites
    };
  })())`,returnByValue:true});
  console.log('RESULT', r.result.value);
  console.log('PAGE_ERRORS', errors.length ? JSON.stringify(errors.slice(0,6)) : 'none');
} finally { if(ws) ws.close(); browser.kill(); }
