const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/js/gs3d.js'), 'utf8');

// Execute the production loading/render functions, substituting only browser/GPU APIs.
function harness() {
    const calls = [];
    const noop = () => {};
    class Vector { fromArray() { return this; } set() {} }
    class Matrix { copy() { return this; } invert() { return this; } multiplyMatrices() {} }
    class Camera {
        position = new Vector(); up = new Vector(); matrixWorldInverse = new Matrix();
        lookAt() {} updateProjectionMatrix() {} updateMatrixWorld() {}
    }
    const gs = {
        seq: 0, state: { cameras: [{ pos: [0,0,5], target: [0,0,0], aspect: 1 }], meshes: [] },
        meshTemplates: [], loadPromise: Promise.resolve(), disposed: false,
    };
    const ctx = {
        gs, node: {}, calls, console, Promise, setTimeout, setInterval: noop,
        container: { inert: false }, orbit: { enabled: true },
        grid: { visible: true, scale: { setScalar: noop } }, tctrl: { visible: true },
        selectionBox: { visible: true }, busy: { style: {} }, root: { add: noop, remove: noop }, scene: {},
        editor: { gsPath: 'editor.ply', meshPaths: [] },
        collectModels: () => ctx.editor,
        viewURL: x => x,
        fetchBinary: async x => { calls.push(['gs', x]); return x; },
        parseGSFile: async data => ({ count: 1, data }),
        loadMeshObject: async x => { calls.push(['mesh', x]); return { path: x, traverse: noop }; },
        SplatMesh: class {
            constructor(data) { this.data = data; }
            computeBounds() { return { radius: 1 }; }
            dispose() {} updateMatrixWorld() {} sortForView() {}
        },
        THREE: {
            PerspectiveCamera: Camera, Vector3: Vector, Matrix4: Matrix, Color: class {},
            WebGLRenderer: class {
                domElement = { toBlob: cb => cb({ model: gs.splat.data.data }) };
                setSize() {} setClearColor() {} render() { assert.equal(ctx.selectionBox.visible, false); calls.push(['render', gs.splat.data.data]); }
            },
        },
        normalizeState: s => JSON.parse(JSON.stringify(s)),
    };
    for (const name of ['setStatus', 'createDefaultCamera', 'refreshCameraUI', 'applyActiveCameraToView',
        'scheduleSave', 'forceSort', 'deselectMesh', 'reconcileMeshEntries', 'rebuildMeshGroups',
        'applySceneOptions', 'updateClipPlanes']) ctx[name] = noop;
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('    function disposeMeshTemplates('),
        source.indexOf('    // ---- lifecycle')), ctx);
    return ctx;
}

const payload = (model = 'queued.ply') => ({ gs_model: model, meshes: ['queued.glb'], width: 512,
    scene_state: { cameras: [{ pos: [1,2,3], target: [0,0,0], aspect: 1 }], meshes: [] } });

test('failed model load is retried by normal polling', async () => {
    const h = harness();
    let attempts = 0;
    h.fetchBinary = async x => { if (++attempts === 1) throw Error('network'); return x; };
    h.reloadIfChanged(false); await h.gs.loadPromise;
    assert.equal(h.gs.gsPathLoaded, undefined);
    h.reloadIfChanged(false); await h.gs.loadPromise;
    assert.equal(attempts, 2);
    assert.equal(h.gs.gsPathLoaded, 'editor.ply');
});

test('changing mesh connections during a pending splat load does not lose the splat', async () => {
    const h = harness();
    let release;
    h.fetchBinary = x => new Promise(resolve => { release = () => resolve(x); });
    h.reloadIfChanged(false);
    const oldLoad = h.gs.loadPromise;
    const releaseOld = release;
    h.editor.meshPaths = ['new.glb'];
    h.reloadIfChanged(false);
    releaseOld(); await oldLoad;
    release(); await h.gs.loadPromise;
    assert.equal(h.gs.gsPathLoaded, 'editor.ply');
    assert.ok(h.gs.splat);
    assert.equal(h.gs.meshTemplates[0].path, 'new.glb');
});

test('returning to a previous path after another load fails reloads the disposed model', async () => {
    const h = harness();
    h.reloadIfChanged(false); await h.gs.loadPromise;
    const original = h.fetchBinary;
    h.fetchBinary = async x => { if (x === 'bad.ply') throw Error('bad'); return original(x); };
    h.editor.gsPath = 'bad.ply'; h.reloadIfChanged(false); await h.gs.loadPromise;
    h.editor.gsPath = 'editor.ply'; h.reloadIfChanged(false); await h.gs.loadPromise;
    assert.equal(h.gs.splat.data.data, 'editor.ply');
});

test('queued inputs override editor selections and same-path files refresh on each execution', async () => {
    const h = harness();
    const before = JSON.stringify(h.gs.state);
    await h.gs.renderJob(payload());
    await h.gs.renderJob(payload());
    assert.equal(h.calls.filter(([type, name]) => type === 'gs' && name === 'queued.ply').length, 2);
    assert.equal(h.calls.filter(([type, name]) => type === 'mesh' && name === 'queued.glb').length, 2);
    assert.equal(h.calls.filter(([type]) => type === 'render').length, 2);
    assert.equal(h.calls.some(([,name]) => name === 'editor.ply'), false);
    assert.equal(JSON.stringify(h.gs.state), before);
    assert.equal(h.gs.renderingJob, false);
    assert.equal(h.container.inert, false);
});

test('mesh failure rejects execution, then recovers on retry', async () => {
    const h = harness();
    const original = h.loadMeshObject;
    h.loadMeshObject = async () => { throw Error('mesh failure'); };
    await assert.rejects(h.gs.renderJob(payload()), /mesh failure/);
    assert.equal(h.gs.renderingJob, false);
    assert.equal(h.orbit.enabled, true);
    assert.equal(h.calls.some(([type]) => type === 'render'), false);
    h.loadMeshObject = original;
    await h.gs.renderJob(payload());
    assert.equal(h.calls.some(([type]) => type === 'render'), true);
});

test('polling and concurrent requests cannot replace models during execution', async () => {
    const h = harness();
    let release;
    h.fetchBinary = x => new Promise(resolve => { release = () => resolve(x); });
    const pending = h.gs.renderJob(payload());
    await Promise.resolve();
    const seq = h.gs.seq;
    h.reloadIfChanged(true);
    assert.equal(h.gs.seq, seq);
    await assert.rejects(h.gs.renderJob(payload('other.ply')), /レンダリング中/);
    release(); await pending;
    assert.equal(h.gs.splat.data.data, 'queued.ply');
});
