import json
import os
import pathlib
import subprocess
import time
import urllib.request

root = pathlib.Path.cwd()
environment = {**os.environ, "NEXT_TELEMETRY_DISABLED": "1"}
frontend = subprocess.Popen(
    ["npm", "start", "--", "--hostname", "127.0.0.1", "--port", "3000"],
    cwd=root / "frontend",
    env=environment,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
backend = subprocess.Popen(
    [str(root / "backend/.venv/bin/uvicorn"), "app.main:app", "--host", "127.0.0.1", "--port", "8000"],
    cwd=root / "backend",
    env=environment,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

try:
    results = {}
    for name, url in {
        "frontend": "http://127.0.0.1:3000/api/health",
        "backend": "http://127.0.0.1:8000/health",
    }.items():
        for attempt in range(100):
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    results[name] = json.loads(response.read())
                break
            except Exception:
                if attempt == 99:
                    raise
                time.sleep(0.1)
    assert results["frontend"] == {"status": "ready", "component": "frontend"}
    assert results["backend"] == {"status": "test", "component": "backend"}
finally:
    frontend.terminate()
    backend.terminate()
    frontend.wait(timeout=10)
    backend.wait(timeout=10)

(root / "application-health.json").write_text(
    json.dumps({"healthy": True, "services": sorted(results)}) + "\n",
    encoding="utf-8",
)
