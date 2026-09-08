// Toshiki Hirano (Theoretical Hole Design), 2026
// 3D Gaussian Splatting renderer for three.js (WebGL2).
// Parses INRIA-format .ply (DC color only, no SH view dependence) and
// antimatter15-style .splat files, and renders them as depth-sorted
// instanced quads with EWA-projected 2D covariance.

import * as THREE from "../vendor/three.module.js";

const SH_C0 = 0.28209479177387814;
const TEX_WIDTH = 2048;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function covFromScaleRot(sx, sy, sz, qw, qx, qy, qz, covA, covC, i) {
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
    const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
    const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
    // M = R * diag(scale); covariance = M * M^T
    const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz;
    const m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
    const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;
    covA[i * 4 + 0] = m00 * m00 + m01 * m01 + m02 * m02; // xx
    covA[i * 4 + 1] = m00 * m10 + m01 * m11 + m02 * m12; // xy
    covA[i * 4 + 2] = m00 * m20 + m01 * m21 + m02 * m22; // xz
    covA[i * 4 + 3] = m10 * m10 + m11 * m11 + m12 * m12; // yy
    covC[i * 2 + 0] = m10 * m20 + m11 * m21 + m12 * m22; // yz
    covC[i * 2 + 1] = m20 * m20 + m21 * m21 + m22 * m22; // zz
}

function allocBuffers(count) {
    const pad = Math.max(1, Math.ceil(count / TEX_WIDTH)) * TEX_WIDTH;
    return {
        count,
        pad,
        centers: new Float32Array(pad * 4), // x,y,z,(unused)
        covA: new Float32Array(pad * 4),    // xx,xy,xz,yy
        covC: new Float32Array(pad * 2),    // yz,zz
        colors: new Uint8Array(pad * 4),    // rgba
    };
}

export async function parseGSFile(arrayBuffer, filename) {
    if (/\.splat$/i.test(filename || "")) return parseSplat(arrayBuffer);
    if (/\.sog$/i.test(filename || "")) return await parseSOG(arrayBuffer);
    return parsePLY(arrayBuffer);
}

const PLY_TYPE_SIZE = {
    float: 4, float32: 4, double: 8, float64: 8,
    int: 4, int32: 4, uint: 4, uint32: 4,
    short: 2, int16: 2, ushort: 2, uint16: 2,
    char: 1, int8: 1, uchar: 1, uint8: 1,
};

function parsePLY(ab) {
    const headBytes = new Uint8Array(ab, 0, Math.min(ab.byteLength, 65536));
    const headText = new TextDecoder("ascii").decode(headBytes);
    const endIdx = headText.indexOf("end_header");
    if (endIdx < 0) throw new Error("PLY: end_header が見つかりません");
    const dataOffset = headText.indexOf("\n", endIdx) + 1;
    const header = headText.slice(0, dataOffset);
    if (!/format\s+binary_little_endian/.test(header)) {
        throw new Error("PLY: binary_little_endian 形式のみ対応しています");
    }

    let count = 0;
    let inVertex = false;
    const props = [];
    for (const line of header.split("\n")) {
        const t = line.trim().split(/\s+/);
        if (t[0] === "element") {
            inVertex = t[1] === "vertex";
            if (inVertex) count = parseInt(t[2], 10);
        } else if (t[0] === "property" && inVertex) {
            if (t[1] === "list") throw new Error("PLY: list プロパティは非対応です");
            props.push({ type: t[1], name: t[2] });
        }
    }
    if (!count) throw new Error("PLY: vertex 要素がありません");

    let stride = 0;
    const offsets = {};
    let allFloat = true;
    for (const p of props) {
        offsets[p.name] = stride;
        const size = PLY_TYPE_SIZE[p.type] ?? 4;
        stride += size;
        if (p.type !== "float" && p.type !== "float32") allFloat = false;
    }
    const has = (n) => offsets[n] !== undefined;
    if (!has("x") || !has("y") || !has("z")) throw new Error("PLY: x/y/z がありません");

    const out = allocBuffers(count);
    const { centers, covA, covC, colors } = out;
    const isGS = has("scale_0") && has("rot_0") && has("opacity");
    const hasDC = has("f_dc_0");
    const hasRGB = has("red");

    // Fast path: all properties are float32 (standard 3DGS export).
    let readF;
    if (allFloat) {
        const body = new Float32Array(ab.slice(dataOffset, dataOffset + count * stride));
        const strideF = stride / 4;
        readF = (i, off) => body[i * strideF + off / 4];
    } else {
        const dv = new DataView(ab, dataOffset);
        const readers = {};
        for (const p of props) {
            readers[p.name] = { type: p.type, off: offsets[p.name] };
        }
        readF = (i, off, type) => {
            const byteOff = i * stride + off;
            switch (type) {
                case "float": case "float32": return dv.getFloat32(byteOff, true);
                case "double": case "float64": return dv.getFloat64(byteOff, true);
                case "uchar": case "uint8": return dv.getUint8(byteOff);
                case "char": case "int8": return dv.getInt8(byteOff);
                case "ushort": case "uint16": return dv.getUint16(byteOff, true);
                case "short": case "int16": return dv.getInt16(byteOff, true);
                case "uint": case "uint32": return dv.getUint32(byteOff, true);
                default: return dv.getInt32(byteOff, true);
            }
        };
    }
    const typeOf = {};
    for (const p of props) typeOf[p.name] = p.type;
    const rd = (i, name) => readF(i, offsets[name], typeOf[name]);

    const oX = offsets.x, oY = offsets.y, oZ = offsets.z;
    for (let i = 0; i < count; i++) {
        centers[i * 4 + 0] = allFloat ? readF(i, oX) : rd(i, "x");
        centers[i * 4 + 1] = allFloat ? readF(i, oY) : rd(i, "y");
        centers[i * 4 + 2] = allFloat ? readF(i, oZ) : rd(i, "z");

        let r = 128, g = 128, b = 128, a = 255;
        if (hasDC) {
            r = (0.5 + SH_C0 * rd(i, "f_dc_0")) * 255;
            g = (0.5 + SH_C0 * rd(i, "f_dc_1")) * 255;
            b = (0.5 + SH_C0 * rd(i, "f_dc_2")) * 255;
        } else if (hasRGB) {
            const scale = typeOf.red === "uchar" || typeOf.red === "uint8" ? 1 : 255;
            r = rd(i, "red") * scale;
            g = rd(i, "green") * scale;
            b = rd(i, "blue") * scale;
        }
        if (has("opacity")) a = 255 / (1 + Math.exp(-rd(i, "opacity")));
        colors[i * 4 + 0] = Math.max(0, Math.min(255, r));
        colors[i * 4 + 1] = Math.max(0, Math.min(255, g));
        colors[i * 4 + 2] = Math.max(0, Math.min(255, b));
        colors[i * 4 + 3] = Math.max(0, Math.min(255, a));

        if (isGS) {
            const sx = Math.exp(rd(i, "scale_0"));
            const sy = Math.exp(rd(i, "scale_1"));
            const sz = Math.exp(rd(i, "scale_2"));
            let qw = rd(i, "rot_0"), qx = rd(i, "rot_1"), qy = rd(i, "rot_2"), qz = rd(i, "rot_3");
            const qn = Math.hypot(qw, qx, qy, qz) || 1;
            qw /= qn; qx /= qn; qy /= qn; qz /= qn;
            covFromScaleRot(sx, sy, sz, qw, qx, qy, qz, covA, covC, i);
        } else {
            // Plain point cloud: small isotropic gaussians.
            const s = 0.01, v = s * s;
            covA[i * 4 + 0] = v; covA[i * 4 + 3] = v;
            covC[i * 2 + 1] = v;
        }
    }
    return out;
}

function parseSplat(ab) {
    const stride = 32;
    const count = Math.floor(ab.byteLength / stride);
    if (!count) throw new Error(".splat: データが空です");
    const f32 = new Float32Array(ab);
    const u8 = new Uint8Array(ab);
    const out = allocBuffers(count);
    const { centers, covA, covC, colors } = out;
    for (let i = 0; i < count; i++) {
        const fo = i * 8; // 8 floats per record
        const bo = i * 32;
        centers[i * 4 + 0] = f32[fo + 0];
        centers[i * 4 + 1] = f32[fo + 1];
        centers[i * 4 + 2] = f32[fo + 2];
        const sx = f32[fo + 3], sy = f32[fo + 4], sz = f32[fo + 5];
        colors[i * 4 + 0] = u8[bo + 24];
        colors[i * 4 + 1] = u8[bo + 25];
        colors[i * 4 + 2] = u8[bo + 26];
        colors[i * 4 + 3] = u8[bo + 27];
        let qw = (u8[bo + 28] - 128) / 128;
        let qx = (u8[bo + 29] - 128) / 128;
        let qy = (u8[bo + 30] - 128) / 128;
        let qz = (u8[bo + 31] - 128) / 128;
        const qn = Math.hypot(qw, qx, qy, qz) || 1;
        qw /= qn; qx /= qn; qy /= qn; qz /= qn;
        covFromScaleRot(sx, sy, sz, qw, qx, qy, qz, covA, covC, i);
    }
    return out;
}

// ---------------------------------------------------------------------------
// SOG (PlayCanvas Spatially Ordered Gaussians, v2) — ZIP bundle of
// meta.json + WebP images.
// ---------------------------------------------------------------------------

async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(ab) {
    const dv = new DataView(ab);
    const u8 = new Uint8Array(ab);
    let eocd = -1;
    const scanStart = Math.max(0, ab.byteLength - 65558);
    for (let i = ab.byteLength - 22; i >= scanStart; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("SOG: ZIP 形式ではありません");
    const num = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder();
    const entries = new Map();
    for (let i = 0; i < num; i++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("SOG: ZIP central directory が壊れています");
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const localOff = dv.getUint32(p + 42, true);
        const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const dataOff = localOff + 30 + lNameLen + lExtraLen;
        let data = u8.subarray(dataOff, dataOff + csize);
        if (method === 8) data = await inflateRaw(data);
        else if (method !== 0) throw new Error(`SOG: 未対応の ZIP 圧縮方式 (${method})`);
        entries.set(name, data);
        entries.set(name.split("/").pop(), data);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// Decode an image to raw RGBA via WebGL so alpha stays un-premultiplied
// (2D canvas readback corrupts RGB of low-alpha pixels).
let _readGL = null;
async function decodeImageExact(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes]), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
    });
    const w = bmp.width, h = bmp.height;
    if (!_readGL) {
        const cv = typeof OffscreenCanvas !== "undefined"
            ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
        _readGL = cv.getContext("webgl2");
        if (!_readGL) throw new Error("WebGL2 が利用できません");
    }
    const gl = _readGL;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    bmp.close();
    return { data: out, width: w, height: h };
}

const clamp255 = (v) => Math.max(0, Math.min(255, v));

async function parseSOG(ab) {
    const entries = await readZip(ab);
    const metaBytes = entries.get("meta.json");
    if (!metaBytes) throw new Error("SOG: meta.json が見つかりません");
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    if (meta.version !== undefined && meta.version !== 2) {
        throw new Error(`SOG: version ${meta.version} は未対応です (v2 のみ)`);
    }
    const count = meta.count | 0;
    if (!count) throw new Error("SOG: count がありません");
    const img = (name) => {
        const bytes = entries.get(name) ?? entries.get(name.split("/").pop());
        if (!bytes) throw new Error(`SOG: ${name} が見つかりません`);
        return decodeImageExact(bytes);
    };
    const meansFiles = meta.means?.files ?? ["means_l.webp", "means_u.webp"];
    const [mL, mU, qt, sc, s0] = await Promise.all([
        img(meansFiles[0]),
        img(meansFiles[1]),
        img((meta.quats?.files ?? ["quats.webp"])[0]),
        img((meta.scales?.files ?? ["scales.webp"])[0]),
        img((meta.sh0?.files ?? ["sh0.webp"])[0]),
    ]);
    if (mL.width * mL.height < count) throw new Error("SOG: 画像サイズが count に足りません");
    const mins = meta.means?.mins, maxs = meta.means?.maxs;
    if (!mins || !maxs) throw new Error("SOG: means の mins/maxs がありません");
    const scaleCB = meta.scales?.codebook;
    const shCB = meta.sh0?.codebook;
    if (!scaleCB || !shCB) throw new Error("SOG: codebook がありません (v2 形式のみ対応)");

    const out = allocBuffers(count);
    const { centers, covA, covC, colors } = out;
    const q = [0, 0, 0, 0]; // (w, x, y, z)
    for (let i = 0; i < count; i++) {
        const o = i * 4;
        // means: 16bit split, log-domain lerp, then unlog
        for (let c = 0; c < 3; c++) {
            const v16 = mL.data[o + c] | (mU.data[o + c] << 8);
            const n = mins[c] + (maxs[c] - mins[c]) * (v16 / 65535);
            centers[o + c] = Math.sign(n) * (Math.exp(Math.abs(n)) - 1);
        }
        // quats: 3 smallest components in (w,x,y,z) order, alpha = 252 + omitted index
        const mode = Math.min(3, Math.max(0, qt.data[o + 3] - 252));
        let sum = 0, j = 0;
        for (let k = 0; k < 4; k++) {
            if (k === mode) continue;
            const v = (qt.data[o + j] / 255 - 0.5) * Math.SQRT2;
            q[k] = v;
            sum += v * v;
            j++;
        }
        q[mode] = Math.sqrt(Math.max(0, 1 - sum));
        const sx = Math.exp(scaleCB[sc.data[o]]);
        const sy = Math.exp(scaleCB[sc.data[o + 1]]);
        const sz = Math.exp(scaleCB[sc.data[o + 2]]);
        covFromScaleRot(sx, sy, sz, q[0], q[1], q[2], q[3], covA, covC, i);
        // sh0: rgb = codebook indices, alpha = linear opacity
        colors[o + 0] = clamp255((0.5 + SH_C0 * shCB[s0.data[o + 0]]) * 255);
        colors[o + 1] = clamp255((0.5 + SH_C0 * shCB[s0.data[o + 1]]) * 255);
        colors[o + 2] = clamp255((0.5 + SH_C0 * shCB[s0.data[o + 2]]) * 255);
        colors[o + 3] = s0.data[o + 3];
    }
    return out;
}

// ---------------------------------------------------------------------------
// SplatMesh
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
uniform sampler2D uTexCenter;
uniform sampler2D uTexCov1;
uniform sampler2D uTexCov2;
uniform sampler2D uTexColor;
uniform vec2 uFocal;
uniform vec2 uViewport;
in float splatIndex;
out vec4 vColor;
out vec2 vPos;

void main() {
    int idx = int(splatIndex + 0.5);
    ivec2 tc = ivec2(idx & ${TEX_WIDTH - 1}, idx >> ${Math.log2(TEX_WIDTH)});
    vec3 center = texelFetch(uTexCenter, tc, 0).xyz;
    vec4 cam = modelViewMatrix * vec4(center, 1.0);
    vec4 clip = projectionMatrix * cam;
    float lim = 1.3 * clip.w;
    if (clip.z < -lim || clip.x < -lim || clip.x > lim || clip.y < -lim || clip.y > lim) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    vec4 c1 = texelFetch(uTexCov1, tc, 0);
    vec2 c2 = texelFetch(uTexCov2, tc, 0).rg;
    mat3 Vrk = mat3(c1.x, c1.y, c1.z,
                    c1.y, c1.w, c2.x,
                    c1.z, c2.x, c2.y);

    // Jacobian of the perspective projection (in y-up NDC pixels).
    float invZ = 1.0 / cam.z;
    mat3 J = mat3(
        -uFocal.x * invZ, 0.0, 0.0,
        0.0, -uFocal.y * invZ, 0.0,
        uFocal.x * cam.x * invZ * invZ, uFocal.y * cam.y * invZ * invZ, 0.0
    );
    mat3 T = J * mat3(modelViewMatrix);
    mat3 cov2d = T * Vrk * transpose(T);

    float cxx = cov2d[0][0] + 0.3;
    float cyy = cov2d[1][1] + 0.3;
    float cxy = cov2d[0][1];
    float mid = 0.5 * (cxx + cyy);
    float rad = length(vec2(0.5 * (cxx - cyy), cxy));
    float l1 = mid + rad;
    float l2 = mid - rad;
    if (l2 < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vec2 dir = (abs(cxy) < 1e-9)
        ? ((cxx >= cyy) ? vec2(1.0, 0.0) : vec2(0.0, 1.0))
        : normalize(vec2(cxy, l1 - cxx));
    vec2 major = min(sqrt(2.0 * l1), 1024.0) * dir;
    vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(dir.y, -dir.x);

    vColor = texelFetch(uTexColor, tc, 0);
    vPos = position.xy;
    vec2 ndcCenter = clip.xy / clip.w;
    vec2 offset = (position.x * major + position.y * minor) * 2.0 / uViewport;
    gl_Position = vec4(ndcCenter + offset, clip.z / clip.w, 1.0);
}
`;

const FRAG = /* glsl */ `
in vec4 vColor;
in vec2 vPos;
out vec4 fragColor;

void main() {
    float a = -dot(vPos, vPos);
    if (a < -4.0) discard;
    float alpha = exp(a) * vColor.a;
    fragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

function makeDataTexture(data, pad, format, type) {
    const tex = new THREE.DataTexture(data, TEX_WIDTH, pad / TEX_WIDTH, format, type);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

export class SplatMesh extends THREE.Mesh {
    constructor(data) {
        const { count, pad, centers, covA, covC, colors } = data;

        const geometry = new THREE.InstancedBufferGeometry();
        geometry.instanceCount = count;
        const quad = new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]);
        geometry.setAttribute("position", new THREE.BufferAttribute(quad, 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        const order = new Float32Array(count);
        for (let i = 0; i < count; i++) order[i] = i;
        const idxAttr = new THREE.InstancedBufferAttribute(order, 1);
        idxAttr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute("splatIndex", idxAttr);

        const material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            uniforms: {
                uTexCenter: { value: makeDataTexture(centers, pad, THREE.RGBAFormat, THREE.FloatType) },
                uTexCov1: { value: makeDataTexture(covA, pad, THREE.RGBAFormat, THREE.FloatType) },
                uTexCov2: { value: makeDataTexture(covC, pad, THREE.RGFormat, THREE.FloatType) },
                uTexColor: { value: makeDataTexture(colors, pad, THREE.RGBAFormat, THREE.UnsignedByteType) },
                uFocal: { value: new THREE.Vector2(1000, 1000) },
                uViewport: { value: new THREE.Vector2(1024, 768) },
            },
            vertexShader: VERT,
            fragmentShader: FRAG,
            transparent: true,
            depthTest: true,
            depthWrite: false,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
            side: THREE.DoubleSide,
            toneMapped: false,
        });

        super(geometry, material);
        this.frustumCulled = false;
        this.renderOrder = 100;
        this.splatCount = count;
        this.centers = centers;
        this._depths = new Float32Array(count);
        this._keys = new Uint32Array(count);
        this._counts = new Uint32Array(65536);

        const size = new THREE.Vector2();
        this.onBeforeRender = (renderer, _scene, camera) => {
            renderer.getDrawingBufferSize(size);
            const u = this.material.uniforms;
            u.uViewport.value.copy(size);
            u.uFocal.value.set(
                camera.projectionMatrix.elements[0] * size.x * 0.5,
                camera.projectionMatrix.elements[5] * size.y * 0.5,
            );
        };
    }

    // Disable raycasting (used for mesh picking only).
    raycast() {}

    // Back-to-front counting sort for the given model-view matrix.
    sortForView(modelViewMatrix) {
        const e = modelViewMatrix.elements;
        const zx = e[2], zy = e[6], zz = e[10];
        const n = this.splatCount;
        const c = this.centers;
        const depths = this._depths;
        const keys = this._keys;
        const counts = this._counts;

        let min = Infinity, max = -Infinity;
        for (let i = 0; i < n; i++) {
            const d = zx * c[i * 4] + zy * c[i * 4 + 1] + zz * c[i * 4 + 2];
            depths[i] = d;
            if (d < min) min = d;
            if (d > max) max = d;
        }
        const inv = 65535 / (max - min || 1);
        counts.fill(0);
        for (let i = 0; i < n; i++) {
            const k = ((depths[i] - min) * inv) | 0;
            keys[i] = k;
            counts[k]++;
        }
        let acc = 0;
        for (let k = 0; k < 65536; k++) {
            const cnt = counts[k];
            counts[k] = acc;
            acc += cnt;
        }
        const attr = this.geometry.getAttribute("splatIndex");
        const out = attr.array;
        for (let i = 0; i < n; i++) {
            out[counts[keys[i]]++] = i;
        }
        attr.needsUpdate = true;
    }

    // Approximate scene center / radius (mean + 2x RMS deviation), sampled.
    computeBounds() {
        const n = this.splatCount;
        const c = this.centers;
        const step = Math.max(1, Math.floor(n / 20000));
        let cx = 0, cy = 0, cz = 0, m = 0;
        for (let i = 0; i < n; i += step) {
            cx += c[i * 4]; cy += c[i * 4 + 1]; cz += c[i * 4 + 2]; m++;
        }
        cx /= m; cy /= m; cz /= m;
        let dev = 0;
        for (let i = 0; i < n; i += step) {
            const dx = c[i * 4] - cx, dy = c[i * 4 + 1] - cy, dz = c[i * 4 + 2] - cz;
            dev += dx * dx + dy * dy + dz * dz;
        }
        const radius = Math.max(1e-3, 2 * Math.sqrt(dev / m));
        return { center: new THREE.Vector3(cx, cy, cz), radius };
    }

    dispose() {
        this.geometry.dispose();
        for (const u of Object.values(this.material.uniforms)) {
            if (u.value && u.value.isTexture) u.value.dispose();
        }
        this.material.dispose();
    }
}
