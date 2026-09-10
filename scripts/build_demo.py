"""Generate GitHub Pages from the same UI source; does not publish anything."""

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
subprocess.run(["npm", "run", "build:demo"], cwd=ROOT / "frontend", check=True)
source = ROOT / "frontend" / "dist-demo"
target = ROOT / "docs"
for name in ("app.js", "demo_mock.js", "styles.css", "index.html", "device.svg"):
    (target / name).unlink(missing_ok=True)
if (target / "assets").exists():
    shutil.rmtree(target / "assets")
shutil.copytree(source, target, dirs_exist_ok=True)
(target / ".nojekyll").touch()
print("Updated docs/ from frontend/src. No publish or push performed.")
