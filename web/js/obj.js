// Toshiki Hirano (Theoretical Hole Design), 2026
import * as THREE from "../vendor/three.module.js";
import { OBJLoader } from "../vendor/addons/OBJLoader.js";
import { MTLLoader } from "../vendor/addons/MTLLoader.js";

// References are resolved inside ComfyUI/input, never against the page or remote hosts.
export function resolveOBJAsset(baseFile, reference) {
    const rel = reference.trim().replace(/^(["'])(.*)\1$/, "$2").replace(/\\/g, "/");
    if (!rel || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(rel)) {
        throw new Error(`OBJ/MTL: 相対パスを使用してください: ${reference}`);
    }
    const parts = baseFile.split("/").slice(0, -1);
    for (const part of rel.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (!parts.length) throw new Error(`OBJ/MTL: input の外は参照できません: ${reference}`);
            parts.pop();
        } else parts.push(part);
    }
    return parts.join("/");
}

export function materialLibraries(text) {
    const paths = [];
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*mtllib\s+(.+?)\s*$/i.exec(line);
        if (!match) continue;
        // Support both filenames containing spaces and multiple .mtl references.
        const names = match[1].match(/"[^"]+"|'[^']+'|[^"']+?\.mtl(?=\s|$)/gi);
        if (!names) throw new Error(`OBJ: mtllib を解釈できません: ${match[1]}`);
        paths.push(...names.map(name => name.trim()));
    }
    return [...new Set(paths)];
}

export function normalizeOBJMaterials(creator) {
    for (const info of Object.values(creator.materialsInfo)) {
        // RealityCapture may export RGB normal maps with the map_Bump keyword.
        for (const key of ["map_bump", "bump"]) {
            if (info[key] && !info.norm && /(?:^|[\/\\_\s-])normal(?:[_.\s-]|$)/i.test(info[key])) {
                info.norm = info[key];
                delete info[key];
            }
        }
    }
}

export async function loadOBJWithMaterials(text, objPath, fetchAsset) {
    const creators = [];
    const textures = [];
    const pending = [];
    let object;
    try {
        for (const name of materialLibraries(text)) {
            const mtlPath = resolveOBJAsset(objPath, name);
            const response = await fetchAsset(mtlPath);
            const creator = new MTLLoader().parse((await response.text()).replace(/\t/g, " "), "");
            normalizeOBJMaterials(creator);
            creator.loadTexture = (url) => {
                const texture = new THREE.Texture();
                textures.push(texture);
                pending.push((async () => {
                    const assetPath = resolveOBJAsset(mtlPath, url);
                    const resp = await fetchAsset(assetPath);
                    const blobURL = URL.createObjectURL(await resp.blob());
                    try {
                        texture.image = await new Promise((resolve, reject) => {
                            const image = new Image();
                            image.onload = () => resolve(image);
                            image.onerror = () => reject(new Error(`画像を読み込めません: ${assetPath}`));
                            image.src = blobURL;
                        });
                        texture.needsUpdate = true;
                    } finally {
                        URL.revokeObjectURL(blobURL);
                    }
                })());
                return texture;
            };
            creators.push(creator);
        }
        const loader = new OBJLoader();
        if (creators.length) loader.setMaterials({
            create(name) {
                const creator = [...creators].reverse().find(c => Object.hasOwn(c.materialsInfo, name));
                if (!creator) throw new Error(`MTL に材質がありません: ${name}`);
                return creator.create(name);
            },
        });
        object = loader.parse(text);
        const results = await Promise.allSettled(pending);
        const failed = results.find(r => r.status === "rejected");
        if (failed) throw failed.reason;
        // Match the existing splat / GLB pipeline's raw color handling.
        object.traverse(o => {
            const materials = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
            for (const material of materials) {
                if (material.map) material.map.colorSpace = THREE.NoColorSpace;
            }
        });
        return object;
    } catch (error) {
        await Promise.allSettled(pending);
        for (const texture of textures) texture.dispose();
        for (const creator of creators) for (const material of Object.values(creator.materials)) material.dispose();
        object?.traverse(o => o.geometry?.dispose());
        throw error;
    }
}
