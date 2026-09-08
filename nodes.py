# Toshiki Hirano (Theoretical Hole Design), 2026
"""3DGS (3D Gaussian Splatting) viewer / multi-camera renderer nodes for ComfyUI.

Rendering happens in the browser (WebGL) for WYSIWYG output: the node sends a
render request to the connected ComfyUI tab, which renders each camera view
offscreen and posts the PNGs back.
"""

import io
import json
import os
import threading
import tempfile
import uuid

import numpy as np
import torch
from PIL import Image
from aiohttp import web

import folder_paths
from server import PromptServer

GS_EXTENSIONS = {".ply", ".splat", ".sog"}
MESH_EXTENSIONS = {".glb", ".gltf", ".obj", ".stl", ".fbx"}
UPLOAD_SUBDIR = "3d"


def _list_input_files(extensions):
    base = folder_paths.get_input_directory()
    found = []
    for root, _dirs, files in os.walk(base, followlinks=True):
        rel_root = os.path.relpath(root, base)
        for name in files:
            if os.path.splitext(name)[1].lower() not in extensions:
                continue
            rel = name if rel_root == "." else os.path.join(rel_root, name)
            found.append(rel.replace("\\", "/"))
    return sorted(found, key=str.lower)


def _resolve_input_path(rel):
    base = os.path.abspath(folder_paths.get_input_directory())
    path = os.path.abspath(os.path.join(base, rel))
    try:
        if os.path.commonpath([base, path]) != base:
            raise ValueError
    except ValueError:
        raise ValueError(f"invalid path: {rel}")
    return path


# --------------------------------------------------------------------------
# Render job broker: execution thread waits, aiohttp handler resolves.
# --------------------------------------------------------------------------

class _RenderJob:
    def __init__(self):
        self.event = threading.Event()
        self.images = {}
        self.total = None
        self.error = None


class _RenderBroker:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs = {}

    def create(self, token):
        with self._lock:
            self._jobs[token] = _RenderJob()
            return self._jobs[token]

    def get(self, token):
        with self._lock:
            return self._jobs.get(token)

    def discard(self, token):
        with self._lock:
            self._jobs.pop(token, None)


BROKER = _RenderBroker()

routes = PromptServer.instance.routes


@routes.get("/gs3d/list")
async def _gs3d_list(request):
    kind = request.query.get("kind", "gs")
    exts = GS_EXTENSIONS if kind == "gs" else MESH_EXTENSIONS
    return web.json_response({"files": _list_input_files(exts)})


@routes.post("/gs3d/upload")
async def _gs3d_upload(request):
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "file":
        field = await reader.next()
    if field is None:
        return web.json_response({"error": "no file field"}, status=400)
    filename = os.path.basename(field.filename or "")
    ext = os.path.splitext(filename)[1].lower()
    if not filename or ext not in (GS_EXTENSIONS | MESH_EXTENSIONS):
        return web.json_response({"error": f"unsupported file type: {ext}"}, status=400)
    dest_dir = os.path.join(folder_paths.get_input_directory(), UPLOAD_SUBDIR)
    os.makedirs(dest_dir, exist_ok=True)
    stem = os.path.splitext(filename)[0]
    dest = os.path.join(dest_dir, filename)
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(dest_dir, f"{stem}_{n}{ext}")
        n += 1
    with open(dest, "wb") as f:
        while True:
            chunk = await field.read_chunk(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    rel = os.path.relpath(dest, folder_paths.get_input_directory()).replace("\\", "/")
    return web.json_response({"name": rel})


@routes.post("/gs3d/upload_obj")
async def _gs3d_upload_obj(request):
    """Keep related filenames intact in a separate directory for each upload."""
    dest_dir = os.path.join(folder_paths.get_input_directory(), UPLOAD_SUBDIR)
    os.makedirs(dest_dir, exist_ok=True)
    allowed = {".obj", ".mtl", ".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    seen = set()
    models = []
    with tempfile.TemporaryDirectory(prefix=".obj-upload-", dir=dest_dir) as staging:
        reader = await request.multipart()
        async for field in reader:
            if field.name != "file":
                continue
            name = field.filename or ""
            ext = os.path.splitext(name)[1].lower()
            if not name or any(c in name for c in '/\\:') or ext not in allowed:
                return web.json_response({"error": f"invalid OBJ bundle filename: {name}"}, status=400)
            if name.casefold() in seen:
                return web.json_response({"error": f"duplicate filename: {name}"}, status=400)
            seen.add(name.casefold())
            if ext == ".obj":
                models.append(name)
            with open(os.path.join(staging, name), "xb") as output:
                while True:
                    chunk = await field.read_chunk(1 << 20)
                    if not chunk:
                        break
                    output.write(chunk)
        if len(models) != 1:
            return web.json_response({"error": "select exactly one OBJ plus its MTL and textures"}, status=400)
        directory = "obj_" + uuid.uuid4().hex
        os.rename(staging, os.path.join(dest_dir, directory))
    return web.json_response({"name": f"{UPLOAD_SUBDIR}/{directory}/{models[0]}"})


@routes.post("/gs3d/render_result")
async def _gs3d_render_result(request):
    token = request.query.get("token", "")
    job = BROKER.get(token)
    if job is None:
        return web.json_response({"ok": False, "reason": "unknown or expired token"})
    if request.content_type == "application/json":
        data = await request.json()
        job.error = str(data.get("error", "unknown error"))
        job.event.set()
        return web.json_response({"ok": True})
    index = int(request.query.get("index", "0"))
    total = int(request.query.get("total", "1"))
    body = await request.read()
    job.total = total
    job.images[index] = body
    if len(job.images) >= total:
        job.event.set()
    return web.json_response({"ok": True})


# --------------------------------------------------------------------------
# Nodes
# --------------------------------------------------------------------------

class GS3DLoadSplat:
    CATEGORY = "3DGS"
    RETURN_TYPES = ("GS_MODEL",)
    RETURN_NAMES = ("gs_model",)
    FUNCTION = "load"
    DESCRIPTION = "3DGS モデル (.ply / .splat / .sog) を ComfyUI の input フォルダから読み込みます。"
    DESCRIPTION += "\n\nToshiki Hirano (Theoretical Hole Design), 2026"

    @classmethod
    def INPUT_TYPES(cls):
        files = _list_input_files(GS_EXTENSIONS)
        return {
            "required": {
                "file": (files or ["(input フォルダに .ply / .splat / .sog を置いてください)"],),
            }
        }

    def load(self, file):
        path = _resolve_input_path(file)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"3DGS file not found: {file}")
        return (file,)

    @classmethod
    def IS_CHANGED(cls, file):
        try:
            return str(os.path.getmtime(_resolve_input_path(file)))
        except Exception:
            return ""


class GS3DLoadMesh:
    CATEGORY = "3DGS"
    RETURN_TYPES = ("MESH_MODEL",)
    RETURN_NAMES = ("mesh",)
    FUNCTION = "load"
    DESCRIPTION = ("メッシュモデル (.glb / .gltf / .obj / .stl / .fbx) を読み込みます。"
                   "append_to に別の Load Mesh を繋ぐと複数メッシュを配置できます。")
    DESCRIPTION += "\n\nToshiki Hirano (Theoretical Hole Design), 2026"

    @classmethod
    def INPUT_TYPES(cls):
        files = _list_input_files(MESH_EXTENSIONS)
        return {
            "required": {
                "file": (files or ["(input フォルダに .glb / .obj / .stl / .fbx を置いてください)"],),
            },
            "optional": {
                "append_to": ("MESH_MODEL",),
            },
        }

    def load(self, file, append_to=None):
        path = _resolve_input_path(file)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Mesh file not found: {file}")
        meshes = list(append_to) if append_to else []
        meshes.append(file)
        return (meshes,)

    @classmethod
    def IS_CHANGED(cls, file, append_to=None):
        try:
            return str(os.path.getmtime(_resolve_input_path(file)))
        except Exception:
            return ""


class GS3DSceneRender:
    CATEGORY = "3DGS"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "render"
    DESCRIPTION = ("3DGS シーンエディタ。ビューポートでカメラを複数設定し、"
                   "実行時に各カメラアングルを画像として書き出します。"
                   "実行時は ComfyUI のブラウザタブを開いたままにしてください。")
    DESCRIPTION += "\n\nToshiki Hirano (Theoretical Hole Design), 2026"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "gs_model": ("GS_MODEL",),
                "width": ("INT", {"default": 1280, "min": 64, "max": 8192, "step": 8,
                                  "tooltip": "出力画像の横幅(px)。高さはカメラごとのアスペクト比から決まります。"}),
                "timeout_sec": ("INT", {"default": 180, "min": 5, "max": 3600,
                                        "tooltip": "ブラウザからのレンダリング結果を待つ秒数。"}),
                "scene_state": ("STRING", {"default": "{}", "multiline": False}),
            },
            "optional": {
                "mesh": ("MESH_MODEL",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def render(self, gs_model, width, timeout_sec, scene_state, mesh=None, unique_id=None):
        try:
            state = json.loads(scene_state or "{}")
        except json.JSONDecodeError:
            state = {}
        cameras = state.get("cameras") or []
        if not cameras:
            raise RuntimeError(
                "カメラが設定されていません。ブラウザで 3DGS Scene Editor ノードの"
                "ビューポートを操作してカメラを作成してください。")
        client_id = getattr(PromptServer.instance, "client_id", None)
        if not client_id or client_id not in PromptServer.instance.sockets:
            raise RuntimeError(
                "実行元のブラウザが接続されていません。ワークフローを開いたタブから"
                "実行してください。API 実行では接続中のタブの client_id が必要です。")

        token = uuid.uuid4().hex
        job = BROKER.create(token)
        try:
            PromptServer.instance.send_sync("gs3d.render_request", {
                "node_id": str(unique_id),
                "token": token,
                "width": int(width),
                "gs_model": gs_model,
                "meshes": list(mesh) if mesh else [],
                "scene_state": state,
            }, sid=client_id)
            if not job.event.wait(timeout=float(timeout_sec)):
                raise RuntimeError(
                    "ブラウザからのレンダリング結果がタイムアウトしました。"
                    "このワークフローを開いた ComfyUI タブがアクティブなブラウザに"
                    "存在するか確認してください。")
            if job.error:
                raise RuntimeError(f"ブラウザ側レンダリングエラー: {job.error}")
            images = []
            for i in range(job.total or 0):
                png = job.images.get(i)
                if png is None:
                    raise RuntimeError(f"カメラ {i} の画像を受信できませんでした。")
                img = Image.open(io.BytesIO(png)).convert("RGB")
                arr = np.asarray(img).astype(np.float32) / 255.0
                images.append(torch.from_numpy(arr)[None,])
            if not images:
                raise RuntimeError("画像を受信できませんでした。")
            return (images,)
        finally:
            BROKER.discard(token)


NODE_CLASS_MAPPINGS = {
    "GS3D_LoadSplat": GS3DLoadSplat,
    "GS3D_LoadMesh": GS3DLoadMesh,
    "GS3D_SceneRender": GS3DSceneRender,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "GS3D_LoadSplat": "Load 3DGS Model (.ply/.splat/.sog)",
    "GS3D_LoadMesh": "Load Mesh Model (.glb/.obj/.stl/.fbx)",
    "GS3D_SceneRender": "3DGS Scene Editor & Render",
}
