const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const threeURL = url(fs.readFileSync(path.join(root, 'web/vendor/three.module.js')));
const loaderURL = name => url(fs.readFileSync(path.join(root, `web/vendor/addons/${name}.js`), 'utf8')
    .replace(/(['"])\.\.\/three\.module\.js\1/g, JSON.stringify(threeURL)));
const objURL = url(fs.readFileSync(path.join(root, 'web/js/obj.js'), 'utf8')
    .replace('"../vendor/three.module.js"', JSON.stringify(threeURL))
    .replace('"../vendor/addons/OBJLoader.js"', JSON.stringify(loaderURL('OBJLoader')))
    .replace('"../vendor/addons/MTLLoader.js"', JSON.stringify(loaderURL('MTLLoader'))));
const ready = import(objURL);
// Image decoding is mocked, while real OBJ/MTL/three.js parsers and textures run.
global.Image = class { set src(value) { queueMicrotask(() => this.onload()); } };
const obj = 'mtllib Test2.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl material\nf 1/1 2/2 3/3\n';
const mtl = 'newmtl material\nKd 1 1 1\nmap_Kd tex_u1_v1_diffuse.jpg\nmap_Bump tex_u1_v1_normal.jpg\n';

test('loads diffuse and RealityCapture-style normal textures and retains UVs', async () => {
    const { loadOBJWithMaterials } = await ready;
    const requested = [];
    const mesh = await loadOBJWithMaterials(obj, '3d/bundle/Test2.obj', async name => {
        requested.push(name);
        return new Response(name.endsWith('.mtl') ? mtl : 'image bytes');
    });
    const material = mesh.children[0].material;
    assert.ok(material.map.image);
    assert.ok(material.normalMap.image);
    assert.equal(material.bumpMap, null);
    assert.equal(mesh.children[0].geometry.attributes.uv.count, 3);
    assert.deepEqual(requested.sort(), ['3d/bundle/Test2.mtl',
        '3d/bundle/tex_u1_v1_diffuse.jpg', '3d/bundle/tex_u1_v1_normal.jpg'].sort());
});

test('keeps real height maps as bump maps', async () => {
    const { loadOBJWithMaterials } = await ready;
    const result = await loadOBJWithMaterials(obj, 'Test2.obj', async name =>
        new Response(name.endsWith('.mtl') ? mtl.replace('tex_u1_v1_normal', 'height') : 'bytes'));
    assert.ok(result.children[0].material.bumpMap);
    assert.equal(result.children[0].material.normalMap, null);
});

test('missing texture fails instead of producing an untextured success', async () => {
    const { loadOBJWithMaterials } = await ready;
    await assert.rejects(loadOBJWithMaterials(obj, 'Test2.obj', async name => {
        if (name.endsWith('.mtl')) return new Response(mtl);
        throw new Error(`missing: ${name}`);
    }), /missing/);
});

test('OBJ without MTL still loads', async () => {
    const { loadOBJWithMaterials } = await ready;
    const result = await loadOBJWithMaterials(obj.replace('mtllib Test2.mtl\n', ''), 'plain.obj',
        () => { throw Error('unexpected fetch'); });
    assert.equal(result.children[0].geometry.attributes.position.count, 3);
});

test('relative directories and spaced MTL names resolve without remote requests', async () => {
    const { materialLibraries, resolveOBJAsset } = await ready;
    assert.deepEqual(materialLibraries('mtllib My Material.mtl other.mtl'), ['My Material.mtl', 'other.mtl']);
    assert.equal(resolveOBJAsset('3d/mtl/a.mtl', '../tex/image.jpg'), '3d/tex/image.jpg');
    for (const name of ['../../x', 'https://example.com/a.jpg', 'C:\\x.jpg', '/x.jpg']) {
        assert.throws(() => resolveOBJAsset('3d/a.mtl', name));
    }
});

test('provided OBJ sample binds its real MTL and both textures', { skip: !process.env.GS3D_OBJ_SAMPLE }, async () => {
    const { loadOBJWithMaterials } = await ready;
    const sample = process.env.GS3D_OBJ_SAMPLE;
    const model = await loadOBJWithMaterials(fs.readFileSync(sample, 'utf8'), path.basename(sample), async name =>
        new Response(fs.readFileSync(path.join(path.dirname(sample), name))));
    let vertices = 0;
    model.traverse(o => {
        if (!o.isMesh) return;
        vertices += o.geometry.attributes.position.count;
        assert.ok(o.geometry.attributes.uv);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of mats) { assert.ok(material.map.image); assert.ok(material.normalMap.image); }
    });
    assert.ok(vertices > 0);
});
