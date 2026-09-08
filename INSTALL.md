# 新しいPCでの導入（Windows）

## 1. ComfyUIを導入する

[ComfyUI公式のWindows Portable導入ページ](https://docs.comfy.org/installation/comfyui_portable_windows)から、PCのGPUに合ったパッケージを入手して展開してください。Pythonも同梱されるので、別途Pythonをインストールする必要はありません。まず付属の起動用batでComfyUIが起動することを確認します。

ComfyUI本体とGPU用PyTorchの導入は公式パッケージに任せ、このノードのセットアップはそのPython環境を使用します。既存のDesktop版・手動導入版を使用する場合も、先にComfyUI本体を起動できる状態にしてください。

## 2. このフォルダをコピーする

`web` を含むこのフォルダ全体を次の位置に配置します。

```text
ComfyUI_windows_portable/
├─ python_embeded/
└─ ComfyUI/
   └─ custom_nodes/
      └─ 3DGS_node/
         ├─ __init__.py
         ├─ nodes.py
         ├─ install_windows.bat
         └─ web/
```

## 3. install_windows.batをダブルクリックする

ComfyUIを停止してから実行してください。PortableのPython、またはComfyUI直下の `.venv` / `venv` を自動検出し、足りないPythonライブラリをインストールして、同梱JavaScriptの不足も確認します。パッケージ取得にはインターネット接続が必要です。すでに導入済みのパッケージは再利用し、アップグレード指定は行いません。

Python環境を自動検出できない場合（Desktop版や独自環境など）は、ComfyUIが使うPythonのフルパスを明示します。通常のシステムPythonを指定しないでください。

```bat
install_windows.bat -PythonPath "C:\path\to\ComfyUI\.venv\Scripts\python.exe"
```

インストールせず確認だけ行う場合：

```bat
install_windows.bat -CheckOnly
```

macOS用には **[INSTALL_MACOS.md](INSTALL_MACOS.md)** と `install_macos.command` を用意しています。Linuxや手動導入環境では、ComfyUIの仮想環境を有効にして、このフォルダで `python -m pip install -r requirements.txt`、続けて `python check_install.py` を実行してください。

## 4. 起動して動作を確認する

ComfyUIを起動し、ブラウザのタブを再読み込みしてください。WebGL2に対応し、ハードウェアアクセラレーションが有効なブラウザが必要です。表示できない場合はブラウザのGPU設定とGPUドライバを確認してください。

1. `Load 3DGS Model` と `3DGS Scene Editor & Render`、`Save Image` を接続。
2. 手持ちの `.ply` / `.splat` / `.sog` をアップロード。
3. モデル表示とカメラ設定を確認し、まず幅512で実行。
4. カメラ数と同数の画像が保存されることを確認。

モデルデータは別途必要です。Python依存は numpy・Pillow・torch・aiohttp、ブラウザ側のthree.jsは `web/vendor` に同梱しています。このノード用のNode.js、npm、CUDAコンパイラの導入は不要です。ComfyUI全体で必要なGPU環境は公式導入手順に従ってください。

レンダリングは実行元タブで行います。実行後もそのタブとワークフローを開いたままにしてください。APIから実行する場合は、そのタブの接続中の `client_id` を送信する必要があります。ブラウザなしでのレンダリングには対応していません。
