"""
Hot reload for the transcriber's server, like nodemon: runs app.py, watches the backend's Python files and
restarts the server when one changes.

Why not uvicorn --reload: on Windows it ends the server with TerminateProcess, which leaves the export's
headless browser (Playwright's driver and Edge) running behind it, and it cuts an export, a voice job or a
Claude turn short without a word. This runner stops the server's whole process tree (nothing left behind),
and when a change lands while the server is busy (GET /api/busy: transcriptions and their screenshots,
Motion's exports, voice jobs and Claude turns), it waits for that work to finish first.

Usage:  .\\backend\\run.ps1 -Dev           (from the project folder)
        .venv\\Scripts\\python.exe dev.py   (from backend)
Type rs and Enter to restart at once (as in nodemon). Ctrl+C stops it all.

The page has its own live reload: npm run dev in frontend (see the README).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKIP_DIRS = {".venv", "__pycache__", "node_modules"}
POLL_SECONDS = 0.6
PORT = os.environ.get("TRANSCRIBER_PORT", "8765")  # app.py reads the same variable
BUSY_URL = f"http://127.0.0.1:{PORT}/api/busy"
NAMES = {"transcriptions": "transcription", "exports": "export", "voice": "voice job", "claude": "Claude turn", "clips": "clip conversion"}


def snapshot() -> dict[str, float]:
    """Every watched file and when it last changed: the backend's .py files, tests left out."""
    found: dict[str, float] = {}
    for root, dirs, files in os.walk(HERE):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        for name in files:
            if name.endswith(".py") and not name.startswith("test_"):
                path = os.path.join(root, name)
                try:
                    found[path] = os.stat(path).st_mtime
                except OSError:
                    pass
    return found


def start() -> subprocess.Popen:
    print(f"[dev] starting the server: http://127.0.0.1:{PORT}", flush=True)
    # No stdin for the server: this runner reads it (for rs), and on Windows a read waiting on a pipe stalls
    # a child that shares the handle before it even starts (it hung for minutes without a line printed).
    return subprocess.Popen([sys.executable, "app.py"], cwd=HERE, stdin=subprocess.DEVNULL)


def stop(proc: subprocess.Popen) -> None:
    """Stops the server and everything it started (the export's browser, FFmpeg)."""
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


def busy() -> dict | None:
    """What the running server is in the middle of, or None when it isn't answering (starting, or down)."""
    try:
        with urllib.request.urlopen(BUSY_URL, timeout=2) as r:
            return json.load(r)
    except Exception:  # noqa: BLE001 - a server that doesn't answer has nothing to wait for
        return None


RS = "rs"  # stands in the list of changes when the restart was typed


def why(pending: list[str]) -> str:
    """The restart's reason for the log: the files that changed, or that rs was typed."""
    files = sorted({p for p in pending if p != RS})
    if not files:
        return "rs typed"
    return f"{', '.join(files)} changed"


def describe(state: dict) -> str:
    parts = [f"{n} {NAMES[k]}{'s' if n != 1 else ''}" for k, n in state.items() if k in NAMES and isinstance(n, int) and n]
    return ", ".join(parts) or "work"


def main() -> None:
    proc = start()
    seen = snapshot()
    asked = threading.Event()

    def read_input() -> None:
        try:
            for line in sys.stdin:
                if line.strip() == "rs":
                    asked.set()
        except (OSError, ValueError):  # no console to read from
            pass

    threading.Thread(target=read_input, daemon=True).start()
    pending: list[str] = []
    said_waiting = said_crashed = False
    try:
        while True:
            time.sleep(POLL_SECONDS)
            now = snapshot()
            changed = [p for p in now if seen.get(p) != now[p]] + [p for p in seen if p not in now]
            if changed:
                time.sleep(0.3)  # an editor saving several files at once: one restart for all of them
                now = snapshot()
                pending += [os.path.relpath(p, HERE) for p in changed]
            seen = now
            if asked.is_set():
                asked.clear()
                pending.append(RS)
            if not pending:
                if proc.poll() is not None and not said_crashed:
                    print(f"[dev] the server stopped (exit {proc.returncode}); waiting for a file change (or rs)", flush=True)
                    said_crashed = True
                continue
            state = busy() if proc.poll() is None else None
            if state and state.get("busy"):
                if not said_waiting:
                    print(f"[dev] {why(pending)}; waiting for {describe(state)} to finish before restarting", flush=True)
                    said_waiting = True
                continue
            print(f"[dev] restarting: {why(pending)}", flush=True)
            stop(proc)
            proc = start()
            pending = []
            said_waiting = said_crashed = False
    except KeyboardInterrupt:
        pass
    finally:
        stop(proc)
        print("[dev] stopped", flush=True)


if __name__ == "__main__":
    main()
