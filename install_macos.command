#!/bin/bash
# Toshiki Hirano (Theoretical Hole Design), 2026
# Compatible with macOS's bundled Bash 3.2. Run from Finder or Terminal.
set -eu

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
python_path=""
check_only=0
pause_at_exit=1

finish() {
    result=$?
    trap - EXIT
    if [ "$pause_at_exit" -eq 1 ] && [ -t 0 ]; then
        printf '\nPress Enter to close... '
        read -r unused || true
    fi
    exit "$result"
}
trap finish EXIT

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
    printf 'Usage: bash install_macos.command [--python /path/to/python] [--check-only] [--no-pause]\n'
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --python)
            [ "$#" -ge 2 ] || fail '--python requires the full path to ComfyUI Python.'
            python_path="$2"
            shift 2 ;;
        --check-only) check_only=1; shift ;;
        --no-pause) pause_at_exit=0; shift ;;
        --help|-h) pause_at_exit=0; usage; exit 0 ;;
        *) usage; fail "Unknown option: $1" ;;
    esac
done

custom_nodes_dir="$(dirname -- "$script_dir")"
comfy_root="$(dirname -- "$custom_nodes_dir")"
# Desktop installations may keep main.py inside the application bundle.
if [ -z "$python_path" ]; then
    [ "$(basename -- "$custom_nodes_dir")" = custom_nodes ] ||
        fail 'Place this folder in ComfyUI/custom_nodes/3DGS_node first. See INSTALL_MACOS.md.'
    candidate_count=0
    detected_python=""
    for env_dir in "$comfy_root/.venv" "$comfy_root/venv"; do
        if [ -x "$env_dir/bin/python" ]; then
            detected_python="$env_dir/bin/python"
            candidate_count=$((candidate_count + 1))
        elif [ -x "$env_dir/bin/python3" ]; then
            detected_python="$env_dir/bin/python3"
            candidate_count=$((candidate_count + 1))
        fi
    done
    [ "$candidate_count" -eq 1 ] ||
        fail 'Could not uniquely detect ComfyUI Python. Use --python "/full/path/to/.venv/bin/python".'
    python_path="$detected_python"
fi

case "$python_path" in
    /*) ;;
    *) fail '--python must be an absolute path to the Python used by ComfyUI.' ;;
esac
[ -x "$python_path" ] || fail "Python is not executable: $python_path"
printf 'ComfyUI Python: %s\n' "$python_path"

if [ "$check_only" -eq 0 ]; then
    "$python_path" -s -c 'import torch' ||
        fail 'PyTorch is missing or broken. Complete the official ComfyUI setup first (INSTALL_MACOS.md).'
    # uv-created environments may lack pip. Do not add pip if everything is ready.
    if "$python_path" -s "$script_dir/check_install.py"; then
        printf 'Ready. Restart ComfyUI and reload its browser tab.\n'
        exit 0
    fi
    if ! "$python_path" -s -m pip --version >/dev/null 2>&1; then
        "$python_path" -s -m ensurepip ||
            fail 'Cannot initialize pip. Use ComfyUI environment tools to install requirements.txt; see INSTALL_MACOS.md.'
    fi
    "$python_path" -s -m pip install -r "$script_dir/requirements.txt" ||
        fail 'Dependency installation failed. Check the output above.'
fi

"$python_path" -s "$script_dir/check_install.py" || fail 'Installation check failed.'
printf 'Ready. Restart ComfyUI and reload its browser tab.\n'
