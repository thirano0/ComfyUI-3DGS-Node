// Toshiki Hirano (Theoretical Hole Design), 2026
// ComfyUI extension: 3DGS scene editor viewport + multi-camera renderer.

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import * as THREE from "../vendor/three.module.js";
import { OrbitControls } from "../vendor/addons/OrbitControls.js";
import { TransformControls } from "../vendor/addons/TransformControls.js";
import { GLTFLoader } from "../vendor/addons/GLTFLoader.js";
import { loadOBJWithMaterials } from "./obj.js";
import { STLLoader } from "../vendor/addons/STLLoader.js";
import { FBXLoader } from "../vendor/addons/FBXLoader.js";
import { parseGSFile, SplatMesh } from "./splat.js";

const ASPECT_PRESETS = [
    ["16:9", 16 / 9], ["3:2", 3 / 2], ["4:3", 4 / 3], ["1:1", 1],
    ["3:4", 3 / 4], ["2:3", 2 / 3], ["9:16", 9 / 16],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewURL(rel) {
    const i = rel.lastIndexOf("/");
    const sub = i >= 0 ? rel.slice(0, i) : "";
    const name = i >= 0 ? rel.slice(i + 1) : rel;
    return `/view?filename=${encodeURIComponent(name)}&type=input&subfolder=${encodeURIComponent(sub)}`;
}

async function fetchBinary(url, onProgress) {
    const resp = await api.fetchApi(url, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    const total = Number(resp.headers.get("Content-Length")) || 0;
    if (!resp.body) return await resp.arrayBuffer();
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress) onProgress(received, total);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out.buffer;
}

function defaultState() {
    return {
        version: 1,
        cameras: [],
        active: 0,
        meshes: [],
        flip: true,
        grid: false,
        bg: "#000000",
        paused: false,
        speed: 0.1,
        uniformScale: true,
        sun: { az: 45, el: 60, intensity: 1.2, color: "#ffffff", ambient: 1.2 },
    };
}

function normalizeState(s) {
    const st = Object.assign(defaultState(), s || {});
    if (!Array.isArray(st.cameras)) st.cameras = [];
    if (!Array.isArray(st.meshes)) st.meshes = [];
    st.cameras = st.cameras.map((c, i) => ({
        name: c.name || `Camera ${i + 1}`,
        pos: Array.isArray(c.pos) ? c.pos.slice(0, 3) : [0, 0, 5],
        target: Array.isArray(c.target) ? c.target.slice(0, 3) : [0, 0, 0],
        fov: Number(c.fov) || 60,
        aspect: Number(c.aspect) || 16 / 9,
    }));
    st.active = Math.min(Math.max(0, st.active | 0), Math.max(0, st.cameras.length - 1));
    st.meshes = st.meshes
        .filter((m) => m && Array.isArray(m.pos))
        .map((m, i) => ({
            src: Number.isInteger(m.src) ? m.src : i,
            pos: m.pos.slice(0, 3),
            quat: Array.isArray(m.quat) ? m.quat.slice(0, 4) : [0, 0, 0, 1],
            scale: Array.isArray(m.scale) ? m.scale.slice(0, 3) : [1, 1, 1],
            hidden: !!m.hidden,
        }));
    st.speed = Number.isFinite(Number(st.speed)) && Number(st.speed) > 0
        ? Math.min(10, Math.max(0.001, Number(st.speed))) : 0.1;
    st.uniformScale = st.uniformScale !== false;
    st.sun = Object.assign(defaultState().sun, (s && s.sun) || {});
    return st;
}

// 35mm full-frame equivalent lens focal length <-> vertical fov (film 36x24mm).
const FF_HALF_V = 12;
const fovToMM = (fov) => FF_HALF_V / Math.tan((fov * Math.PI / 180) / 2);
const mmToFov = (mm) => 2 * (180 / Math.PI) * Math.atan(FF_HALF_V / Math.max(1, mm));

function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text !== undefined) e.textContent = text;
    return e;
}

const BTN_CSS = "background:#333;border:1px solid #555;color:#ddd;border-radius:4px;" +
    "padding:2px 7px;font-size:11px;cursor:pointer;white-space:nowrap;";
const INPUT_CSS = "background:#222;border:1px solid #555;color:#ddd;border-radius:4px;" +
    "font-size:11px;padding:1px 3px;";

function collectModels(node) {
    let gsPath = null;
    const gsIdx = node.findInputSlot("gs_model");
    if (gsIdx >= 0) {
        const up = node.getInputNode(gsIdx);
        if (up) gsPath = up.widgets?.find((w) => w.name === "file")?.value ?? null;
    }
    const meshPaths = [];
    const meshIdx = node.findInputSlot("mesh");
    if (meshIdx >= 0) {
        let m = node.getInputNode(meshIdx);
        const chain = [];
        let guard = 0;
        while (m && guard++ < 64) {
            const f = m.widgets?.find((w) => w.name === "file")?.value;
            if (f) chain.push(f);
            const ai = m.findInputSlot ? m.findInputSlot("append_to") : -1;
            m = ai >= 0 ? m.getInputNode(ai) : null;
        }
        chain.reverse(); // deepest (first appended) first — matches python order
        meshPaths.push(...chain);
    }
    return { gsPath, meshPaths };
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

function setupViewport(node) {
    const stateWidget = node.widgets.find((w) => w.name === "scene_state");
    stateWidget.computeSize = () => [0, -4];
    stateWidget.hidden = true;

    // ---- DOM -------------------------------------------------------------
    const container = el("div",
        "display:flex;flex-direction:column;gap:4px;width:100%;height:100%;" +
        "background:#181818;border-radius:6px;padding:6px;box-sizing:border-box;" +
        "font-family:sans-serif;font-size:11px;color:#ccc;");

    const rowA = el("div", "display:flex;align-items:center;gap:4px;flex-wrap:wrap;");
    const rowB = el("div", "display:flex;align-items:center;gap:4px;flex-wrap:wrap;");
    const camSelect = el("select", INPUT_CSS + "max-width:130px;");
    const camAdd = el("button", BTN_CSS, "＋追加");
    const camRename = el("button", BTN_CSS, "✎");
    const camDel = el("button", BTN_CSS, "🗑");
    camAdd.title = "現在の視点を新しいカメラとして追加";
    camRename.title = "カメラ名を変更";
    camDel.title = "選択中のカメラを削除";
    const lensInput = el("input", INPUT_CSS + "width:48px;");
    lensInput.type = "number"; lensInput.min = 4; lensInput.max = 1200; lensInput.step = 1;
    lensInput.title = "カメラレンズ焦点距離 (35mmフルサイズ換算)";
    const aspectSelect = el("select", INPUT_CSS);
    for (const [label] of ASPECT_PRESETS) {
        const o = document.createElement("option"); o.value = label; o.textContent = label;
        aspectSelect.appendChild(o);
    }
    const customOpt = document.createElement("option");
    customOpt.value = "custom"; customOpt.textContent = "カスタム";
    aspectSelect.appendChild(customOpt);
    const aspectInput = el("input", INPUT_CSS + "width:52px;");
    aspectInput.type = "number"; aspectInput.min = 0.1; aspectInput.max = 10; aspectInput.step = 0.01;
    aspectInput.title = "アスペクト比 (幅/高さ)";

    rowA.append(el("span", "", "📷"), camSelect, camAdd, camRename, camDel,
        el("span", "margin-left:6px;", "レンズmm"), lensInput,
        el("span", "margin-left:6px;", "比率"), aspectSelect, aspectInput);

    const modeT = el("button", BTN_CSS, "移動[1]");
    const modeR = el("button", BTN_CSS, "回転[2]");
    const modeS = el("button", BTN_CSS, "拡縮[3]");
    modeT.title = "選択メッシュを移動（ビューポートで1キー）";
    modeR.title = "選択メッシュを回転（ビューポートで2キー）";
    modeS.title = "選択メッシュを拡縮（ビューポートで3キー）";
    const deselect = el("button", BTN_CSS, "解除");
    const reloadBtn = el("button", BTN_CSS, "⟳再読込");
    const showLabel = el("label", "display:flex;align-items:center;gap:2px;cursor:pointer;");
    const showCb = document.createElement("input"); showCb.type = "checkbox"; showCb.checked = true;
    showLabel.append(showCb, document.createTextNode("表示"));
    showLabel.title = "ビューポート描画のON/OFF (OFFで軽量化。レンダリング出力には影響しません)";
    const flipLabel = el("label", "display:flex;align-items:center;gap:2px;cursor:pointer;");
    const flipCb = document.createElement("input"); flipCb.type = "checkbox";
    flipLabel.append(flipCb, document.createTextNode("上下反転"));
    flipLabel.title = "COLMAP系(Y下向き)のシーンをY上向きに回転";
    const gridLabel = el("label", "display:flex;align-items:center;gap:2px;cursor:pointer;");
    const gridCb = document.createElement("input"); gridCb.type = "checkbox";
    gridLabel.append(gridCb, document.createTextNode("グリッド"));
    const bgInput = document.createElement("input");
    bgInput.type = "color"; bgInput.value = "#000000";
    bgInput.style.cssText = "width:26px;height:18px;padding:0;border:1px solid #555;background:none;";
    bgInput.title = "背景色";

    const meshSelect = el("select", INPUT_CSS + "max-width:180px;");
    meshSelect.title = "画面外のメッシュも一覧から選択できます（非表示の場合は再表示）";
    const focusMeshBtn = el("button", BTN_CSS, "選択へ移動[F]");
    focusMeshBtn.title = "選択メッシュ全体が見える位置へ移動します。現在のカメラ設定に反映されます";
    const showAllBtn = el("button", BTN_CSS, "👁全表示");
    showAllBtn.title = "削除(非表示)にしたメッシュをすべて再表示";
    rowB.append(el("span", "", "メッシュ:"), meshSelect, focusMeshBtn, modeT, modeR, modeS, deselect, showAllBtn,
        el("span", "flex:1 1 auto;", ""), showLabel, flipLabel, gridLabel, bgInput, reloadBtn);

    // View / lighting row: camera speed + sun light.
    const SLIDER_CSS = "width:64px;height:14px;";
    const makeSlider = (min, max, step) => {
        const inp = el("input", SLIDER_CSS);
        inp.type = "range"; inp.min = min; inp.max = max; inp.step = step;
        return inp;
    };
    const rowV = el("div", "display:flex;align-items:center;gap:4px;flex-wrap:wrap;");
    const speedSlider = makeSlider(-3, 1, 0.05);
    const speedVal = el("span", "color:#888;min-width:30px;", "×0.1");
    speedSlider.title = "カメラ移動速度 (WASD/QE): 0.001〜10倍。Z:減速 / X:加速";
    const sunAz = makeSlider(0, 360, 1);
    const sunEl = makeSlider(0, 90, 1);
    const sunInt = makeSlider(0, 3, 0.05);
    const sunAmb = makeSlider(0, 3, 0.05);
    sunAz.title = "太陽の方位角"; sunEl.title = "太陽の高度"; sunInt.title = "太陽光の強さ";
    sunAmb.title = "環境光の強さ";
    const sunColor = document.createElement("input");
    sunColor.type = "color"; sunColor.value = "#ffffff";
    sunColor.style.cssText = "width:22px;height:16px;padding:0;border:1px solid #555;background:none;";
    sunColor.title = "太陽光の色";
    rowV.append(el("span", "color:#9ab;", "速度"), speedSlider, speedVal,
        el("span", "color:#cb8;margin-left:8px;", "☀方位"), sunAz,
        el("span", "color:#cb8;", "高度"), sunEl,
        el("span", "color:#cb8;", "強さ"), sunInt, sunColor,
        el("span", "color:#cb8;", "環境"), sunAmb);

    // Numeric transform panel for the selected mesh.
    const rowC = el("div", "display:none;align-items:center;gap:3px;flex-wrap:wrap;");
    const NUM_CSS = INPUT_CSS + "width:52px;";
    const makeNum = (step) => {
        const inp = el("input", NUM_CSS);
        inp.type = "number";
        inp.step = step;
        return inp;
    };
    const tPos = [makeNum("0.01"), makeNum("0.01"), makeNum("0.01")];
    const tRot = [makeNum("1"), makeNum("1"), makeNum("1")];
    const tScl = [makeNum("0.01"), makeNum("0.01"), makeNum("0.01")];
    const uniformLabel = el("label", "display:flex;align-items:center;gap:2px;cursor:pointer;");
    const uniformCb = document.createElement("input"); uniformCb.type = "checkbox"; uniformCb.checked = true;
    uniformLabel.append(uniformCb, document.createTextNode("均等"));
    uniformLabel.title = "拡大縮小を等倍(XYZ 連動)にする";
    const dupBtn = el("button", BTN_CSS, "⧉複製");
    dupBtn.title = "選択メッシュを複製 (Ctrl+D)";
    const delBtn = el("button", BTN_CSS, "✕削除");
    delBtn.title = "選択メッシュをビューから削除 (Delete)";
    rowC.append(el("span", "color:#9b9", "位置"), ...tPos,
        el("span", "color:#9b9;margin-left:4px;", "回転°"), ...tRot,
        el("span", "color:#9b9;margin-left:4px;", "倍率"), ...tScl, uniformLabel,
        el("span", "flex:1 1 auto;", ""), dupBtn, delBtn);

    const wrap = el("div",
        "position:relative;flex:1 1 auto;min-height:200px;overflow:hidden;outline:none;" +
        "border:1px solid #333;border-radius:4px;background:#000;");
    wrap.tabIndex = 0;
    const canvas = el("canvas", "width:100%;height:100%;display:block;");
    const frame = el("div",
        "position:absolute;pointer-events:none;border:1px solid rgba(255,255,255,0.65);" +
        "box-shadow:0 0 0 9999px rgba(0,0,0,0.45);top:0;left:0;");
    const busy = el("div",
        "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.6);color:#fff;font-size:14px;z-index:5;", "レンダリング中…");
    const pausedOverlay = el("div",
        "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.75);color:#999;font-size:13px;z-index:4;pointer-events:none;",
        "ビューポート停止中(「表示」で再開)");
    wrap.append(canvas, frame, pausedOverlay, busy);

    const status = el("div", "min-height:14px;color:#888;font-size:10px;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;",
        "クリックして操作 / WASD+QE:移動 Z:減速 X:加速 Shift:高速 / メッシュ 1:移動 2:回転 3:拡縮 F:選択へ移動");

    const credit = el("div", "color:#aaa;font-size:10px;line-height:1.4;flex-shrink:0;text-align:right;",
        "Toshiki Hirano (Theoretical Hole Design), 2026");
    container.append(rowA, rowB, rowV, rowC, wrap, status, credit);
    node.addDOMWidget("gs3d_viewport", "GS3DVIEW", container, { serialize: false });

    // ---- three.js scene ----------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    const scene = new THREE.Scene();
    const root = new THREE.Group();
    scene.add(root);
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x555566, 1.2);
    scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 2, 1.5);
    scene.add(dirLight);
    const grid = new THREE.GridHelper(10, 20, 0x555555, 0x333333);
    grid.visible = false;
    scene.add(grid);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
    camera.position.set(0, 0, 5);
    const orbit = new OrbitControls(camera, wrap);
    orbit.enableDamping = false;
    const tctrl = new TransformControls(camera, wrap);
    tctrl.size = 0.8;
    scene.add(tctrl);
    const selectionBox = new THREE.BoxHelper(undefined, 0xffcc55);
    selectionBox.material.depthTest = false;
    selectionBox.material.depthWrite = false;
    selectionBox.material.transparent = true;
    selectionBox.renderOrder = 1000;
    selectionBox.visible = false;
    scene.add(selectionBox);
    tctrl.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });

    const gs = {
        state: defaultState(),
        seq: 0,
        loadPromise: Promise.resolve(),
        gsPathLoaded: undefined,
        meshKeyLoaded: undefined,
        splat: null,
        bounds: { center: new THREE.Vector3(), radius: 5 },
        moveSpeed: 2.5,
        meshTemplates: [],
        meshGroups: [],
        selectedMesh: -1,
        renderer, scene, root, camera, orbit, tctrl,
        offscreen: null,
        disposed: false,
    };
    node.gs3d = gs;

    // ---- state persistence -------------------------------------------------
    let saveTimer = null;
    function scheduleSave() {
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            stateWidget.value = JSON.stringify(gs.editorState || gs.state);
        }, 400);
    }
    stateWidget.serializeValue = () => {
        if (gs.editorState) return JSON.stringify(gs.editorState);
        syncStateFromView();
        return JSON.stringify(gs.state);
    };

    function setStatus(text, isError) {
        status.textContent = text;
        status.style.color = isError ? "#f66" : "#888";
        if (isError) console.error("[gs3d]", text);
    }

    // ---- camera management ---------------------------------------------------
    function activeCam() { return gs.state.cameras[gs.state.active]; }

    function createDefaultCamera() {
        const { center, radius } = gs.bounds;
        gs.state.cameras.push({
            name: `Camera ${gs.state.cameras.length + 1}`,
            pos: [center.x, center.y + radius * 0.2, center.z + radius * 1.6],
            target: [center.x, center.y, center.z],
            fov: 60,
            aspect: 16 / 9,
        });
        gs.state.active = gs.state.cameras.length - 1;
    }

    function refreshCameraUI() {
        camSelect.innerHTML = "";
        gs.state.cameras.forEach((c, i) => {
            const o = document.createElement("option");
            o.value = String(i);
            o.textContent = c.name;
            camSelect.appendChild(o);
        });
        camSelect.value = String(gs.state.active);
        const cam = activeCam();
        if (cam) {
            lensInput.value = String(Math.round(fovToMM(cam.fov) * 10) / 10);
            aspectInput.value = String(Math.round(cam.aspect * 10000) / 10000);
            const preset = ASPECT_PRESETS.find(([, v]) => Math.abs(v - cam.aspect) < 1e-3);
            aspectSelect.value = preset ? preset[0] : "custom";
        }
    }

    function applyActiveCameraToView() {
        const cam = activeCam();
        if (!cam) return;
        camera.position.fromArray(cam.pos);
        orbit.target.fromArray(cam.target);
        orbit.update();
        updateProjection();
    }

    function syncStateFromView() {
        const cam = activeCam();
        if (!cam) return;
        cam.pos[0] = camera.position.x; cam.pos[1] = camera.position.y; cam.pos[2] = camera.position.z;
        cam.target[0] = orbit.target.x; cam.target[1] = orbit.target.y; cam.target[2] = orbit.target.z;
    }

    function updateClipPlanes(cam3) {
        const r = gs.bounds.radius;
        cam3.near = Math.max(r / 500, 1e-4);
        cam3.far = Math.max(r * 100, 100);
    }

    function updateProjection() {
        const cam = activeCam();
        const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
        const a = cam ? cam.aspect : 16 / 9;
        const fw = Math.min(w, h * a);
        const fh = fw / a;
        // Effective viewport fov so the letterbox frame matches the camera fov.
        const fov = cam ? cam.fov : 60;
        const t = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * (h / fh);
        camera.fov = 2 * THREE.MathUtils.radToDeg(Math.atan(t));
        camera.aspect = w / h;
        updateClipPlanes(camera);
        camera.updateProjectionMatrix();
        frame.style.width = `${fw - 2}px`;
        frame.style.height = `${fh - 2}px`;
        frame.style.left = `${(w - fw) / 2}px`;
        frame.style.top = `${(h - fh) / 2}px`;
    }

    camSelect.addEventListener("change", () => {
        syncStateFromView();
        gs.state.active = parseInt(camSelect.value, 10) || 0;
        refreshCameraUI();
        applyActiveCameraToView();
        scheduleSave();
    });
    camAdd.addEventListener("click", () => {
        syncStateFromView();
        const cur = activeCam();
        gs.state.cameras.push({
            name: `Camera ${gs.state.cameras.length + 1}`,
            pos: cur ? cur.pos.slice() : [0, 0, 5],
            target: cur ? cur.target.slice() : [0, 0, 0],
            fov: cur ? cur.fov : 60,
            aspect: cur ? cur.aspect : 16 / 9,
        });
        gs.state.active = gs.state.cameras.length - 1;
        refreshCameraUI();
        scheduleSave();
    });
    camRename.addEventListener("click", () => {
        const cam = activeCam();
        if (!cam) return;
        const name = prompt("カメラ名:", cam.name);
        if (name) { cam.name = name; refreshCameraUI(); scheduleSave(); }
    });
    camDel.addEventListener("click", () => {
        if (gs.state.cameras.length <= 1) { setStatus("カメラは最低1つ必要です", true); return; }
        gs.state.cameras.splice(gs.state.active, 1);
        gs.state.active = Math.min(gs.state.active, gs.state.cameras.length - 1);
        refreshCameraUI();
        applyActiveCameraToView();
        scheduleSave();
    });
    lensInput.addEventListener("change", () => {
        const cam = activeCam();
        if (!cam) return;
        const mm = Math.min(1200, Math.max(4, Number(lensInput.value) || 50));
        cam.fov = mmToFov(mm);
        lensInput.value = String(mm);
        updateProjection();
        scheduleSave();
    });
    aspectSelect.addEventListener("change", () => {
        const cam = activeCam();
        if (!cam) return;
        const preset = ASPECT_PRESETS.find(([label]) => label === aspectSelect.value);
        if (preset) {
            cam.aspect = preset[1];
            aspectInput.value = String(Math.round(cam.aspect * 10000) / 10000);
            updateProjection();
            scheduleSave();
        }
    });
    aspectInput.addEventListener("change", () => {
        const cam = activeCam();
        if (!cam) return;
        cam.aspect = Math.min(10, Math.max(0.1, Number(aspectInput.value) || 16 / 9));
        const preset = ASPECT_PRESETS.find(([, v]) => Math.abs(v - cam.aspect) < 1e-3);
        aspectSelect.value = preset ? preset[0] : "custom";
        updateProjection();
        scheduleSave();
    });

    // ---- scene options ------------------------------------------------------
    function applySceneOptions() {
        root.rotation.set(gs.state.flip ? Math.PI : 0, 0, 0);
        root.updateMatrixWorld(true);
        grid.visible = !!gs.state.grid;
        renderer.setClearColor(new THREE.Color(gs.state.bg || "#000000"), 1);
        flipCb.checked = !!gs.state.flip;
        gridCb.checked = !!gs.state.grid;
        showCb.checked = !gs.state.paused;
        pausedOverlay.style.display = gs.state.paused ? "flex" : "none";
        try { bgInput.value = gs.state.bg || "#000000"; } catch (e) { /* invalid color */ }
        // sun light
        const sun = gs.state.sun || defaultState().sun;
        const az = THREE.MathUtils.degToRad(Number(sun.az) || 0);
        const elv = THREE.MathUtils.degToRad(Number(sun.el) || 0);
        dirLight.position.set(
            Math.cos(elv) * Math.sin(az), Math.sin(elv), Math.cos(elv) * Math.cos(az),
        ).multiplyScalar(10);
        const inten = Number(sun.intensity), amb = Number(sun.ambient);
        dirLight.intensity = Number.isFinite(inten) ? inten : 1.2;
        try { dirLight.color.set(sun.color || "#ffffff"); } catch (e) { /* invalid color */ }
        hemiLight.intensity = Number.isFinite(amb) ? amb : 1.2;
        sunAz.value = String(sun.az); sunEl.value = String(sun.el);
        sunInt.value = String(sun.intensity); sunAmb.value = String(sun.ambient);
        try { sunColor.value = sun.color || "#ffffff"; } catch (e) { /* invalid color */ }
        // camera speed / uniform scale
        const spd = gs.state.speed || 0.1;
        speedSlider.value = String(Math.max(-3, Math.min(1, Math.log10(spd))));
        speedVal.textContent = `×${Number(spd.toPrecision(3))}`;
        uniformCb.checked = gs.state.uniformScale !== false;
    }
    flipCb.addEventListener("change", () => { gs.state.flip = flipCb.checked; applySceneOptions(); forceSort(); scheduleSave(); });
    gridCb.addEventListener("change", () => { gs.state.grid = gridCb.checked; applySceneOptions(); scheduleSave(); });
    showCb.addEventListener("change", () => {
        gs.state.paused = !showCb.checked;
        applySceneOptions();
        if (!gs.state.paused) forceSort();
        scheduleSave();
    });
    function setMoveSpeed(value) {
        gs.state.speed = Math.min(10, Math.max(0.001, value));
        speedSlider.value = String(Math.log10(gs.state.speed));
        speedVal.textContent = `×${Number(gs.state.speed.toPrecision(3))}`;
        scheduleSave();
    }
    speedSlider.addEventListener("input", () => {
        setMoveSpeed(Math.pow(10, Number(speedSlider.value) || 0));
    });
    const onSunInput = () => {
        gs.state.sun = {
            az: Number(sunAz.value) || 0,
            el: Number(sunEl.value) || 0,
            intensity: Number(sunInt.value) || 0,
            color: sunColor.value,
            ambient: Number(sunAmb.value) || 0,
        };
        applySceneOptions();
        scheduleSave();
    };
    for (const inp of [sunAz, sunEl, sunInt, sunAmb, sunColor]) {
        inp.addEventListener("input", onSunInput);
    }
    uniformCb.addEventListener("change", () => {
        gs.state.uniformScale = uniformCb.checked;
        scheduleSave();
    });
    bgInput.addEventListener("input", () => { gs.state.bg = bgInput.value; applySceneOptions(); scheduleSave(); });
    reloadBtn.addEventListener("click", () => reloadIfChanged(true));

    // ---- mesh gizmo -----------------------------------------------------------
    function setGizmoMode(mode) {
        tctrl.setMode(mode);
        for (const [b, m] of [[modeT, "translate"], [modeR, "rotate"], [modeS, "scale"]]) {
            b.style.background = m === mode ? "#3a5" : "#333";
        }
    }
    setGizmoMode("translate");
    modeT.addEventListener("click", () => setGizmoMode("translate"));
    modeR.addEventListener("click", () => setGizmoMode("rotate"));
    modeS.addEventListener("click", () => setGizmoMode("scale"));

    // Rotation pivot: no selection = look-around from the camera position,
    // selection = orbit around the selected object (handled manually below,
    // so moving the object never drags the view with it).
    orbit.enableRotate = false;

    function commitMeshTransform(i) {
        const g = gs.meshGroups[i];
        const m = gs.state.meshes[i];
        if (!g || !m) return;
        m.pos = g.position.toArray();
        m.quat = g.quaternion.toArray();
        m.scale = g.scale.toArray();
        scheduleSave();
    }

    const _fmt = (v) => String(Math.round(v * 1000) / 1000);
    function refreshTransformPanel() {
        const g = gs.meshGroups[gs.selectedMesh];
        if (!g) return;
        const e3 = new THREE.Euler().setFromQuaternion(g.quaternion, "XYZ");
        [g.position.x, g.position.y, g.position.z].forEach((v, k) => { tPos[k].value = _fmt(v); });
        [e3.x, e3.y, e3.z].forEach((v, k) => { tRot[k].value = _fmt(THREE.MathUtils.radToDeg(v)); });
        [g.scale.x, g.scale.y, g.scale.z].forEach((v, k) => { tScl[k].value = _fmt(v); });
    }

    function selectMesh(i) {
        const g = gs.meshGroups[i];
        if (!g) return;
        gs.selectedMesh = i;
        tctrl.attach(g);
        rowC.style.display = "flex";
        if (gs.state.meshes[i].hidden) {
            gs.state.meshes[i].hidden = false;
            g.visible = true;
            scheduleSave();
        }
        refreshTransformPanel();
        refreshMeshList();
        updateSelectionBox();
        setStatus(`メッシュ ${i + 1} を選択中 — ドラッグ回転はオブジェクト中心 (1:移動 2:回転 3:拡縮 Ctrl+D:複製 Delete:削除 Esc:解除)`);
    }

    function deselectMesh() {
        tctrl.detach();
        gs.selectedMesh = -1;
        rowC.style.display = "none";
        refreshMeshList();
        selectionBox.visible = false;
    }
    deselect.addEventListener("click", deselectMesh);

    function refreshMeshList() {
        meshSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "-1";
        placeholder.textContent = gs.state.meshes.length ? "メッシュを選択…" : "メッシュなし";
        meshSelect.appendChild(placeholder);
        const paths = gs.meshPathsLoaded || [];
        gs.state.meshes.forEach((m, i) => {
            const option = document.createElement("option");
            option.value = String(i);
            const name = paths[m.src]?.split("/").pop() || `Mesh ${m.src + 1}`;
            option.textContent = `${i + 1}: ${name}${m.hidden ? " (非表示)" : ""}`;
            meshSelect.appendChild(option);
        });
        meshSelect.value = String(gs.selectedMesh);
        focusMeshBtn.disabled = gs.selectedMesh < 0;
    }

    function updateSelectionBox() {
        const group = gs.meshGroups[gs.selectedMesh];
        selectionBox.visible = !!group && group.visible && !gs.renderingJob;
        if (selectionBox.visible) {
            root.updateMatrixWorld(true);
            selectionBox.setFromObject(group);
        }
    }

    function focusSelectedMesh() {
        const group = gs.meshGroups[gs.selectedMesh];
        if (!group || gs.renderingJob) return;
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(group);
        if (box.isEmpty()) return;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        if (!Number.isFinite(sphere.radius)) return;
        const cam = activeCam();
        const halfV = THREE.MathUtils.degToRad(cam?.fov || 60) / 2;
        const halfH = Math.atan(Math.tan(halfV) * (cam?.aspect || 16 / 9));
        updateProjection();
        const distance = Math.max(
            sphere.radius * 1.2 / Math.sin(Math.min(halfV, halfH)),
            sphere.radius + camera.near * 2);
        const forward = camera.getWorldDirection(new THREE.Vector3());
        camera.position.copy(sphere.center).addScaledVector(forward, -distance);
        orbit.target.copy(sphere.center);
        orbit.update();
        gs.state.paused = false;
        applySceneOptions();
        syncStateFromView();
        scheduleSave();
        forceSort();
        updateSelectionBox();
        wrap.focus();
        setStatus("選択メッシュへ移動しました。黄色の枠がメッシュの範囲です（現在のカメラに反映）");
    }
    meshSelect.addEventListener("change", () => {
        const i = Number(meshSelect.value);
        if (i < 0) deselectMesh(); else selectMesh(i);
    });
    focusMeshBtn.addEventListener("click", focusSelectedMesh);


    tctrl.addEventListener("objectChange", () => {
        const i = gs.selectedMesh;
        const g = gs.meshGroups[i];
        const m = gs.state.meshes[i];
        if (i < 0 || !g || !m) return;
        // Uniform scale: an axis-handle drag changes one component — detect it
        // against the last committed scale and apply it to all axes.
        if (uniformCb.checked && tctrl.mode === "scale") {
            let best = -1, bestD = 1e-7;
            for (let k = 0; k < 3; k++) {
                const d = Math.abs(Math.log(
                    Math.max(1e-9, g.scale.getComponent(k)) / Math.max(1e-9, m.scale[k])));
                if (d > bestD) { bestD = d; best = k; }
            }
            if (best >= 0) {
                const s = g.scale.getComponent(best);
                g.scale.set(s, s, s);
            }
        }
        commitMeshTransform(i);
        refreshTransformPanel();
    });

    const numOr = (inp, d) => {
        const v = parseFloat(inp.value);
        return Number.isFinite(v) ? v : d;
    };
    function onNumericChange(ev) {
        const i = gs.selectedMesh;
        const g = gs.meshGroups[i];
        if (i < 0 || !g) return;
        if (uniformCb.checked && tScl.includes(ev?.target)) {
            for (const inp of tScl) inp.value = ev.target.value;
        }
        g.position.set(numOr(tPos[0], 0), numOr(tPos[1], 0), numOr(tPos[2], 0));
        g.quaternion.setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(numOr(tRot[0], 0)),
            THREE.MathUtils.degToRad(numOr(tRot[1], 0)),
            THREE.MathUtils.degToRad(numOr(tRot[2], 0)),
            "XYZ"));
        g.scale.set(
            Math.max(1e-6, numOr(tScl[0], 1)),
            Math.max(1e-6, numOr(tScl[1], 1)),
            Math.max(1e-6, numOr(tScl[2], 1)));
        commitMeshTransform(i);
    }
    for (const inp of [...tPos, ...tRot, ...tScl]) inp.addEventListener("change", onNumericChange);

    function duplicateMesh() {
        const i = gs.selectedMesh;
        const m = gs.state.meshes[i];
        if (i < 0 || !m) return;
        const copy = JSON.parse(JSON.stringify(m));
        copy.hidden = false;
        copy.pos[0] += gs.bounds.radius * 0.05;
        gs.state.meshes.push(copy);
        rebuildMeshGroups();
        selectMesh(gs.state.meshes.length - 1);
        scheduleSave();
        setStatus(`メッシュを複製しました (${gs.state.meshes.length} 個)`);
    }
    dupBtn.addEventListener("click", duplicateMesh);

    function deleteSelectedMesh() {
        const i = gs.selectedMesh;
        const m = gs.state.meshes[i];
        if (i < 0 || !m) return;
        const hasSibling = gs.state.meshes.some((e, k) => k !== i && e.src === m.src);
        if (hasSibling) {
            gs.state.meshes.splice(i, 1); // duplicate: remove entry entirely
        } else {
            m.hidden = true; // original: hide so reload does not resurrect it
        }
        deselectMesh();
        rebuildMeshGroups();
        scheduleSave();
        setStatus("メッシュを削除しました(「👁全表示」で非表示分を復元できます)");
    }
    delBtn.addEventListener("click", deleteSelectedMesh);

    showAllBtn.addEventListener("click", () => {
        for (const m of gs.state.meshes) m.hidden = false;
        rebuildMeshGroups();
        scheduleSave();
    });

    // Left-drag rotation: look-around from the camera when nothing is
    // selected, orbit around the selected object otherwise. Drags that start
    // on a gizmo handle (tctrl.axis is set on hover) are left to the gizmo.
    const raycaster = new THREE.Raycaster();
    const _pivot = new THREE.Vector3();
    let downPos = null;
    let lookDrag = null;
    wrap.addEventListener("pointerdown", (e) => {
        wrap.focus();
        downPos = [e.clientX, e.clientY];
        if (e.button === 0 && !tctrl.dragging && !tctrl.axis) {
            lookDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
            wrap.setPointerCapture(e.pointerId);
        }
    });
    wrap.addEventListener("pointermove", (e) => {
        if (!lookDrag || e.pointerId !== lookDrag.id) return;
        const dx = e.clientX - lookDrag.x;
        const dy = e.clientY - lookDrag.y;
        lookDrag.x = e.clientX;
        lookDrag.y = e.clientY;
        const sel = gs.meshGroups[gs.selectedMesh];
        if (sel) {
            root.updateMatrixWorld(true);
            new THREE.Box3().setFromObject(sel).getCenter(_pivot);
            rotateAroundPivot(_pivot, dx * 0.0045, dy * 0.0045);
        } else {
            rotateView(dx * 0.0045, dy * 0.0045);
        }
    });
    const endLookDrag = (e) => {
        if (lookDrag && e.pointerId === lookDrag.id) {
            try { wrap.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
            lookDrag = null;
        }
    };
    wrap.addEventListener("pointercancel", endLookDrag);
    wrap.addEventListener("pointerup", (e) => {
        endLookDrag(e);
        if (!downPos) return;
        const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
        downPos = null;
        if (moved > 4 || e.button !== 0 || tctrl.dragging) return;
        if (!gs.meshGroups.length) return;
        const r = wrap.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((e.clientX - r.left) / r.width) * 2 - 1,
            -((e.clientY - r.top) / r.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(gs.meshGroups, true);
        let idx = -1;
        for (const h of hits) {
            let obj = h.object;
            while (obj && !gs.meshGroups.includes(obj)) obj = obj.parent;
            if (obj && obj.visible) { idx = gs.meshGroups.indexOf(obj); break; }
        }
        if (idx < 0) {
            if (gs.selectedMesh >= 0) deselectMesh();
            return;
        }
        selectMesh(idx);
    });

    // ---- keyboard navigation ---------------------------------------------------
    const keys = new Set();
    const MOVE_KEYS = new Set(["w", "a", "s", "d", "q", "e",
        "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"]);
    wrap.addEventListener("keydown", (e) => {
        const k = e.key.toLowerCase();
        if ((k === "z" || k === "x") && !e.ctrlKey && !e.metaKey && !e.altKey) {
            setMoveSpeed((gs.state.speed || 0.1) * (k === "z" ? 1 / Math.SQRT2 : Math.SQRT2));
            e.preventDefault(); e.stopPropagation(); return;
        }
        if (k === "1") { setGizmoMode("translate"); e.preventDefault(); e.stopPropagation(); return; }
        if (k === "2") { setGizmoMode("rotate"); e.preventDefault(); e.stopPropagation(); return; }
        if (k === "3") { setGizmoMode("scale"); e.preventDefault(); e.stopPropagation(); return; }
        if (k === "f") { focusSelectedMesh(); e.preventDefault(); e.stopPropagation(); return; }
        if (k === "escape") { deselectMesh(); e.stopPropagation(); return; }
        if (k === "delete") { deleteSelectedMesh(); e.preventDefault(); e.stopPropagation(); return; }
        if (k === "d" && (e.ctrlKey || e.metaKey)) { duplicateMesh(); e.preventDefault(); e.stopPropagation(); return; }
        if (MOVE_KEYS.has(k)) {
            keys.add(k);
            e.preventDefault();
            e.stopPropagation();
        }
    });
    wrap.addEventListener("keyup", (e) => { keys.delete(e.key.toLowerCase()); });
    wrap.addEventListener("blur", () => keys.clear());

    const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

    // Rotate the view direction around the camera position (grab-the-world
    // convention, matching OrbitControls' feel). Pitch is clamped at the poles.
    function rotateView(yaw, pitch) {
        const offset = orbit.target.clone().sub(camera.position);
        const len = offset.length() || 1;
        // Positive yaw/pitch = drag right/down => view turns right/down.
        offset.applyAxisAngle(_up, -yaw);
        const polar = offset.angleTo(_up);
        const newPolar = Math.min(Math.PI - 0.05, Math.max(0.05, polar + pitch));
        _right.crossVectors(offset, _up);
        if (_right.lengthSq() > 1e-10) {
            _right.normalize();
            offset.applyAxisAngle(_right, polar - newPolar);
        }
        offset.setLength(len);
        orbit.target.copy(camera.position).add(offset);
        scheduleSave();
    }

    // Orbit the camera (position + view target) around a world-space pivot,
    // grab-the-world convention. The object stays fixed on screen.
    function rotateAroundPivot(pivot, yawInput, pitchInput) {
        const posOff = camera.position.clone().sub(pivot);
        if (posOff.lengthSq() < 1e-12) { rotateView(yawInput, pitchInput); return; }
        const tgtOff = orbit.target.clone().sub(pivot);
        const yawA = -yawInput;
        posOff.applyAxisAngle(_up, yawA);
        tgtOff.applyAxisAngle(_up, yawA);
        camera.getWorldDirection(_fwd);
        _fwd.applyAxisAngle(_up, yawA);
        _right.crossVectors(_fwd, _up);
        if (_right.lengthSq() > 1e-10) {
            _right.normalize();
            const polar = posOff.angleTo(_up);
            const newPolar = Math.min(Math.PI - 0.05, Math.max(0.05, polar - pitchInput));
            const a = newPolar - polar;
            posOff.applyAxisAngle(_right, a);
            tgtOff.applyAxisAngle(_right, a);
        }
        camera.position.copy(pivot).add(posOff);
        orbit.target.copy(pivot).add(tgtOff);
        scheduleSave();
    }

    function moveCamera(dt) {
        if (!keys.size) return;
        const speed = gs.moveSpeed * (gs.state.speed || 1) * (keys.has("shift") ? 4 : 1) * dt;
        camera.getWorldDirection(_fwd);
        _right.crossVectors(_fwd, _up).normalize();
        const delta = new THREE.Vector3();
        if (keys.has("w")) delta.addScaledVector(_fwd, speed);
        if (keys.has("s")) delta.addScaledVector(_fwd, -speed);
        if (keys.has("d")) delta.addScaledVector(_right, speed);
        if (keys.has("a")) delta.addScaledVector(_right, -speed);
        if (keys.has("e")) delta.addScaledVector(_up, speed);
        if (keys.has("q")) delta.addScaledVector(_up, -speed);
        if (delta.lengthSq() > 0) {
            camera.position.add(delta);
            orbit.target.add(delta);
        }
        // Arrow keys: rotate the view around the camera position
        // (left/up = negative, matching rotateView's drag-right=positive convention).
        const rot = 1.5 * dt;
        let yaw = 0, pitch = 0;
        if (keys.has("arrowleft")) yaw -= rot;
        if (keys.has("arrowright")) yaw += rot;
        if (keys.has("arrowup")) pitch -= rot;
        if (keys.has("arrowdown")) pitch += rot;
        if (yaw || pitch) rotateView(yaw, pitch);
        scheduleSave();
    }
    orbit.addEventListener("end", () => { syncStateFromView(); scheduleSave(); });

    // ---- sorting / render loop ---------------------------------------------------
    const _mv = new THREE.Matrix4();
    const _lastMV = new THREE.Matrix4().makeScale(0, 0, 0);
    let lastSortT = 0;
    function forceSort() { _lastMV.makeScale(0, 0, 0); }
    function sortIfNeeded() {
        if (!gs.splat) return;
        const now = performance.now();
        if (now - lastSortT < 200) return;
        camera.updateMatrixWorld();
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        gs.splat.updateMatrixWorld();
        _mv.multiplyMatrices(camera.matrixWorldInverse, gs.splat.matrixWorld);
        const a = _mv.elements, b = _lastMV.elements;
        let diff = 0;
        for (let i = 0; i < 16; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
        if (diff < 1e-4) return;
        gs.splat.sortForView(_mv);
        _lastMV.copy(_mv);
        lastSortT = now;
    }

    let lastW = 0, lastH = 0;
    function resizeIfNeeded() {
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (!w || !h || (w === lastW && h === lastH)) return;
        lastW = w; lastH = h;
        renderer.setSize(w, h, false);
        updateProjection();
    }

    let lastT = performance.now();
    function tick(t) {
        if (gs.disposed) return;
        requestAnimationFrame(tick);
        const dt = Math.min(0.1, (t - lastT) / 1000);
        lastT = t;
        if (!container.isConnected || container.offsetParent === null) return;
        if (gs.state.paused) return;
        resizeIfNeeded();
        if (!gs.renderingJob) {
            moveCamera(dt);
            orbit.update();
            syncStateFromView();
            sortIfNeeded();
        }
        updateSelectionBox();
        renderer.render(scene, camera);
    }
    requestAnimationFrame(tick);

    // ---- asset loading --------------------------------------------------------
    function defaultMeshMaterial() {
        return new THREE.MeshStandardMaterial({ color: 0xb8b8c8, roughness: 0.75, metalness: 0.05 });
    }

    async function loadMeshObject(path) {
        const resp = await api.fetchApi(viewURL(path), { cache: "no-store" });
        if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
        const ext = path.split(".").pop().toLowerCase();
        let obj;
        if (ext === "glb" || ext === "gltf") {
            const ab = await resp.arrayBuffer();
            const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
            obj = gltf.scene;
            // Pass sRGB textures through unchanged so meshes match the raw
            // (non color-managed) splat pipeline.
            obj.traverse((o) => {
                const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
                for (const m of mats) {
                    if (m.map) { m.map.colorSpace = THREE.NoColorSpace; m.needsUpdate = true; }
                }
            });
        } else if (ext === "obj") {
            obj = await loadOBJWithMaterials(await resp.text(), path, async (assetPath) => {
                const response = await api.fetchApi(viewURL(assetPath), { cache: "no-store" });
                if (!response.ok) throw new Error(`${assetPath}: HTTP ${response.status} (OBJ・MTL・画像を一緒に配置してください)`);
                return response;
            });
        } else if (ext === "stl") {
            const geo = new STLLoader().parse(await resp.arrayBuffer());
            geo.computeVertexNormals();
            obj = new THREE.Mesh(geo, defaultMeshMaterial());
        } else if (ext === "fbx") {
            obj = new FBXLoader().parse(await resp.arrayBuffer(), "");
            obj.traverse((o) => {
                if (!o.isMesh) return;
                if (Array.isArray(o.material)) {
                    o.material = o.material.map((m) => {
                        if (m?.map) { m.map.colorSpace = THREE.NoColorSpace; m.needsUpdate = true; return m; }
                        return defaultMeshMaterial();
                    });
                } else if (o.material?.map) {
                    o.material.map.colorSpace = THREE.NoColorSpace;
                    o.material.needsUpdate = true;
                } else {
                    o.material = defaultMeshMaterial();
                }
            });
        } else {
            throw new Error(`未対応のメッシュ形式: ${ext}`);
        }
        return obj;
    }

    function applyMeshTransform(group, t) {
        group.position.fromArray(t.pos);
        group.quaternion.fromArray(t.quat);
        group.scale.fromArray(t.scale);
        group.visible = t.hidden !== true;
    }

    // Place the geometry center at the scene center, even with an offset asset origin.
    function defaultMeshEntry(srcIndex) {
        const tpl = gs.meshTemplates[srcIndex];
        const bbox = new THREE.Box3().setFromObject(tpl);
        const size = bbox.getSize(new THREE.Vector3()).length() || 1;
        const s = (gs.bounds.radius * 0.5) / size;
        return {
            src: srcIndex,
            pos: gs.bounds.center.clone().addScaledVector(bbox.getCenter(new THREE.Vector3()), -s).toArray(),
            quat: [0, 0, 0, 1],
            scale: [s, s, s],
            hidden: false,
        };
    }

    // Ensure every loaded mesh file has at least one scene entry, and drop
    // entries pointing at files that no longer exist in the input chain.
    function reconcileMeshEntries() {
        let added = -1;
        gs.state.meshes = gs.state.meshes.filter(
            (m) => m && m.src >= 0 && m.src < gs.meshTemplates.length);
        for (let k = 0; k < gs.meshTemplates.length; k++) {
            if (!gs.state.meshes.some((m) => m.src === k)) {
                gs.state.meshes.push(defaultMeshEntry(k));
                added = gs.state.meshes.length - 1;
            }
        }
        return added;
    }

    // Rebuild viewport groups from state entries (duplicates clone templates).
    function rebuildMeshGroups() {
        tctrl.detach();
        for (const g of gs.meshGroups) root.remove(g);
        gs.meshGroups = [];
        for (const m of gs.state.meshes) {
            const tpl = gs.meshTemplates[m.src];
            const group = new THREE.Group();
            if (tpl) group.add(tpl.clone());
            applyMeshTransform(group, m);
            root.add(group);
            gs.meshGroups.push(group);
        }
        const i = gs.selectedMesh;
        if (i >= 0 && gs.meshGroups[i] && gs.state.meshes[i] && !gs.state.meshes[i].hidden) {
            tctrl.attach(gs.meshGroups[i]);
            refreshTransformPanel();
        } else if (i >= 0) {
            deselectMesh();
        }
        refreshMeshList();
        updateSelectionBox();
    }

    function disposeMeshTemplates(templates) {
        const resources = new Set();
        for (const tpl of templates) tpl.traverse((o) => {
            if (o.geometry) resources.add(o.geometry);
            const materials = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
            for (const m of materials) {
                resources.add(m);
                for (const value of Object.values(m)) if (value?.isTexture) resources.add(value);
            }
        });
        for (const resource of resources) resource.dispose();
    }

    async function doLoad(seq, gsPath, meshPaths) {
        try {
            if (gsPath !== gs.gsPathLoaded) {
                gs.gsPathLoaded = undefined;
                if (gs.splat) { root.remove(gs.splat); gs.splat.dispose(); gs.splat = null; }
                if (gsPath) {
                    setStatus(`3DGS 読み込み中: ${gsPath}`);
                    const ab = await fetchBinary(viewURL(gsPath), (recv, total) => {
                        const mb = (recv / 1048576).toFixed(1);
                        setStatus(total ? `3DGS 読み込み中: ${mb} / ${(total / 1048576).toFixed(1)} MB`
                                        : `3DGS 読み込み中: ${mb} MB`);
                    });
                    if (seq !== gs.seq || gs.disposed) return;
                    setStatus("3DGS 解析中…");
                    await new Promise((r) => setTimeout(r, 10)); // let status paint
                    const data = await parseGSFile(ab, gsPath);
                    if (seq !== gs.seq || gs.disposed) return;
                    gs.splat = new SplatMesh(data);
                    root.add(gs.splat);
                    gs.bounds = gs.splat.computeBounds();
                    gs.moveSpeed = gs.bounds.radius * 0.5;
                    grid.scale.setScalar(Math.max(0.1, gs.bounds.radius / 5));
                    if (!gs.state.cameras.length) {
                        createDefaultCamera();
                        refreshCameraUI();
                        applyActiveCameraToView();
                        scheduleSave();
                    } else {
                        applyActiveCameraToView();
                    }
                    forceSort();
                    setStatus(`3DGS: ${data.count.toLocaleString()} splats 読み込み完了`);
                }
                gs.gsPathLoaded = gsPath;
            }
            const meshKey = JSON.stringify(meshPaths);
            if (meshKey !== gs.meshKeyLoaded) {
                deselectMesh();
                const templates = [];
                try {
                    for (let k = 0; k < meshPaths.length; k++) {
                        setStatus(`メッシュ読み込み中: ${meshPaths[k]}`);
                        templates.push(await loadMeshObject(meshPaths[k]));
                        if (seq !== gs.seq || gs.disposed) {
                            disposeMeshTemplates(templates);
                            return;
                        }
                    }
                } catch (e) {
                    disposeMeshTemplates(templates);
                    throw e;
                }
                disposeMeshTemplates(gs.meshTemplates);
                gs.meshTemplates = templates;
                gs.meshKeyLoaded = meshKey;
                gs.meshPathsLoaded = meshPaths.slice();
                const added = reconcileMeshEntries();
                rebuildMeshGroups();
                if (added >= 0 && !gs.renderingJob) selectMesh(added);
                if (meshPaths.length) setStatus(`メッシュ ${meshPaths.length} 種読み込み完了。一覧で選択 →「選択へ移動」または F で場所を確認`);
                scheduleSave();
            }
        } catch (e) {
            setStatus(`読み込みエラー: ${e.message || e}`, true);
            throw e;
        }
    }

    let loadedKey = null;
    function reloadIfChanged(force) {
        if (gs.renderingJob || gs.disposed) return;
        const { gsPath, meshPaths } = collectModels(node);
        const key = JSON.stringify([gsPath, meshPaths]);
        if (!force && key === loadedKey) return;
        loadedKey = key;
        if (force) { gs.gsPathLoaded = undefined; gs.meshKeyLoaded = undefined; }
        const seq = ++gs.seq;
        gs.loadPromise = doLoad(seq, gsPath, meshPaths).catch(() => {
            if (seq === gs.seq) loadedKey = null; // Retry failed loads on the next poll.
        });
    }
    const pollTimer = setInterval(() => { if (!gs.disposed) reloadIfChanged(false); }, 1500);

    // ---- offscreen rendering for node execution ------------------------------
    gs.showBusy = (v) => { busy.style.display = v ? "flex" : "none"; };

    async function renderPayload(payload) {
        // Execution inputs are authoritative; refresh even when a file path is unchanged.
        const seq = ++gs.seq;
        await gs.loadPromise;
        if (gs.disposed) throw new Error("ノードは削除されました");
        gs.gsPathLoaded = undefined;
        gs.meshKeyLoaded = undefined;
        await doLoad(seq, payload.gs_model, payload.meshes || []);
        if (payload.scene_state?.cameras?.length) {
            gs.state = normalizeState(payload.scene_state);
            refreshCameraUI();
            applySceneOptions();
            if (gs.meshTemplates.length) {
                reconcileMeshEntries();
                rebuildMeshGroups();
            }
        }
        if (!gs.splat) throw new Error("3DGS モデルが読み込まれていません (Load 3DGS Model の接続とファイルを確認してください)");
        if (!gs.state.cameras.length) throw new Error("カメラがありません");

        const width = Math.min(8192, Math.max(8, payload.width | 0 || 1280));
        if (!gs.offscreen) {
            gs.offscreen = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
            gs.offscreen.outputColorSpace = THREE.LinearSRGBColorSpace;
        }
        const off = gs.offscreen;
        const prevGrid = grid.visible;
        const prevGizmo = tctrl.visible;
        const prevSelection = selectionBox.visible;
        grid.visible = false;
        tctrl.visible = false;
        selectionBox.visible = false;
        try {
            const blobs = [];
            const cam3 = new THREE.PerspectiveCamera();
            const target = new THREE.Vector3();
            const mv = new THREE.Matrix4();
            for (const c of gs.state.cameras) {
                const h = Math.max(8, Math.round(width / (c.aspect || 16 / 9)));
                off.setSize(width, h, false);
                cam3.fov = c.fov || 60;
                cam3.aspect = width / h;
                updateClipPlanes(cam3);
                cam3.position.fromArray(c.pos);
                cam3.up.set(0, 1, 0);
                cam3.lookAt(target.fromArray(c.target));
                cam3.updateProjectionMatrix();
                cam3.updateMatrixWorld(true);
                cam3.matrixWorldInverse.copy(cam3.matrixWorld).invert();
                gs.splat.updateMatrixWorld();
                mv.multiplyMatrices(cam3.matrixWorldInverse, gs.splat.matrixWorld);
                gs.splat.sortForView(mv);
                off.setClearColor(new THREE.Color(gs.state.bg || "#000000"), 1);
                off.render(scene, cam3);
                const blob = await new Promise((res) => off.domElement.toBlob(res, "image/png"));
                if (!blob) throw new Error("canvas.toBlob に失敗しました (解像度が大きすぎる可能性)");
                blobs.push(blob);
            }
            return blobs;
        } finally {
            grid.visible = prevGrid;
            tctrl.visible = prevGizmo;
            selectionBox.visible = prevSelection;
            forceSort();
        }
    }

    // Keep polling, view controls and concurrent requests out of the render transaction.
    gs.renderJob = async (payload) => {
        if (gs.renderingJob) throw new Error("このノードはレンダリング中です");
        gs.renderingJob = true;
        const previousInert = container.inert;
        const previousOrbit = orbit.enabled;
        const previousState = JSON.parse(JSON.stringify(gs.state));
        gs.editorState = previousState;
        container.inert = true;
        orbit.enabled = false;
        try {
            return await renderPayload(payload);
        } finally {
            gs.state = previousState;
            gs.editorState = null;
            if (!gs.disposed) {
                refreshCameraUI();
                applySceneOptions();
                applyActiveCameraToView();
                rebuildMeshGroups();
                scheduleSave();
            }
            container.inert = previousInert;
            orbit.enabled = previousOrbit;
            loadedKey = null; // Restore the current editor inputs after executing queued inputs.
            gs.renderingJob = false;
        }
    };

    // ---- lifecycle -------------------------------------------------------------
    function applyLoadedState() {
        try {
            gs.state = normalizeState(JSON.parse(stateWidget.value || "{}"));
        } catch (e) {
            gs.state = defaultState();
        }
        refreshCameraUI();
        applySceneOptions();
        applyActiveCameraToView();
        if (gs.meshTemplates.length) {
            reconcileMeshEntries();
            rebuildMeshGroups();
        }
    }
    applyLoadedState();

    const origConfigure = node.onConfigure;
    node.onConfigure = function () {
        origConfigure?.apply(this, arguments);
        applyLoadedState();
        setTimeout(() => reloadIfChanged(false), 50);
    };
    const origConnChange = node.onConnectionsChange;
    node.onConnectionsChange = function () {
        origConnChange?.apply(this, arguments);
        setTimeout(() => reloadIfChanged(false), 50);
    };
    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
        origRemoved?.apply(this, arguments);
        gs.disposed = true;
        clearInterval(pollTimer);
        clearTimeout(saveTimer);
        disposeMeshTemplates(gs.meshTemplates);
        selectionBox.geometry.dispose();
        selectionBox.material.dispose();
        tctrl.dispose?.();
        orbit.dispose();
        if (gs.splat) gs.splat.dispose();
        renderer.dispose();
        gs.offscreen?.dispose();
    };

    setTimeout(() => reloadIfChanged(false), 100);
}

// ---------------------------------------------------------------------------
// Render request from python
// ---------------------------------------------------------------------------

async function onRenderRequest(ev) {
    const d = ev.detail || {};
    const post = (query, body, isJson) => api.fetchApi(`/gs3d/render_result?${query}`, {
        method: "POST",
        headers: isJson ? { "Content-Type": "application/json" } : undefined,
        body,
    });
    let node = app.graph.getNodeById(Number(d.node_id));
    if (!node) node = app.graph.getNodeById(d.node_id);
    try {
        if (!node?.gs3d) {
            throw new Error("ブラウザ側に対象ノードが見つかりません。このワークフローを開いたタブでのみレンダリングできます。");
        }
        node.gs3d.showBusy(true);
        const blobs = await node.gs3d.renderJob(d);
        for (let i = 0; i < blobs.length; i++) {
            await post(`token=${encodeURIComponent(d.token)}&index=${i}&total=${blobs.length}`, blobs[i], false);
        }
    } catch (e) {
        console.error("[gs3d] render failed:", e);
        try {
            await post(`token=${encodeURIComponent(d.token)}`, JSON.stringify({ error: e.message || String(e) }), true);
        } catch (e2) { /* server unreachable */ }
    } finally {
        node?.gs3d?.showBusy?.(false);
    }
}

// ---------------------------------------------------------------------------
// Upload button on loader nodes
// ---------------------------------------------------------------------------

function addUploadButton(nodeType, kind) {
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        orig?.apply(this, arguments);
        const fileWidget = this.widgets?.find((w) => w.name === "file");
        this.addWidget("button", kind === "mesh" ? "📤 メッシュ・関連ファイルをアップロード" : "📤 ファイルをアップロード", null, () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = kind === "gs" ? ".ply,.splat,.sog" : ".glb,.gltf,.obj,.stl,.fbx,.mtl,.jpg,.jpeg,.png,.webp,.bmp";
            input.multiple = kind === "mesh";
            input.onchange = async () => {
                const f = input.files?.[0];
                if (!f) return;
                try {
                    const fd = new FormData();
                    const bundle = kind === "mesh" && input.files.length > 1;
                    if (bundle) {
                        const files = Array.from(input.files);
                        if (files.filter(file => /\.obj$/i.test(file.name)).length !== 1) {
                            throw new Error("OBJは1つだけ選び、MTLとテクスチャ画像を一緒に選択してください");
                        }
                        for (const file of files) fd.append("file", file);
                    } else fd.append("file", f);
                    const resp = await api.fetchApi(bundle ? "/gs3d/upload_obj" : "/gs3d/upload", { method: "POST", body: fd });
                    const data = await resp.json();
                    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
                    const list = await (await api.fetchApi(`/gs3d/list?kind=${kind}`)).json();
                    if (fileWidget) {
                        fileWidget.options.values = list.files;
                        fileWidget.value = data.name;
                        fileWidget.callback?.(data.name);
                    }
                    app.graph.setDirtyCanvas(true);
                } catch (e) {
                    alert(`アップロード失敗: ${e.message || e}`);
                }
            };
            input.click();
        });
    };
}

// ---------------------------------------------------------------------------

app.registerExtension({
    name: "gs3d.scene",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "GS3D_LoadSplat") addUploadButton(nodeType, "gs");
        if (nodeData.name === "GS3D_LoadMesh") addUploadButton(nodeType, "mesh");
        if (nodeData.name === "GS3D_SceneRender") {
            const orig = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                orig?.apply(this, arguments);
                setupViewport(this);
                this.setSize([Math.max(this.size[0], 540), Math.max(this.size[1], 620)]);
            };
        }
    },
    setup() {
        api.addEventListener("gs3d.render_request", onRenderRequest);
    },
});
