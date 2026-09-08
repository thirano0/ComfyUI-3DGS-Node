# macOSのComfyUIへの導入

## 1. ComfyUIを起動できる状態にする

新しいMacでは、[ComfyUI公式のmacOS導入手順](https://docs.comfy.org/installation/desktop/macos)に従ってComfyUIを導入してください。公式Desktop版の対象はApple Silicon（M1以降）・macOS 13以降です。Intel Macや独自環境は[公式の手動導入手順](https://docs.comfy.org/installation/manual_install)を確認してください。このノードのMac実機検証は未実施です。

このセットアップは、導入済みのComfyUIのPython環境を使います。ComfyUI本体やGPU用PyTorchを新規構築するものではありません。

## 2. フォルダを配置する

ZIPを展開し、`3DGS_node` フォルダ全体を、使用するComfyUIの `custom_nodes` にコピーします。Desktop版では対象インスタンスのデータ／インストール先を使用してください。`ComfyUI.app` の中にコピーする必要はありません。

```text
ComfyUIのインストール先/
├─ .venv/
└─ custom_nodes/
   └─ 3DGS_node/
      ├─ install_macos.command
      ├─ check_install.py
      ├─ nodes.py
      └─ web/
```

## 3. install_macos.commandを実行する

ComfyUIを停止し、Finderで `install_macos.command` をダブルクリックします。Terminalが開き、`.venv/bin/python` または `venv/bin/python` を検出して、不足ライブラリを導入・確認します。最後にEnterで閉じます。依存関係が揃っている場合は確認のみで終了します。

実行権限の関係で開けない場合は、Terminalで `bash `（末尾にスペース）と入力し、`install_macos.command` をそのウィンドウにドラッグしてEnterを押してください。パスに空白がある場合もFinderがエスケープします。

自動検出できない構成や複数の仮想環境がある場合は、TerminalからComfyUIが使うPythonの絶対パスを指定します。

```bash
bash "/path/to/3DGS_node/install_macos.command" --python "/path/to/ComfyUI/.venv/bin/python"
```

確認だけ行う場合：

```bash
bash "/path/to/3DGS_node/install_macos.command" --check-only
```

`--python` と `--check-only` は併用できます。自動処理では `--no-pause` を追加すると最後のEnter待ちを省略できます。OSやHomebrewのPythonではなく、ComfyUIのPythonを指定してください。`sudo` は不要です。

`pip` がない環境では、必要な場合に限り `ensurepip` で追加します。それも利用できない場合は、ComfyUI用の環境管理ツールで `requirements.txt` をインストールしてください。例えば利用可能な `uv` があれば、対象Pythonを明示できます。

```bash
uv pip install --python "/path/to/ComfyUI/.venv/bin/python" -r "/path/to/3DGS_node/requirements.txt"
```

## 4. 再起動して確認する

ComfyUIを再起動し、ブラウザのタブを再読み込みします。WebGL2を使えるブラウザが必要です。`Load 3DGS Model` → `3DGS Scene Editor & Render` → `Save Image` を接続し、手持ちのモデルを読み込んで、まず幅512で画像保存を確認してください。実行元タブは開いたままにします。

Python依存は numpy・Pillow・torch・aiohttp です。three.jsは同梱済みで、このノードのためにNode.js・npm・CUDAを導入する必要はありません。モデルデータは別途用意してください。
