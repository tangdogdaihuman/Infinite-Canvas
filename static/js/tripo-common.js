/* Tripo 3D 公共模块：模型目录、API 封装、点数估算、余额徽章、GLB 3D 预览器（经典画布与智能画布共用） */
(function(){
'use strict';

const tr = (key) => (window.StudioI18n && window.StudioI18n.t) ? window.StudioI18n.t(key) : key;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------------- 模型目录 ----------------
 * 数据来源：Tripo 官方 SDK（tripo3d-sdk-rust versions.rs / tripo-go-sdk）注释
 *          + platform.tripo3d.com/docs/changelog + developers.tripo3d.ai 定价页
 *
 * caps 说明（缺省即该模型不支持，UI 必须隐藏对应开关，否则勾了也无效）：
 *   quad        → quad 重拓扑（四边形输出）
 *   smartLowPoly→ 智能低模
 *   generateParts→ 自动分件
 *   geoQuality  → geometry_quality（Ultra 超清几何）
 *   multiview   → 四视图输入（注意：P1 不支持，UI 必须按模式过滤）
 */
const CAP = {QUAD:'quad', LOWPOLY:'smartLowPoly', PARTS:'generateParts', GEO:'geoQuality', MV:'multiview'};

const MODELS = [
    {
        id:'v3.1-20260211',
        name:'Tripo H3.1',
        tag:'最新 · 最高精度',
        desc:'影视级高精度资产，Ultra 模式最高 200 万面',
        modes:['text','image','multiview'],
        caps:[CAP.QUAD, CAP.LOWPOLY, CAP.PARTS, CAP.GEO],
        recommended:true
    },
    {
        id:'v3.0-20250812',
        name:'Tripo H3.0',
        tag:'稳定 · 高级功能',
        desc:'边缘更锐利、表面更干净，支持 Ultra 超清几何',
        modes:['text','image','multiview'],
        caps:[CAP.QUAD, CAP.LOWPOLY, CAP.PARTS, CAP.GEO]
    },
    {
        id:'v2.5-20250123',
        name:'Tripo H2.5',
        tag:'均衡 · 兼容旧工作流',
        desc:'经典均衡版本；用 v2.5 生成的模型建议配 v2.5 贴图',
        modes:['text','image','multiview'],
        caps:[CAP.QUAD, CAP.LOWPOLY, CAP.PARTS]
    },
    {
        id:'P1-20260311',
        name:'Tripo P1.0',
        tag:'极速 · 干净拓扑',
        desc:'Smart Mesh 引擎，约 2 秒出网格，面数约 2 万，适合游戏/AR/实时预览',
        modes:['text','image'],
        caps:[]
    }
];

const TEXTURE_QUALITIES = [
    {id:'standard', label:'标准贴图', credits:10},
    {id:'detailed', label:'高清贴图', credits:20},
    {id:'extreme',  label:'极致贴图', credits:30}
];

const GEOMETRY_QUALITIES = [
    {id:'standard', label:'标准几何', desc:'最高约 150 万面'},
    {id:'ultra',    label:'Ultra 超清', desc:'最高约 200 万面'}
];

/* 模型生成的贴图版本约束：models/texture 只接受 v3.0 与 v2.5 */
const TEXTURE_MODEL_VERSIONS = [
    {id:'v3.0-20250812', label:'v3.0 贴图', desc:'推荐用于 v3.0 / v3.1 生成的模型'},
    {id:'v2.5-20250123', label:'v2.5 贴图', desc:'推荐用于 v2.5 生成的模型'}
];

/* 官方定价（developers.tripo3d.ai）：基础任务为区间价，贴图档位为固定加价 */
const BASE_CREDITS = {text:[10,20], image:[20,30], multiview:[20,30]};
const POST_CREDITS = {texture:5, convert:5, refine:5};

const MODE_LABELS = {text:'文生 3D', image:'单图生 3D', multiview:'四视图生 3D'};

function modelById(id){
    return MODELS.find(m => m.id === id) || null;
}
function modelsForMode(mode){
    return MODELS.filter(m => (m.modes || []).includes(mode));
}
function modelSupports(modelId, cap){
    const m = modelById(modelId);
    return Boolean(m && (m.caps || []).includes(cap));
}
function defaultModelForMode(mode){
    const list = modelsForMode(mode);
    return (list.find(m => m.recommended) || list[0] || MODELS[0]).id;
}
/* 上一次生成的模型若在当前模式下不可用（如 P1 + 四视图），回落到该模式默认模型 */
function resolveModelForMode(modelId, mode){
    const m = modelById(modelId);
    if(m && (m.modes || []).includes(mode)) return m.id;
    return defaultModelForMode(mode);
}
/* 点数估算：返回 {min,max,parts[]}，parts 用于向用户逐项说明构成 */
function estimateCredits({mode='image', texture=true, textureQuality='standard'}={}){
    const base = BASE_CREDITS[mode] || BASE_CREDITS.image;
    const parts = [{label:MODE_LABELS[mode] || '生成', text:`${base[0]}–${base[1]} 点`}];
    let min = base[0], max = base[1];
    if(texture !== false){
        const q = TEXTURE_QUALITIES.find(x => x.id === textureQuality) || TEXTURE_QUALITIES[0];
        min += q.credits; max += q.credits;
        parts.push({label:`${q.label}加价`, text:`+${q.credits} 点`});
    }
    return {min, max, parts};
}
function estimatePostCredits(kind){
    const n = POST_CREDITS[kind] ?? 5;
    return {min:n, max:n, parts:[{label:kind === 'texture' ? '重贴图' : kind === 'refine' ? '精修' : '格式转换', text:`起 ${n} 点`}]};
}

/* ---------------- API 封装 ---------------- */
async function request(path, options={}){
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch(e){ /* ignore */ }
    if(!res.ok){
        const msg = data?.detail || data?.message || `${res.status} ${res.statusText}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
}

const TripoAPI = {
    /* 向后兼容：旧代码读 TripoAPI.MODEL_VERSIONS[n].id / .label */
    get MODEL_VERSIONS(){ return MODELS.map(m => ({id:m.id, label:m.name})); },
    MODELS, CAP, TEXTURE_QUALITIES, GEOMETRY_QUALITIES, TEXTURE_MODEL_VERSIONS,
    MODE_LABELS, modelById, modelsForMode, modelSupports, defaultModelForMode,
    resolveModelForMode, estimateCredits, estimatePostCredits,
    balance(){ return request('/api/tripo/balance'); },
    upload(name, dataBase64){
        return request('/api/tripo/upload', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({name, data_base64:dataBase64})
        });
    },
    createTask(payload){
        return request('/api/tripo/task', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
    },
    queryTask(taskId){ return request(`/api/tripo/task/${encodeURIComponent(taskId)}`); },
    /* 通用轮询：onProgress(task) 回调进度，成功返回 task，失败抛错
     * shouldStop() 返回 true 时抛 TripoStopped（前端"停止等待"，服务端任务仍在跑） */
    async pollTask(taskId, onProgress, intervalMs=2500, shouldStop){
        while(true){
            await new Promise(r => setTimeout(r, intervalMs));
            if(shouldStop && shouldStop()){ const e = new Error('已停止等待'); e.code = 'stopped'; throw e; }
            const data = await this.queryTask(taskId);
            const task = data.task || {};
            try { onProgress && onProgress(task); } catch(e){ /* 忽略进度回调异常 */ }
            if(task.status === 'success') return task;
            if(task.status === 'failed') throw new Error(task.error || task.message || 'Tripo 任务失败');
            if(task.status === 'cancelled') throw new Error('Tripo 任务已在服务端取消');
        }
    },
    /* 任务成功后把远端产物下载落盘到本地（失败时降级为远端 URL） */
    async finalizeOutputs(task, kind='model'){
        const output = task?.output || {};
        const result = {taskId:task?.task_id || '', model:'', preview:'', remoteModel:output.model || output.pbr_model || output.base_model || '', credits:task?.credits_consumed};
        const remoteModel = output.pbr_model || output.model || output.base_model || '';
        if(remoteModel){
            try { result.model = (await this.download(remoteModel, kind)).url; }
            catch(err){ result.model = remoteModel; }
        }
        const remotePreview = output.rendered_image || '';
        if(remotePreview){
            try { result.preview = (await this.download(remotePreview, 'preview')).url; }
            catch(err){ result.preview = remotePreview; }
        }
        return result;
    },
    download(url, kind, name){
        return request('/api/tripo/download', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({url, kind, name})
        });
    },
    /* 上传一张图片（支持 http(s) URL、/output 本地路径、data URL）→ file_token */
    async uploadImage(url){
        if(!url) throw new Error(tr('tripo.noImage') || '缺少图片');
        if(/^data:/.test(url)){
            const mime = (url.match(/^data:([^;,]+)/) || [])[1] || 'image/png';
            const ext = mime.split('/')[1] || 'png';
            const data = await this.upload(`image.${ext}`, url);
            return {token:data.file_token, ext};
        }
        const resp = await fetch(url);
        if(!resp.ok) throw new Error(`读取图片失败：${resp.status}`);
        const blob = await resp.blob();
        const ext = (() => {
            const fromUrl = url.split('?')[0].split('.').pop();
            if(fromUrl && /^[a-zA-Z]{2,5}$/.test(fromUrl)) return fromUrl.toLowerCase();
            const fromMime = (blob.type || '').split('/')[1];
            return (fromMime || 'png').toLowerCase();
        })();
        const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('图片转码失败'));
            reader.readAsDataURL(blob);
        });
        const data = await this.upload(`image.${ext}`, b64);
        return {token:data.file_token, ext};
    }
};

/* ---------------- 余额徽章 ---------------- */
const balanceState = {value:null, loading:false, error:'', mounts:new Set(), timer:null};

async function refreshTripoBalance(force){
    if(balanceState.loading) return;
    balanceState.loading = true;
    renderBalanceMounts();
    try {
        const data = await TripoAPI.balance();
        balanceState.value = data.balance;
        balanceState.error = '';
    } catch(err){
        balanceState.value = null;
        balanceState.error = err.message || String(err);
    } finally {
        balanceState.loading = false;
        renderBalanceMounts();
    }
}

function renderBalanceMounts(){
    balanceState.mounts.forEach(el => {
        if(!el.isConnected){ balanceState.mounts.delete(el); return; }
        const icon = balanceState.loading ? 'loader-2' : 'coins';
        let text, title;
        if(balanceState.error){
            text = 'Tripo —';
            title = balanceState.error;
        } else if(balanceState.value === null){
            text = 'Tripo …';
            title = tr('tripo.balanceLoading') || '余额加载中';
        } else {
            text = `Tripo ${balanceState.value}`;
            title = tr('tripo.balanceTitle') || 'Tripo 剩余点数（点击刷新）';
        }
        el.innerHTML = `<i data-lucide="${icon}" class="w-3.5 h-3.5 ${balanceState.loading?'tripo-spin':''}"></i><span>${escapeHtml(text)}</span>`;
        el.title = title;
        el.classList.toggle('tripo-balance-error', Boolean(balanceState.error));
        if(window.lucide) window.lucide.createIcons();
    });
}

function mountTripoBalance(el){
    if(!el) return;
    el.classList.add('tripo-balance');
    el.setAttribute('role', 'button');
    el.onclick = (e) => { e.stopPropagation(); refreshTripoBalance(true); };
    balanceState.mounts.add(el);
    renderBalanceMounts();
    if(balanceState.value === null && !balanceState.loading) refreshTripoBalance();
    if(!balanceState.timer){
        balanceState.timer = setInterval(() => refreshTripoBalance(), 5 * 60 * 1000);
    }
}

/* ---------------- 3D 预览器 ---------------- */
const viewers = new WeakMap();

async function loadThreeModules(){
    if(window.__tripoThreeModules) return window.__tripoThreeModules;
    const [THREE, {GLTFLoader}, {OrbitControls}] = await Promise.all([
        import('three'),
        import('/static/vendor/js/three-examples/loaders/GLTFLoader.js'),
        import('/static/vendor/js/three-examples/controls/OrbitControls.js')
    ]);
    window.__tripoThreeModules = {THREE, GLTFLoader, OrbitControls};
    return window.__tripoThreeModules;
}

function mountTripoViewer(container, glbUrl, opts={}){
    if(!container) return null;
    const prev = viewers.get(container);
    if(prev) prev.dispose();
    container.innerHTML = `<div class="tripo-viewer-loading"><i data-lucide="loader-2" class="w-5 h-5 tripo-spin"></i></div>`;
    if(window.lucide) window.lucide.createIcons();

    const state = {disposed:false, raf:0, renderer:null, dispose(){}};
    viewers.set(container, state);

    (async () => {
        let mods;
        try { mods = await loadThreeModules(); }
        catch(err){
            container.innerHTML = `<div class="tripo-viewer-fallback">${escapeHtml(tr('tripo.viewerFailed') || '3D 预览加载失败')}</div>`;
            return;
        }
        if(state.disposed || !container.isConnected) return;
        const {THREE, GLTFLoader, OrbitControls} = mods;

        const width = container.clientWidth || 320;
        const height = container.clientHeight || 220;
        const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x15171c);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.15);
        const dir = new THREE.DirectionalLight(0xffffff, 1.6);
        dir.position.set(2.5, 4, 3);
        scene.add(hemi, dir);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.autoRotate = opts.autoRotate !== false;
        controls.autoRotateSpeed = 1.6;

        container.innerHTML = '';
        container.appendChild(renderer.domElement);
        renderer.domElement.style.display = 'block';
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';

        try {
            const gltf = await new GLTFLoader().loadAsync(glbUrl);
            if(state.disposed) return;
            const model = gltf.scene;
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            const radius = Math.max(size.x, size.y, size.z, 0.001);
            model.position.sub(center);
            scene.add(model);
            camera.position.set(0, radius * 0.6, radius * 1.9);
            controls.target.set(0, 0, 0);
            controls.update();
        } catch(err){
            container.innerHTML = `<div class="tripo-viewer-fallback">${escapeHtml(tr('tripo.modelLoadFailed') || '模型加载失败')}</div>`;
            return;
        }

        let visible = true;
        const io = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => {
            visible = entries.some(en => en.isIntersecting);
        }, {threshold: 0.05}) : null;
        if(io) io.observe(container);

        const tick = () => {
            if(state.disposed) return;
            state.raf = requestAnimationFrame(tick);
            if(!visible || !container.isConnected) return;
            controls.update();
            renderer.render(scene, camera);
        };
        tick();

        const resizeObserver = ('ResizeObserver' in window) ? new ResizeObserver(() => {
            const w = container.clientWidth, h = container.clientHeight;
            if(!w || !h) return;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
        }) : null;
        if(resizeObserver) resizeObserver.observe(container);

        state.dispose = () => {
            state.disposed = true;
            cancelAnimationFrame(state.raf);
            if(io) io.disconnect();
            if(resizeObserver) resizeObserver.disconnect();
            controls.dispose();
            scene.traverse(obj => {
                if(obj.geometry) obj.geometry.dispose();
                if(obj.material){
                    (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(m => {
                        Object.values(m).forEach(v => { if(v && v.isTexture) v.dispose(); });
                        m.dispose();
                    });
                }
            });
            renderer.dispose();
            if(renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
        };
    })();

    state.dispose = state.dispose || function(){};
    const originalDispose = state.dispose;
    return {
        dispose(){ originalDispose(); state.disposed = true; cancelAnimationFrame(state.raf); }
    };
}

/* ---------------- 导出 ---------------- */
window.TripoAPI = TripoAPI;
window.TripoUI = {
    mountBalance: mountTripoBalance,
    refreshBalance: refreshTripoBalance,
    mountViewer: mountTripoViewer,
    escapeHtml,
    tr,
    /* 模型目录与估算（画布 UI 直接用） */
    MODELS, CAP, TEXTURE_QUALITIES, GEOMETRY_QUALITIES, TEXTURE_MODEL_VERSIONS,
    MODE_LABELS, modelById, modelsForMode, modelSupports, defaultModelForMode,
    resolveModelForMode, estimateCredits, estimatePostCredits
};
})();
