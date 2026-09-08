# Toshiki Hirano (Theoretical Hole Design), 2026
param(
    [string]$PythonPath,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
try {
    # This installer belongs inside ComfyUI/custom_nodes/3DGS_node.
    $comfyRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    if (-not (Test-Path -LiteralPath (Join-Path $comfyRoot 'main.py'))) {
        throw 'Place this folder in ComfyUI/custom_nodes/3DGS_node first. See INSTALL.md.'
    }
    if (-not $PythonPath) {
        $portableRoot = Split-Path $comfyRoot -Parent
        $candidates = @(
            (Join-Path $portableRoot 'python_embeded/python.exe'),
            (Join-Path $comfyRoot '.venv/Scripts/python.exe'),
            (Join-Path $comfyRoot 'venv/Scripts/python.exe')
        ) | Where-Object { Test-Path -LiteralPath $_ }
        if (@($candidates).Count -ne 1) {
            throw 'Could not uniquely detect ComfyUI Python. Run install_windows.bat -PythonPath "C:\path\to\ComfyUI-python.exe"'
        }
        $PythonPath = @($candidates)[0]
    }
    $PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path
    Write-Host "ComfyUI Python: $PythonPath"
    if (-not $CheckOnly) {
        # A working ComfyUI already supplies its GPU-specific torch build.
        & $PythonPath -s -c 'import torch'
        if ($LASTEXITCODE -ne 0) {
            throw 'PyTorch is missing or broken. Finish the official ComfyUI setup first (see INSTALL.md).'
        }
        & $PythonPath -s -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the output above.' }
    }
    & $PythonPath -s (Join-Path $PSScriptRoot 'check_install.py')
    if ($LASTEXITCODE -ne 0) { throw 'Installation check failed.' }
    Write-Host 'Ready. Restart ComfyUI and reload the browser tab.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
