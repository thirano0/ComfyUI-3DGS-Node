# Toshiki Hirano (Theoretical Hole Design), 2026
"""Check Python dependencies and bundled browser modules without starting ComfyUI."""
import importlib
from pathlib import Path
import re
import sys


def main():
    root = Path(__file__).resolve().parent
    errors = []
    print(f"Python: {sys.executable}")
    for name in ("numpy", "PIL", "torch", "aiohttp"):
        try:
            module = importlib.import_module(name)
            print(f"OK: {name} {getattr(module, '__version__', '')}")
        except Exception as exc:
            errors.append(f"{name}: {exc}")
    for path in (root / "web/js/gs3d.js", root / "web/js/splat.js"):
        if not path.is_file():
            errors.append(f"Missing: {path}")
    # Include the transitive vendor imports; no npm or CDN is needed.
    for path in (root / "web").rglob("*.js"):
        for dependency in re.findall(r'\bfrom\s+[\'"]([^\'"]+)[\'"]', path.read_text(encoding="utf-8")):
            if dependency.startswith("../../../scripts/"):
                continue  # Served by ComfyUI.
            if dependency.startswith(".") and not (path.parent / dependency).is_file():
                errors.append(f"Missing import in {path.name}: {dependency}")
    for error in errors:
        print(f"ERROR: {error}")
    if not errors:
        print("Dependencies and browser assets OK. WebGL2 must be checked in the browser.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
