"""Shell control-flow tests; package installation and Python are mocked."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

BASH = shutil.which("bash")
if not BASH and Path("C:/Program Files/Git/bin/bash.exe").is_file():
    BASH = "C:/Program Files/Git/bin/bash.exe"


def shell_path(path):
    value = Path(path).resolve().as_posix()
    return "/" + value[0].lower() + value[2:] if os.name == "nt" else value


@unittest.skipUnless(BASH, "Bash is required")
class MacInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gs3d Mac 日本語 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.node = self.root / "custom_nodes/3DGS_node"
        self.node.mkdir(parents=True)
        self.script = self.node / "install_macos.command"
        shutil.copyfile(Path(__file__).resolve().parents[1] / self.script.name, self.script)
        self.python = self.root / ".venv/bin/python"
        self.python.parent.mkdir(parents=True)
        self.python.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_LOG"
case "$*" in
    *"import torch"*) [ "$MOCK_MODE" != broken-torch ]; exit $? ;;
    *"pip --version"*) [ "$MOCK_MODE" != no-pip ]; exit $? ;;
    *"ensurepip"*) exit 0 ;;
    *"pip install"*) touch "$MOCK_INSTALLED"; exit 0 ;;
    *"check_install.py"*)
        if [ "$MOCK_MODE" = ready ] || [ -f "$MOCK_INSTALLED" ]; then exit 0; fi
        exit 1 ;;
esac
exit 1
''', encoding="utf-8", newline="\n")
        self.python.chmod(0o755)

    def run_installer(self, *args, mode="ready"):
        log = self.root / "calls.txt"
        env = dict(os.environ, MOCK_LOG=shell_path(log), MOCK_MODE=mode,
                   MOCK_INSTALLED=shell_path(self.root / "installed"))
        result = subprocess.run([BASH, shell_path(self.script), "--no-pause", *args],
                                env=env, capture_output=True, text=True, encoding="utf-8")
        return result, log.read_text(encoding="utf-8") if log.exists() else ""

    def test_ready_environment_needs_no_pip(self):
        result, log = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("pip", log)

    def test_install_missing_packages(self):
        result, log = self.run_installer(mode="missing")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pip install -r", log)

    def test_uv_style_environment_without_pip(self):
        result, log = self.run_installer(mode="no-pip")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ensurepip", log)
        self.assertIn("pip install -r", log)

    def test_check_only_does_not_install(self):
        result, log = self.run_installer("--check-only", mode="missing")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("pip", log)

    def test_broken_torch_stops_before_install(self):
        result, log = self.run_installer(mode="broken-torch")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PyTorch", result.stderr)
        self.assertNotIn("pip", log)

    def test_ambiguous_environments_require_explicit_path(self):
        second = self.root / "venv/bin/python"
        second.parent.mkdir(parents=True)
        shutil.copyfile(self.python, second)
        second.chmod(0o755)
        result, log = self.run_installer()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(log, "")
        result, log = self.run_installer("--python", shell_path(self.python))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_argument_is_rejected(self):
        result, log = self.run_installer("--python")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(log, "")


if __name__ == "__main__":
    unittest.main()
