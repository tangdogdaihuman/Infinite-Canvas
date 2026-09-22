/* Tripo 模型放大预览模态框（双画布共用）。
 * 双击模型节点打开。显示模式一组四态：贴图材质 / 白膜 / 白膜+线框 / 纯线框，
 * 另有「贴图贴模型」预览（点贴图列表项，该贴图实时套到模型上查看 UV 效果）。
 * 交互（Maya 式，参考 Tripo 网页预览器）：左键拖拽旋转（Alt+左键同）、中键平移（Alt+中键同）、
 * 滚轮缩放、F 键回到物体中心（重新取景）；关闭按钮 / Esc / 背景双击退出。
 * 自包含：CSS 内注、GLB/FBX 按需加载（与 tripo-common.js 共享 three 模块缓存）。
 * 依赖：页面 importmap 提供 'three'，vendor 内 GLTFLoader/FBXLoader/OrbitControls。
 */
(function(){
'use strict';

const MAP_DEFS = [
    ['map', '颜色贴图'],
    ['normalMap', '法线贴图'],
    ['roughnessMap', '粗糙度贴图'],
    ['metalnessMap', '金属度贴图'],
    ['aoMap', 'AO 贴图'],
    ['emissiveMap', '自发光贴图'],
];
/* 显示模式：texture=原贴图材质 / clay=白膜 / claywire=白膜+线框叠加 / wire=纯线框 / mapview=选中贴图贴到模型 */
const MODES = [
    ['texture', '贴图材质'],
    ['clay', '白膜'],
    ['claywire', '白膜+线框'],
    ['wire', '线框'],
];
const CSS = `
.tpm-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(8,10,14,.72);
  display:none;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.tpm-backdrop.open{display:flex}
.tpm-dialog{width:min(94vw,1180px);height:min(90vh,780px);background:#14171d;border:1px solid #2a313d;
  border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.5)}
.tpm-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 16px;border-bottom:1px solid #242b36;flex:none}
.tpm-title{font-size:14px;font-weight:600;color:#e6eaf0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tpm-title span{color:#93a0b4;font-weight:400}
.tpm-close{width:32px;height:32px;border:none;border-radius:8px;background:#1c222b;color:#93a0b4;
  font-size:18px;line-height:1;cursor:pointer;flex:none}
.tpm-close:hover{background:#262e3a;color:#e6eaf0}
.tpm-body{flex:1;display:flex;min-height:0}
.tpm-stage{flex:1;position:relative;min-width:0;background:#101318}
.tpm-stage canvas{display:block}
.tpm-hint{position:absolute;left:12px;bottom:10px;font-size:11.5px;color:#5f6b7d;pointer-events:none;z-index:2}
.tpm-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#93a0b4;font-size:13px}
.tpm-side{width:300px;flex:none;border-left:1px solid #242b36;overflow-y:auto;padding:14px 16px;
  display:flex;flex-direction:column;gap:18px}
.tpm-sec-t{font-size:12px;font-weight:600;color:#93a0b4;letter-spacing:.06em;margin-bottom:8px}
.tpm-map-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.tpm-map-btn{border:1px solid #2a313d;background:#1a1f27;color:#aeb8c6;border-radius:8px;
  padding:5px 10px;font-size:12px;cursor:pointer}
.tpm-map-btn:hover{border-color:#3a4454;color:#e6eaf0}
.tpm-map-btn.active{background:#1e3a33;border-color:#2fc98f66;color:#7fe0bc}
.tpm-map-empty{font-size:12.5px;color:#5f6b7d;line-height:1.6}
.tpm-map-view{width:100%;border-radius:10px;border:1px solid #242b36;background:#0c0e12;display:none}
.tpm-map-view.show{display:block}
.tpm-map-note{font-size:11.5px;color:#5f6b7d;margin-top:6px;min-height:1em}
.tpm-modes{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.tpm-mode-btn{border:1px solid #2a313d;background:#1a1f27;color:#aeb8c6;border-radius:8px;
  padding:5px 10px;font-size:12px;cursor:pointer}
.tpm-mode-btn:hover{border-color:#3a4454;color:#e6eaf0}
.tpm-mode-btn.active{background:#1e3a33;border-color:#2fc98f66;color:#7fe0bc}
.tpm-sw{display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13px;color:#cfd6e0;cursor:pointer;user-select:none}
.tpm-sw input{accent-color:#2fc98f;width:15px;height:15px;cursor:pointer}
.tpm-stat{font-size:12.5px;color:#aeb8c6;line-height:1.9;word-break:break-all}
.tpm-stat b{color:#e6eaf0;font-weight:600}
.tpm-dl{display:inline-flex;align-items:center;gap:6px;border:1px solid #2a313d;background:#1a1f27;color:#aeb8c6;
  border-radius:8px;padding:7px 12px;font-size:12.5px;text-decoration:none}
.tpm-dl:hover{border-color:#3a4454;color:#e6eaf0}
@media (max-width:900px){.tpm-side{width:240px}.tpm-dialog{width:96vw;height:92vh}}
`;

/* ---------------- three 模块（与 tripo-common.js 共享缓存） ---------------- */
async function threeMods(){
    if(window.__tripoThreeModules) return window.__tripoThreeModules;
    const [THREE, {GLTFLoader}, {OrbitControls}] = await Promise.all([
        import('three'),
        import('/static/vendor/js/three-examples/loaders/GLTFLoader.js'),
        import('/static/vendor/js/three-examples/controls/OrbitControls.js')
    ]);
    window.__tripoThreeModules = {THREE, GLTFLoader, OrbitControls};
    return window.__tripoThreeModules;
}
async function fbxMod(){
    if(window.__tripoFbxModule) return window.__tripoFbxModule;
    const {FBXLoader} = await import('/static/vendor/js/three-examples/loaders/FBXLoader.js');
    window.__tripoFbxModule = {FBXLoader};
    return window.__tripoFbxModule;
}
function detectKind(url){
    if(window.TripoUI?.detectModelFormat) return window.TripoUI.detectModelFormat(url).kind;
    const path = String(url || '').split('?')[0];
    const tail = path.slice(path.lastIndexOf('/') + 1);
    const ext = tail.includes('.') ? tail.split('.').pop().toLowerCase() : '';
    if(!ext || ext === 'glb' || ext === 'gltf') return 'gltf';
    if(ext === 'fbx') return 'fbx';
    return 'unsupported';
}

/* ---------------- 组件状态 ---------------- */
const S = {
    built:false, open:false, url:'', name:'',
    mods:null, renderer:null, scene:null, camera:null, controls:null, model:null, raf:0,
    originalMats:new Map(), spinOn:false,
    displayMode:'texture',          // texture / clay / claywire / wire / mapview（贴图贴模型）
    maps:[], activeMap:-1, clayMat:null, wireMat:null, mapPreviewMat:null,
    wireOverlays:[],
    el:{},
};

function buildDom(){
    if(S.built) return;
    S.built = true;
    const style = document.createElement('style');
    style.id = 'tpm-style';
    style.textContent = CSS;
    document.head.appendChild(style);
    const backdrop = document.createElement('div');
    backdrop.className = 'tpm-backdrop';
    backdrop.innerHTML = `
      <div class="tpm-dialog" role="dialog" aria-modal="true" aria-label="模型预览">
        <div class="tpm-head">
          <div class="tpm-title">模型预览 <span data-tpm-name></span></div>
          <button class="tpm-close" data-tpm-close title="关闭（Esc）">×</button>
        </div>
        <div class="tpm-body">
          <div class="tpm-stage" data-tpm-stage>
            <div class="tpm-hint">左键拖拽旋转 · 中键平移 · 滚轮缩放 · F 回到中心 · 双击背景退出</div>
          </div>
          <div class="tpm-side">
            <div class="tpm-sec">
              <div class="tpm-sec-t">贴图（点击贴到模型上预览）</div>
              <div class="tpm-map-list" data-tpm-maps></div>
              <canvas class="tpm-map-view" data-tpm-mapview></canvas>
              <div class="tpm-map-note" data-tpm-mapnote></div>
            </div>
            <div class="tpm-sec">
              <div class="tpm-sec-t">显示模式</div>
              <div class="tpm-modes" data-tpm-modes></div>
              <label class="tpm-sw"><input type="checkbox" data-tpm-spin><span>自动旋转</span></label>
            </div>
            <div class="tpm-sec">
              <div class="tpm-sec-t">信息</div>
              <div class="tpm-stat" data-tpm-stats>—</div>
              <div class="tpm-stat" data-tpm-dims>—</div>
            </div>
            <div class="tpm-sec">
              <a class="tpm-dl" data-tpm-dl download>下载模型文件</a>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    S.el = {
        backdrop,
        dialog: backdrop.querySelector('.tpm-dialog'),
        name: backdrop.querySelector('[data-tpm-name]'),
        close: backdrop.querySelector('[data-tpm-close]'),
        stage: backdrop.querySelector('[data-tpm-stage]'),
        maps: backdrop.querySelector('[data-tpm-maps]'),
        mapview: backdrop.querySelector('[data-tpm-mapview]'),
        mapnote: backdrop.querySelector('[data-tpm-mapnote]'),
        modes: backdrop.querySelector('[data-tpm-modes]'),
        spin: backdrop.querySelector('[data-tpm-spin]'),
        stats: backdrop.querySelector('[data-tpm-stats]'),
        dims: backdrop.querySelector('[data-tpm-dims]'),
        dl: backdrop.querySelector('[data-tpm-dl]'),
    };
    /* 显示模式按钮组（四态互斥） */
    MODES.forEach(([id, label]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tpm-mode-btn';
        btn.dataset.tpmMode = id;
        btn.textContent = label;
        btn.addEventListener('click', () => { setDisplayMode(id); });
        S.el.modes.appendChild(btn);
    });
    S.el.close.addEventListener('click', close);
    /* 背景双击退出（对话框内双击不触发） */
    backdrop.addEventListener('dblclick', e => { if(e.target === backdrop) close(); });
    /* 阻止对话框内事件穿透到画布（避免误触发画布缩放/框选） */
    S.el.dialog.addEventListener('pointerdown', e => e.stopPropagation());
    S.el.dialog.addEventListener('wheel', e => e.stopPropagation(), {passive:true});
    S.el.spin.addEventListener('change', () => { S.spinOn = S.el.spin.checked; if(S.controls) S.controls.autoRotate = S.spinOn; });
    document.addEventListener('keydown', onKeydown, true);
}

function onKeydown(e){
    if(!S.open) return;
    if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); close(); }
    /* F = 回到物体中心（重新取景，Maya 习惯） */
    if((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey){
        e.preventDefault();
        if(S.model && S.controls){ frameCamera(); }
    }
}

/* ---------------- 渲染循环与相机 ---------------- */
function ensureRenderer(){
    const {THREE, OrbitControls} = S.mods;
    if(S.renderer) return;
    const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101318);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x334455, 1.15);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(2.5, 4, 3);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-3, -1.5, -2.5);
    scene.add(hemi, dir, dir2);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableRotate = true;
    /* Maya 式鼠标映射：左键旋转（Alt+左键同，OrbitControls 不区分修饰键）、中键平移（Alt+中键同）、
       右键平移兜底；滚轮缩放（默认）。 */
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.PAN,
    };
    S.renderer = renderer;
    S.scene = scene;
    S.camera = camera;
    S.controls = controls;
    S.el.stage.insertBefore(renderer.domElement, S.el.stage.firstChild);
    const resize = () => {
        const w = S.el.stage.clientWidth || 640, h = S.el.stage.clientHeight || 480;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    };
    S.resize = resize;
    if('ResizeObserver' in window) new ResizeObserver(resize).observe(S.el.stage);
    resize();
    const tick = () => {
        S.raf = requestAnimationFrame(tick);
        if(!S.open) return;
        S.controls.update();
        S.renderer.render(S.scene, S.camera);
    };
    tick();
}

function frameCamera(recenter){
    const {THREE} = S.mods;
    const box = new THREE.Box3().setFromObject(S.model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.001);
    /* 仅装载时把模型移到原点；F 键重取景时不再平移（模型已在原点，重复 sub 会漂移） */
    if(recenter) S.model.position.sub(center);
    S.camera.near = Math.max(radius / 100, 0.001);
    S.camera.far = Math.max(radius * 100, 100);
    S.camera.updateProjectionMatrix();
    S.camera.position.set(radius * 0.9, radius * 0.6, radius * 1.7);
    S.controls.target.set(0, 0, 0);
    S.controls.update();
    return {box, center, size, radius};
}

/* ---------------- 显示模式系统（texture / clay / claywire / wire / mapview） ---------------- */
function setDisplayMode(mode){
    S.displayMode = mode;
    renderModeButtons();
    applyDisplay();
}

function renderModeButtons(){
    if(!S.el.modes) return;
    S.el.modes.querySelectorAll('.tpm-mode-btn').forEach(btn => {
        /* mapview（贴图贴模型）也点亮「贴图材质」按钮：语义同为看贴图，点击即回原材质退出 */
        const active = btn.dataset.tpmMode === S.displayMode
            || (S.displayMode === 'mapview' && btn.dataset.tpmMode === 'texture');
        btn.classList.toggle('active', active);
    });
}

/* 白膜+线框叠加：给 mesh 挂一个共享 geometry 的线框子节点（overlay 标记防 traverse 递归） */
function addWireOverlay(mesh){
    const {THREE} = S.mods;
    const w = new THREE.Mesh(mesh.geometry, S.wireMat);
    w.userData.__wireOverlay = true;
    w.renderOrder = 1;
    mesh.add(w);
    S.wireOverlays.push(w);
}

function clearWireOverlays(){
    S.wireOverlays.forEach(w => { w.parent?.remove(w); });
    S.wireOverlays.length = 0;
}

function applyDisplay(){
    if(!S.model || !S.mods) return;
    const {THREE} = S.mods;
    /* 共享材质惰性创建：线框（浅蓝，polygonOffset 抗 z-fighting）与白膜（哑光白） */
    if(!S.wireMat) S.wireMat = new THREE.MeshBasicMaterial({color:0x9fc1ff, wireframe:true, polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1});
    if(!S.clayMat) S.clayMat = new THREE.MeshStandardMaterial({color:0xf2f2f2, roughness:0.75, metalness:0});
    clearWireOverlays();
    S.model.traverse(o => {
        if(!o.isMesh || o.userData.__wireOverlay) return;
        if(S.displayMode === 'wire'){
            /* 纯线框：整 mesh 直接换线框材质（原有行为保留） */
            o.material = S.wireMat;
        } else if(S.displayMode === 'clay'){
            o.material = S.clayMat;
        } else if(S.displayMode === 'claywire'){
            /* 白膜底 + 线框叠加 */
            o.material = S.clayMat;
            addWireOverlay(o);
        } else if(S.displayMode === 'mapview'){
            /* 贴图贴模型：选中贴图实时套上（无选中贴图时回落白膜） */
            o.material = S.mapPreviewMat || S.clayMat;
        } else {
            o.material = S.originalMats.get(o.uuid);
        }
    });
}

/* 点贴图列表项：2D 大图 + 该贴图套到模型上（mapview 模式） */
function enterMapPreview(index){
    const m = S.maps[index];
    if(!m) return;
    const {THREE} = S.mods;
    /* 通过贴图源找 texture 对象（collectMaps 只存了 image；重新从材质里取 uuid 对应的 texture） */
    let tex = null;
    S.model.traverse(o => {
        if(!o.isMesh || tex) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(mat => {
            if(!mat || tex) return;
            MAP_DEFS.forEach(([key]) => {
                const t = mat[key];
                if(t && t.uuid === m.uuid) tex = t;
            });
        });
    });
    if(!tex) return;
    if(S.mapPreviewMat) S.mapPreviewMat.dispose();
    /* 选中贴图直接作为 map 套上（texture 对象来自原材质，引用共享不 dispose） */
    S.mapPreviewMat = new THREE.MeshStandardMaterial({map:tex, roughness:0.85, metalness:0});
    S.displayMode = 'mapview';
    renderModeButtons();
    applyDisplay();
}

/* ---------------- 信息收集 ---------------- */
function fmtNum(n){ return n.toLocaleString('zh-CN'); }
function fmtSize(n){ return n >= 100 ? n.toFixed(1) : n.toFixed(2); }

function collectStats(){
    let tris = 0, verts = 0, meshes = 0;
    const mats = new Set();
    S.model.traverse(o => {
        if(!o.isMesh) return;
        meshes++;
        const g = o.geometry;
        const pos = g?.attributes?.position;
        verts += pos ? pos.count : 0;
        tris += g?.index ? g.index.count / 3 : (pos ? pos.count / 3 : 0);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && mats.add(m.uuid));
    });
    S.el.stats.innerHTML =
        `三角面 <b>${fmtNum(Math.round(tris))}</b> · 顶点 <b>${fmtNum(verts)}</b><br>` +
        `网格 <b>${meshes}</b> · 材质 <b>${mats.size}</b>`;
}

function collectDims(size){
    S.el.dims.innerHTML =
        `尺寸 <b>${fmtSize(size.x)} × ${fmtSize(size.y)} × ${fmtSize(size.z)}</b>（模型单位）<br>` +
        `<span style="color:#5f6b7d">GLB 通常为米；FBX 常为厘米</span>`;
}

function collectMaps(){
    /* 按贴图源去重：glTF 的 roughness/metalness 常打包成同一张图，标签合并显示 */
    const seen = new Map();
    S.model.traverse(o => {
        if(!o.isMesh) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(mat => {
            if(!mat) return;
            MAP_DEFS.forEach(([key, label]) => {
                const tex = mat[key];
                const img = tex && tex.image;
                if(!img || (!img.width && !img.naturalWidth)) return;
                const id = tex.uuid;
                if(seen.has(id)){
                    const entry = seen.get(id);
                    if(!entry.labels.includes(label)) entry.labels.push(label);
                } else {
                    seen.set(id, {uuid:id, key, labels:[label], image:img, width:img.width || img.naturalWidth, height:img.height || img.naturalHeight});
                }
            });
        });
    });
    S.maps = [...seen.values()];
    S.activeMap = S.maps.length ? 0 : -1;
}

/* ---------------- 贴图 2D 预览 ---------------- */
function renderMapList(){
    const wrap = S.el.maps;
    wrap.innerHTML = '';
    if(!S.maps.length){
        wrap.innerHTML = `<div class="tpm-map-empty">该模型不含贴图（素模输出）。<br>带贴图生成后，这里可切换查看颜色 / 法线 / 粗糙度等贴图。</div>`;
        S.el.mapview.classList.remove('show');
        S.el.mapnote.textContent = '';
        return;
    }
    S.maps.forEach((m, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tpm-map-btn' + (i === S.activeMap ? ' active' : '');
        btn.textContent = m.labels.join(' / ');
        btn.addEventListener('click', () => {
            S.activeMap = i;
            renderMapList();
            drawActiveMap();
            /* 贴图贴到模型上实时预览（UV 映射后的实际效果） */
            enterMapPreview(i);
        });
        wrap.appendChild(btn);
    });
    drawActiveMap();
}

function drawActiveMap(){
    const view = S.el.mapview;
    const note = S.el.mapnote;
    const m = S.maps[S.activeMap];
    if(!m){ view.classList.remove('show'); note.textContent = ''; return; }
    const maxSide = 512;
    const scale = Math.min(1, maxSide / Math.max(m.width, m.height));
    view.width = Math.max(1, Math.round(m.width * scale));
    view.height = Math.max(1, Math.round(m.height * scale));
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    try { ctx.drawImage(m.image, 0, 0, view.width, view.height); } catch(e){ /* 个别纹理对象不可绘制时仅隐藏 */ }
    view.classList.add('show');
    const packed = m.labels.length > 1 ? ' · 打包图：G=粗糙度，B=金属度' : '';
    note.textContent = `${m.width} × ${m.height}${packed}`;
}

/* ---------------- 模型装载 ---------------- */
function disposeModel(){
    if(!S.model) return;
    clearWireOverlays();
    if(S.mapPreviewMat){ S.mapPreviewMat.dispose(); S.mapPreviewMat = null; }
    S.scene.remove(S.model);
    S.model.traverse(o => {
        if(o.geometry) o.geometry.dispose();
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(m => {
            if(!m) return;
            Object.values(m).forEach(v => { if(v && v.isTexture) v.dispose(); });
            if(m !== S.clayMat && m !== S.wireMat) m.dispose?.();
        });
    });
    S.model = null;
    S.originalMats.clear();
    S.maps = [];
    S.activeMap = -1;
    S.displayMode = 'texture';
    renderModeButtons();
}

async function loadModel(url){
    const kind = detectKind(url);
    if(kind === 'unsupported'){
        S.el.stats.innerHTML = '该格式暂不支持内置预览';
        S.el.dims.textContent = '';
        return false;
    }
    let model;
    if(kind === 'fbx'){
        const {FBXLoader} = await fbxMod();
        model = await new FBXLoader().loadAsync(url);
    } else {
        const gltf = await new S.mods.GLTFLoader().loadAsync(url);
        model = gltf.scene || (gltf.scenes || [])[0];
    }
    if(!model) throw new Error('empty model');
    disposeModel();
    S.model = model;
    S.originalMats.clear();
    model.traverse(o => { if(o.isMesh) S.originalMats.set(o.uuid, o.material); });
    S.scene.add(model);
    const info = frameCamera(true);
    collectStats();
    collectDims(info.size);
    collectMaps();
    renderMapList();
    renderModeButtons();
    applyDisplay();
    return true;
}

/* ---------------- 开关 ---------------- */
async function open(opts){
    buildDom();
    const url = (opts?.url || '').trim();
    if(!url) return;
    S.url = url;
    S.name = (opts?.name || '').trim();
    S.el.name.textContent = S.name ? `· ${S.name}` : '';
    S.el.dl.href = url;
    S.open = true;
    S.el.backdrop.classList.add('open');
    S.el.stats.textContent = '加载中…';
    S.el.dims.textContent = '';
    S.el.maps.innerHTML = '';
    S.el.mapview.classList.remove('show');
    S.el.mapnote.textContent = '';
    try {
        S.mods = await threeMods();
        ensureRenderer();
        if(S.url !== url) return; /* 加载期间已切换目标 */
        await loadModel(url);
    } catch(err){
        S.el.stats.innerHTML = '模型加载失败';
        S.el.dims.textContent = String(err?.message || err);
    }
}

function close(){
    if(!S.open) return;
    S.open = false;
    S.el.backdrop.classList.remove('open');
}

function toggle(opts){
    if(S.open) close();
    else open(opts);
}

window.TripoPreviewModal = {
    open,
    close,
    toggle,
    isOpen: () => S.open,
    /* 供测试/排障用 */
    _state: S,
};
})();
