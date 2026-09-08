const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/js/gs3d.js'), 'utf8');
const threeCode = fs.readFileSync(path.join(__dirname, '../web/vendor/three.module.js'));
const threeReady = import(`data:text/javascript;base64,${threeCode.toString('base64')}`);

test('Z/X adjust and clamp speed; 1/2/3 switch gizmo modes', () => {
    const handlers = {}, modes = [];
    let saved = 0;
    const ctx = vm.createContext({
        gs: { state: { speed: 0.1 } },
        speedSlider: { addEventListener() {} }, speedVal: {},
        scheduleSave: () => saved++, setGizmoMode: mode => modes.push(mode),
        wrap: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    });
    vm.runInContext(source.slice(source.indexOf('    function setMoveSpeed('),
        source.indexOf('    const onSunInput')), ctx);
    vm.runInContext(source.slice(source.indexOf('    const keys = new Set();'),
        source.indexOf('    const _fwd =')), ctx);
    const press = (key, extra = {}) => handlers.keydown({
        key, preventDefault() {}, stopPropagation() {}, ...extra,
    });
    press('z'); assert.ok(ctx.gs.state.speed < 0.1);
    press('x'); assert.ok(Math.abs(ctx.gs.state.speed - 0.1) < 1e-12);
    assert.ok(Math.abs(Number(ctx.speedSlider.value) + 1) < 1e-12);
    press('z', { ctrlKey: true }); press('x', { metaKey: true });
    assert.equal(saved, 2);
    for (let i = 0; i < 100; i++) press('z');
    assert.equal(ctx.gs.state.speed, 0.001);
    for (let i = 0; i < 100; i++) press('x');
    assert.equal(ctx.gs.state.speed, 10);
    for (const key of ['1', '2', '3']) press(key);
    assert.deepEqual(modes, ['translate', 'rotate', 'scale']);
});

test('slow movement settings survive workflow normalization', () => {
    const ctx = vm.createContext({});
    vm.runInContext(source.slice(source.indexOf('function defaultState()'),
        source.indexOf('// 35mm full-frame')), ctx);
    assert.equal(ctx.defaultState().speed, 0.1);
    for (const speed of [0.001, 0.01, 0.1, 1, 10]) {
        assert.equal(ctx.normalizeState({ speed }).speed, speed);
    }
    assert.equal(ctx.normalizeState({ speed: Infinity }).speed, 0.1);
});

test('offset mesh geometry is centered in the scene, including the flip transform', async () => {
    const THREE = await threeReady;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    mesh.geometry.translate(1000, -500, 200);
    mesh.position.set(30, 20, -40);
    const center = new THREE.Vector3(7, 12, -18);
    const gs = { meshTemplates: [mesh], bounds: { center, radius: 20 }, state: { meshes: [] } };
    const ctx = vm.createContext({ THREE, gs });
    vm.runInContext(source.slice(source.indexOf('    function defaultMeshEntry('),
        source.indexOf('    // Rebuild viewport groups')), ctx);
    const entry = ctx.defaultMeshEntry(0);
    const group = new THREE.Group();
    group.add(mesh.clone());
    group.position.fromArray(entry.pos);
    group.scale.fromArray(entry.scale);
    const root = new THREE.Group(); root.add(group);
    for (const flip of [false, true]) {
        root.rotation.x = flip ? Math.PI : 0;
        root.updateMatrixWorld(true);
        const actual = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
        const expected = root.localToWorld(center.clone());
        assert.ok(actual.distanceTo(expected) < 1e-9);
    }
    // Previously saved transforms must not be repositioned by reconciliation.
    gs.state.meshes = [{ src: 0, pos: [1, 2, 3], hidden: true }];
    assert.equal(ctx.reconcileMeshEntries(), -1);
    assert.deepEqual(gs.state.meshes[0].pos, [1, 2, 3]);
});

for (const aspect of [16 / 9, 9 / 16]) {
    test(`focus fits a distant transformed mesh inside a ${aspect} camera`, async () => {
        const THREE = await threeReady;
        const root = new THREE.Group(); root.rotation.x = Math.PI;
        const group = new THREE.Mesh(new THREE.BoxGeometry(3, 7, 2));
        group.position.set(80, 40, -100); group.scale.set(2, 1, 4);
        root.add(group);
        const camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 10000);
        camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
        const target = new THREE.Vector3();
        const noop = () => {};
        const ctx = vm.createContext({ THREE, root, camera,
            gs: { selectedMesh: 0, meshGroups: [group], state: { paused: true } },
            activeCam: () => ({ fov: 40, aspect }),
            orbit: { target, update: () => { camera.lookAt(target); camera.updateMatrixWorld(true); } },
            updateProjection: noop, applySceneOptions: noop, syncStateFromView: noop,
            scheduleSave: noop, forceSort: noop, updateSelectionBox: noop, setStatus: noop,
            wrap: { focus: noop },
        });
        vm.runInContext(source.slice(source.indexOf('    function focusSelectedMesh('),
            source.indexOf('    meshSelect.addEventListener')), ctx);
        ctx.focusSelectedMesh();
        const box = new THREE.Box3().setFromObject(group);
        assert.ok(target.distanceTo(box.getCenter(new THREE.Vector3())) < 1e-9);
        for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) {
            for (const z of [box.min.z, box.max.z]) {
                const point = new THREE.Vector3(x, y, z).project(camera);
                assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1);
                assert.ok(point.z > -1 && point.z < 1);
            }
        }
        assert.equal(ctx.gs.state.paused, false);
    });
}
