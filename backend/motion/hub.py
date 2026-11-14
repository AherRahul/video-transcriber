"""
The chat panel's log and the live updates the page listens to.

Every change is an operation with a sequence number: add an entry, patch an entry, append streamed text,
the project changed (the preview reloads), Claude started or stopped, an export moved. The page keeps a
copy of the log and long-polls `/events?after=<seq>` for the operations after the last one it applied.
`boot` changes when the server restarts, which tells the page to reload the whole log.
"""

from __future__ import annotations

import copy
import threading
import time
import uuid
from collections import defaultdict, deque

from .store import Store, now


class Hub:
    def __init__(self, store: Store):
        self.store = store
        self.boot = uuid.uuid4().hex[:8]
        self._cond = threading.Condition()
        self._events: dict[str, deque] = defaultdict(lambda: deque(maxlen=4000))
        self._seq: dict[str, int] = defaultdict(int)
        self._logs: dict[str, list[dict]] = {}
        self._dirty: set[str] = set()

    # ── operations ──

    def emit(self, pid: str, op: dict) -> int:
        with self._cond:
            self._seq[pid] += 1
            op = {**op, "seq": self._seq[pid]}
            self._events[pid].append(op)
            self._cond.notify_all()
            return op["seq"]

    def seq(self, pid: str) -> int:
        with self._cond:
            return self._seq[pid]

    def wait(self, pid: str, after: int, timeout: float) -> list[dict]:
        """Operations after `after`, waiting up to `timeout` seconds for the first one."""
        deadline = time.time() + timeout
        with self._cond:
            while True:
                if self._seq[pid] > after:
                    events = [e for e in self._events[pid] if e["seq"] > after]
                    if events and events[0]["seq"] > after + 1:
                        # the page fell too far behind: tell it to reload everything
                        return [{"op": "reload", "seq": self._seq[pid]}]
                    return events
                left = deadline - time.time()
                if left <= 0:
                    return []
                self._cond.wait(left)

    # ── the chat log ──

    def log(self, pid: str) -> list[dict]:
        with self._cond:
            if pid not in self._logs:
                self._logs[pid] = self.store.load_log(pid)
            return self._logs[pid]

    def add(self, pid: str, entry: dict) -> dict:
        entry = {"id": uuid.uuid4().hex[:10], "ts": now(), **entry}
        with self._cond:
            self.log(pid).append(entry)
            self._dirty.add(pid)
        # the operation carries a copy: the log's entry keeps growing as text streams in, and a page that
        # fetches this "add" later would otherwise get the grown text and then the appends again
        self.emit(pid, {"op": "add", "entry": copy.deepcopy(entry)})
        return entry

    def patch(self, pid: str, eid: str, **fields) -> None:
        with self._cond:
            for e in reversed(self.log(pid)):
                if e["id"] == eid:
                    e.update(fields)
                    break
            self._dirty.add(pid)
        self.emit(pid, {"op": "patch", "id": eid, "fields": fields})

    def append_text(self, pid: str, eid: str, text: str) -> None:
        with self._cond:
            for e in reversed(self.log(pid)):
                if e["id"] == eid:
                    e["text"] = e.get("text", "") + text
                    break
            self._dirty.add(pid)
        self.emit(pid, {"op": "append", "id": eid, "text": text})

    def flush(self, pid: str) -> None:
        with self._cond:
            if pid not in self._dirty or pid not in self._logs:
                return
            log = list(self._logs[pid])
            self._dirty.discard(pid)
        try:
            self.store.save_log(pid, log)
        except Exception:  # noqa: BLE001 - the project may have been deleted meanwhile
            pass

    def forget(self, pid: str) -> None:
        with self._cond:
            self._logs.pop(pid, None)
            self._dirty.discard(pid)
            self._events.pop(pid, None)

    def project_changed(self, pid: str, version: int) -> None:
        self.emit(pid, {"op": "project", "version": version})
