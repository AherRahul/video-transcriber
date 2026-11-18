"""
The chat with Claude for one video: one turn at a time per video, run on a background thread.

A turn sends the user's message (with the project's current state, attachments and any comment target)
and then loops: stream Claude's reply into the chat panel, run the tools it asked for, send the results
back, until Claude stops calling tools. ask_style ends the turn early; the user's click on a style card
becomes that tool's result at the start of the next turn.

The conversation is append-only (never edited or trimmed), the system prompt and tools never change, and
both are cached, so each step re-reads the history from the prompt cache.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
import urllib.parse
from pathlib import Path

import anthropic

from . import brand as br
from . import broll as bl
from . import kitdata
from . import render as rd
from . import voice as vc
from .hub import Hub
from .jobs import Exports, thumbnail_image
from .prompts import ALL_TOOLS, SYSTEM_PROMPT, TOOL_LABELS
from .store import (
    CLOSING_KINDS,
    THUMBNAIL_WORDS,
    Store,
    StoreError,
    asset_kind,
    clock_seconds,
    fmt_clock,
    image_size,
    ref_clock,
    safe_asset_name,
    thumbnail_colour_warnings,
)

# Prices in US dollars per million tokens: input, output, cache read. Cache writes cost 1.25x input.
MODELS: dict[str, dict] = {
    "claude-opus-5-5": {"label": "Claude Opus 5.5", "price": (4.00, 20.00, 0.20), "fallbacks": True, "display": "updates"},
    "claude-sonnet-5-5": {"label": "Claude Sonnet 5.5", "price": (2.00, 10.00, 0.10), "fallbacks": True, "display": "updates"},
    "claude-haiku-5-5": {"label": "Claude Haiku 5.5", "price": (0.10, 0.50, 0.01), "fallbacks": False, "display": "summarized"},
}
DEFAULT_MODEL = os.environ.get("MOTION_MODEL") if os.environ.get("MOTION_MODEL") in MODELS else "claude-opus-5-5"
EFFORTS = ("low", "medium", "high", "xhigh")
DEFAULT_EFFORT = os.environ.get("MOTION_EFFORT") if os.environ.get("MOTION_EFFORT") in EFFORTS else "high"
MAX_STEPS = 250  # API calls per turn (a 30 minute video is about 80 scenes, each written, checked and fixed)
MAX_NUDGES = 30  # times one turn sends Claude back to an unfinished build
MAX_ACTIVE_TURNS = 2  # turns running at once across all videos
MUTATING = {"write_storyboard", "write_script", "set_pronunciations", "write_scene", "patch_scene", "set_props", "update_timeline", "save_brand_kit", "use_brand_kit", "import_asset", "write_thumbnail", "write_details", "import_broll"}
ENGINES = ("claude-code", "api")
TIMESTAMP_RE = re.compile(r"(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?(?![\d:])")
TEXT_DOC_EXT = {".txt", ".md", ".csv", ".json", ".srt", ".vtt"}
VISION_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


class StopTurn(Exception):
    pass


def source_seconds(text: str) -> float:
    """How long a timed transcript runs: its latest timestamp ([10:08], 00:10:08.000 -->, 1:02:03)."""
    best = 0.0
    for m in TIMESTAMP_RE.finditer(text[:2_000_000]):
        h, mi, se = m.group(1), m.group(2), m.group(3)
        if int(se) >= 60 or (h is None and int(mi) > 600):
            continue
        best = max(best, (int(h) if h else 0) * 3600 + int(mi) * 60 + int(se))
    return float(best)


def default_engine() -> str:
    """Claude Code when it is installed (the user's Claude plan), else the API key."""
    wanted = os.environ.get("MOTION_ENGINE")
    if wanted in ENGINES:
        return wanted
    from . import claude_code

    return "claude-code" if claude_code.available().get("ready") else "api"


def credentials_hint() -> dict:
    """Where the API key will come from (without reading or showing it)."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return {"ready": True, "source": "ANTHROPIC_API_KEY"}
    if os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return {"ready": True, "source": "ANTHROPIC_AUTH_TOKEN"}
    profile_dir = Path(os.environ.get("ANTHROPIC_CONFIG_DIR") or (Path.home() / ".config" / "anthropic"))
    if profile_dir.exists() and any(profile_dir.iterdir()):
        return {"ready": True, "source": "ant profile"}
    return {"ready": False, "source": None}


def cost_of(model: str, usage: dict) -> float:
    pin, pout, pread = MODELS.get(model, MODELS[DEFAULT_MODEL])["price"]
    return (
        usage.get("input", 0) * pin
        + usage.get("cacheWrite", 0) * pin * 1.25
        + usage.get("cacheRead", 0) * pread
        + usage.get("output", 0) * pout
    ) / 1_000_000


def _fmt_seconds(x: float) -> str:
    return f"{x:.1f}".rstrip("0").rstrip(".") + " s"


class Agent:
    def __init__(self, store: Store, renderer: rd.RenderService, hub: Hub, exports: Exports):
        self.store = store
        self.render = renderer
        self.hub = hub
        self.exports = exports
        self._client: anthropic.Anthropic | None = None
        self._turns: dict[str, threading.Event] = {}  # project id -> stop flag of the running turn
        self._lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_ACTIVE_TURNS)

    # ── public ──

    def running(self, pid: str) -> bool:
        with self._lock:
            return pid in self._turns

    def stop(self, pid: str) -> None:
        with self._lock:
            ev = self._turns.get(pid)
        if ev:
            ev.set()

    def new_chat(self, pid: str) -> None:
        """Starts a fresh conversation for this video (the scenes stay; Claude re-reads them as needed)."""
        if self.running(pid):
            raise StoreError("Claude is still working on this video. Stop it first.", 409)
        chat = self.store.load_chat(pid)
        chat["messages"], chat["pending"], chat["claudeCode"] = [], None, {}
        self.store.save_chat(pid, chat)
        self.hub.add(pid, {"kind": "divider", "text": "New chat. Claude keeps the scenes but not the earlier conversation."})
        self.hub.flush(pid)

    def start(self, pid: str, req: dict) -> None:
        project = self.store.get_project(pid)  # 404 for an unknown video
        text = str(req.get("text") or "").strip()
        choice = req.get("styleChoice")
        if not text and not choice and not req.get("attachments") and not req.get("comment"):
            raise StoreError("Write a message first.")
        if not self._slots.acquire(blocking=False):
            raise StoreError("Claude is already working on two other videos. Try again when one finishes.", 429)
        with self._lock:
            if pid in self._turns:
                self._slots.release()
                raise StoreError("Claude is still working on this video.", 409)
            stop = threading.Event()
            self._turns[pid] = stop
        settings = project.get("settings") or {}
        model = req.get("model") or settings.get("model") or DEFAULT_MODEL
        effort = req.get("effort") or settings.get("effort") or DEFAULT_EFFORT
        if model not in MODELS:
            model = DEFAULT_MODEL
        if effort not in EFFORTS:
            effort = DEFAULT_EFFORT
        engine = req.get("engine") or settings.get("engine") or default_engine()
        if engine not in ENGINES:
            engine = default_engine()
        target = self._turn_cc if engine == "claude-code" else self._turn
        self.hub.emit(pid, {"op": "running", "running": True})
        threading.Thread(target=target, args=(pid, req, model, effort, stop), name=f"motion-turn-{pid}", daemon=True).start()

    # ── a turn on Claude Code (the user's Claude plan) ──

    def _turn_cc(self, pid: str, req: dict, model: str, effort: str, stop: threading.Event) -> None:
        from . import claude_code

        started = time.time()
        ctx = {"pid": pid, "stop": stop, "snapshot": False, "label": str(req.get("text") or "a style pick")[:60]}
        # what every run in this turn used (a build that Claude left part-way is sent back as another run)
        acc: dict = {"turns": 0, "cost": 0.0, "usage": {}}
        try:
            chat = self.store.load_chat(pid)
            session = (chat.get("claudeCode") or {}).get("sessionId")
            blocks = self._user_content(pid, chat, req, engine="claude-code")
            chat["pending"] = None
            self.store.save_chat(pid, chat)
            self.hub.flush(pid)
            while True:
                result = claude_code.run_turn(self, pid, blocks, model, effort, stop, ctx, session)
                session = result.get("sessionId") or session
                chat = self.store.load_chat(pid)
                chat["claudeCode"] = {"sessionId": session}
                self.store.save_chat(pid, chat)
                acc["turns"] += int(result.get("turns") or 0)
                acc["cost"] += float(result.get("cost") or 0)
                for k, v in (result.get("usage") or {}).items():
                    if isinstance(v, (int, float)):
                        acc["usage"][k] = acc["usage"].get(k, 0) + v
                if result.get("interrupted"):
                    self.hub.add(pid, {"kind": "note", "text": "Stopped."})
                    break
                note = self._continue_note(pid, ctx)
                if not note:
                    break
                blocks = [{"type": "text", "text": note}]
        except StoreError as err:
            self.hub.add(pid, {"kind": "error", "text": str(err)})
        except ImportError:
            self.hub.add(pid, {"kind": "error", "text": "Claude Code isn't installed for Motion: run backend\\setup.ps1 (it installs claude-agent-sdk), or switch the engine to API key in the Claude menu."})
        except Exception as err:  # noqa: BLE001 - show it in the chat instead of losing the turn silently
            self.hub.add(pid, {"kind": "error", "text": f"Claude Code failed: {type(err).__name__}: {err}"[:600]})
        finally:
            try:
                if acc["turns"]:
                    u = acc["usage"]
                    cost = acc["cost"]
                    chat = self.store.load_chat(pid)
                    totals = chat.get("totals") or {}
                    totals["planCost"] = round(totals.get("planCost", 0) + cost, 4)
                    totals["turns"] = totals.get("turns", 0) + 1
                    chat["totals"] = totals
                    self.store.save_chat(pid, chat)
                    self.hub.add(pid, {
                        "kind": "usage", "engine": "claude-code", "model": model, "effort": effort, "steps": acc["turns"],
                        "input": int(u.get("input_tokens") or 0), "output": int(u.get("output_tokens") or 0),
                        "cacheRead": int(u.get("cache_read_input_tokens") or 0), "cacheWrite": int(u.get("cache_creation_input_tokens") or 0),
                        "cost": round(cost, 4), "total": totals["planCost"], "seconds": round(time.time() - started, 1),
                    })
            except Exception:  # noqa: BLE001 - the project may have been deleted
                pass
            self.hub.flush(pid)
            with self._lock:
                self._turns.pop(pid, None)
            self._slots.release()
            self.hub.emit(pid, {"op": "running", "running": False})

    # ── a turn on the Anthropic API (an API key) ──

    def _client_or_error(self) -> anthropic.Anthropic:
        if self._client is None:
            self._client = anthropic.Anthropic(max_retries=3)
        return self._client

    def _turn(self, pid: str, req: dict, model: str, effort: str, stop: threading.Event) -> None:
        started = time.time()
        usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "steps": 0}
        ctx = {"pid": pid, "stop": stop, "snapshot": False, "label": str(req.get("text") or "a style pick")[:60]}
        try:
            chat = self.store.load_chat(pid)
            messages: list[dict] = chat["messages"]
            messages.append({"role": "user", "content": self._user_content(pid, chat, req)})
            chat["pending"] = None
            self.store.save_chat(pid, chat)
            self.hub.flush(pid)
            client = self._client_or_error()
            json_retries = 0
            stripped = False
            while usage["steps"] < MAX_STEPS:
                if stop.is_set():
                    raise StopTurn()
                usage["steps"] += 1
                try:
                    final, tool_entries = self._stream_step(client, pid, model, effort, messages, stop)
                except ValueError:
                    # a tool input that could not be parsed at all: ask again (bounded)
                    json_retries += 1
                    if json_retries > 2:
                        raise
                    continue
                except anthropic.BadRequestError:
                    if stripped:
                        raise
                    # Once per turn, repair the history and try again: drop reasoning blocks (they are bound to
                    # the exact earlier conversation) and blocks of server tools this version no longer
                    # declares (chats from before 2026-11-14 used Anthropic's web fetch).
                    stripped = True
                    for m in messages:
                        if m["role"] == "assistant" and isinstance(m["content"], list):
                            kept = [b for b in m["content"] if b.get("type") in ("text", "tool_use")]
                            m["content"] = kept or [{"type": "text", "text": "(earlier step)"}]
                    self.store.save_chat(pid, chat)
                    continue
                json_retries = 0
                u = final.usage
                usage["input"] += u.input_tokens or 0
                usage["output"] += u.output_tokens or 0
                usage["cacheRead"] += getattr(u, "cache_read_input_tokens", 0) or 0
                usage["cacheWrite"] += getattr(u, "cache_creation_input_tokens", 0) or 0

                if final.stop_reason == "refusal":
                    category = getattr(getattr(final, "stop_details", None), "category", None)
                    self.hub.add(pid, {"kind": "error", "text": "Claude declined this request" + (f" ({category})." if category else ".") + " Try rewording it."})
                    break
                content = [b.to_dict(mode="json", exclude_none=True) for b in final.content]
                messages.append({"role": "assistant", "content": content})
                self.store.save_chat(pid, chat)
                if final.stop_reason == "pause_turn":
                    continue  # a server tool (web fetch) paused; send the same history to resume
                tool_uses = [b for b in final.content if b.type == "tool_use"]
                if not tool_uses:
                    note = self._continue_note(pid, ctx) if final.stop_reason == "end_turn" else None
                    if note:
                        # Claude stopped part-way through a build: send it back to the remaining scenes
                        messages.append({"role": "user", "content": [{"type": "text", "text": note}]})
                        self.store.save_chat(pid, chat)
                        continue
                    break
                if final.stop_reason == "max_tokens":
                    messages.append({"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": t.id, "is_error": True, "content": "Not run: your reply hit the output limit while writing this call, so its input was incomplete. Do it again in smaller pieces (for example one scene per call)."}
                        for t in tool_uses
                    ]})
                    continue
                results, ask = [], None
                for t in tool_uses:
                    if t.name == "ask_style":
                        ask = t
                        continue
                    results.append(self._run_tool(ctx, t, tool_entries.get(t.id)))
                if ask is not None:
                    self._ask_style(pid, chat, ask, results)
                    break
                messages.append({"role": "user", "content": results})
                self.store.save_chat(pid, chat)
            else:
                self.hub.add(pid, {"kind": "error", "text": f"Stopped after {MAX_STEPS} steps in one turn. Press Continue building, or send a message to continue."})
        except StopTurn:
            self.hub.add(pid, {"kind": "note", "text": "Stopped."})
        except anthropic.AuthenticationError:
            self.hub.add(pid, {"kind": "error", "text": "Claude rejected the API key. Check ANTHROPIC_API_KEY (see the Motion section of the README) and restart the app."})
        except anthropic.PermissionDeniedError as err:
            self.hub.add(pid, {"kind": "error", "text": f"This API key can't use {model}: {err.message}"[:400]})
        except anthropic.NotFoundError as err:
            self.hub.add(pid, {"kind": "error", "text": f"Model {model} was not found for this API key: {err.message}"[:400]})
        except anthropic.RateLimitError:
            self.hub.add(pid, {"kind": "error", "text": "Claude's rate limit was hit. Wait a minute and send the message again."})
        except anthropic.APIConnectionError:
            self.hub.add(pid, {"kind": "error", "text": "Could not reach Claude. Check the internet connection and try again."})
        except anthropic.APIStatusError as err:
            hint = " If this keeps happening in this video, type /clear to start a new chat (the scenes stay)." if err.status_code == 400 else ""
            self.hub.add(pid, {"kind": "error", "text": f"Claude returned an error ({err.status_code}): {err.message}"[:500] + hint})
        except anthropic.AnthropicError as err:
            msg = str(err)
            if "api_key" in msg or "auth" in msg.lower():
                msg = "No Claude API key found. Set ANTHROPIC_API_KEY (see the Motion section of the README) and restart the app."
            self.hub.add(pid, {"kind": "error", "text": msg[:500]})
        except StoreError as err:
            self.hub.add(pid, {"kind": "error", "text": str(err)})
        except TypeError as err:
            # the SDK raises a TypeError when it finds no key at all
            text = str(err)
            if "authentication" in text.lower():
                text = "No Claude API key found. Put ANTHROPIC_API_KEY=... in backend\\.env (or set it in your environment), then restart the app."
            else:
                text = f"Something went wrong: TypeError: {text}"
            self.hub.add(pid, {"kind": "error", "text": text[:500]})
        except Exception as err:  # noqa: BLE001 - show it in the chat instead of losing the turn silently
            self.hub.add(pid, {"kind": "error", "text": f"Something went wrong: {type(err).__name__}: {err}"[:500]})
        finally:
            try:
                if usage["steps"]:
                    cost = cost_of(model, usage)
                    chat = self.store.load_chat(pid)
                    totals = chat.get("totals") or {}
                    totals["cost"] = round(totals.get("cost", 0) + cost, 4)
                    totals["turns"] = totals.get("turns", 0) + 1
                    chat["totals"] = totals
                    self.store.save_chat(pid, chat)
                    self.hub.add(pid, {
                        "kind": "usage", "model": model, "effort": effort, "steps": usage["steps"],
                        "input": usage["input"], "output": usage["output"], "cacheRead": usage["cacheRead"],
                        "cacheWrite": usage["cacheWrite"], "cost": round(cost, 4), "total": totals["cost"],
                        "seconds": round(time.time() - started, 1),
                    })
            except Exception:  # noqa: BLE001 - the project may have been deleted
                pass
            self.hub.flush(pid)
            with self._lock:
                self._turns.pop(pid, None)
            self._slots.release()
            self.hub.emit(pid, {"op": "running", "running": False})

    def _request_args(self, model: str, effort: str, messages: list[dict]) -> dict:
        cfg = MODELS[model]
        betas = []
        args = {
            "model": model,
            "max_tokens": 64000,
            "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            "tools": ALL_TOOLS,
            "messages": messages,
            "cache_control": {"type": "ephemeral"},
            "output_config": {"effort": effort},
        }
        if cfg["display"] == "updates":
            # short progress notes between tool calls come back as text; the reasoning stays hidden
            betas.append("thinking-display-updates-2026-08-18")
            args["thinking"] = {"type": "adaptive", "display": "updates"}
        else:
            args["thinking"] = {"type": "adaptive", "display": "summarized"}
        if cfg["fallbacks"]:
            # if the model declines on a safety check, the API retries on a fallback model in the same call
            betas.append("server-side-fallback-2026-07-01")
            args["fallbacks"] = "default"
        args["betas"] = betas
        return args

    def _stream_step(self, client: anthropic.Anthropic, pid: str, model: str, effort: str, messages: list[dict], stop: threading.Event):
        """One API call, streamed into the chat panel. Returns the final message and, for each tool call,
        the chat entry that shows it (so the tool's result can complete that entry)."""
        entries: dict[int, str] = {}  # content block index -> chat entry id
        kinds: dict[int, str] = {}
        tool_entries: dict[str, str] = {}  # tool_use id -> chat entry id
        with client.beta.messages.stream(**self._request_args(model, effort, messages)) as stream:
            for event in stream:
                if stop.is_set():
                    raise StopTurn()
                et = event.type
                if et == "content_block_start":
                    cb = event.content_block
                    kinds[event.index] = cb.type
                    if cb.type == "tool_use" and cb.name != "ask_style":
                        e = self.hub.add(pid, {"kind": "tool", "tool": cb.name, "label": TOOL_LABELS.get(cb.name, cb.name), "status": "running"})
                        entries[event.index] = e["id"]
                        tool_entries[cb.id] = e["id"]
                    elif cb.type == "server_tool_use":
                        e = self.hub.add(pid, {"kind": "tool", "tool": cb.name, "label": TOOL_LABELS.get(cb.name, cb.name), "status": "running"})
                        entries[event.index] = e["id"]
                    elif cb.type == "fallback":
                        self.hub.add(pid, {"kind": "note", "text": "The first model declined part of this; a fallback model continued."})
                elif et == "content_block_delta":
                    d = event.delta
                    if d.type == "text_delta" and d.text:
                        if event.index not in entries:
                            entries[event.index] = self.hub.add(pid, {"kind": "assistant", "text": ""})["id"]
                        self.hub.append_text(pid, entries[event.index], d.text)
                    elif d.type == "thinking_delta" and getattr(d, "thinking", ""):
                        if event.index not in entries:
                            entries[event.index] = self.hub.add(pid, {"kind": "progress", "text": ""})["id"]
                        self.hub.append_text(pid, entries[event.index], d.thinking)
                elif et == "content_block_stop":
                    if kinds.get(event.index) == "server_tool_use" and event.index in entries:
                        self.hub.patch(pid, entries[event.index], status="ok")
            final = stream.get_final_message()
        if final.stop_reason in ("refusal", "max_tokens"):
            # these tool calls won't run; don't leave their entries spinning
            for eid in tool_entries.values():
                self.hub.patch(pid, eid, status="error", detail="Not run")
        return final, tool_entries

    # ── user message ──

    def _user_content(self, pid: str, chat: dict, req: dict, engine: str = "api") -> list[dict]:
        content: list[dict] = []
        pending = chat.get("pending")
        choice = req.get("styleChoice")
        text = str(req.get("text") or "").strip()
        style_answer = None
        if pending:
            # answer the open style question first (tool results must lead the message)
            if pending.get("toolUseId") and engine == "api":
                content.extend(pending.get("results", []))
            option = next((o for o in pending.get("options", []) if o.get("id") == (choice or {}).get("optionId")), None)
            if option:
                answer = f"The user picked {option.get('name')}: {option.get('description', '')}"
            elif choice and choice.get("optionId") == "other":
                answer = "The user chose 'Other / my brand'." + (" Their message follows." if text else " They gave no details: use the brand kit, or ask in one line.")
            else:
                answer = "The user didn't pick a card." + (" Their message follows." if text else "")
            if pending.get("toolUseId") and engine == "api":
                content.append({"type": "tool_result", "tool_use_id": pending["toolUseId"], "content": answer})
            else:
                style_answer = "Answer to your style question: " + answer
            self.hub.patch(pid, pending["entryId"], chosen=option["id"] if option else ("other" if choice else "typed"))
        names = [str(n) for n in (req.get("attachments") or [])][:10]
        for name in names:
            content.extend(self._attachment_blocks(pid, name))
        parts = [self.store.state_summary(pid)]
        if style_answer:
            parts.append(style_answer)
        comment = req.get("comment")
        if comment:
            parts.append(
                f'<comment scene="{comment.get("sceneId")}" element="{comment.get("elementId") or ""}" at="{float(comment.get("at") or 0):.2f}">'
                + (f'Element text: "{str(comment.get("label") or "")[:120]}"' if comment.get("label") else "")
                + "</comment>"
            )
        if text:
            parts.append(text)
        elif choice:
            parts.append("(Style picked. Go ahead.)")
        content.append({"type": "text", "text": "\n\n".join(parts)})
        # the chat panel's copy of the message
        picked = None
        if choice:
            picked = next((o.get("name") for o in (pending or {}).get("options", []) if o.get("id") == choice.get("optionId")), "Other / my brand")
        self.hub.add(pid, {"kind": "user", "text": text or f"Picked: {picked}", "attachments": names, "comment": comment or None})
        return content

    def _attachment_blocks(self, pid: str, name: str) -> list[dict]:
        try:
            path = self.store.asset_path(pid, name)
        except StoreError:
            return [{"type": "text", "text": f"(The attachment {name} was not found.)"}]
        ext = path.suffix.lower()
        data = path.read_bytes()
        note = f"Attached file: asset://{name}"
        if ext in VISION_EXT and len(data) <= 5 * 1024 * 1024:
            size = image_size(path)
            if size:
                note += f" ({size[0]} x {size[1]} px)"
            return [
                {"type": "image", "source": {"type": "base64", "media_type": VISION_EXT[ext], "data": base64.standard_b64encode(data).decode()}},
                {"type": "text", "text": note + ". Scenes can show it with src=\"asset://" + name + "\"."},
            ]
        if ext == ".pdf" and len(data) <= 30 * 1024 * 1024:
            return [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": base64.standard_b64encode(data).decode()}, "title": name},
                {"type": "text", "text": note + " (PDF)."},
            ]
        if ext in TEXT_DOC_EXT:
            body = data.decode("utf-8", errors="replace")
            if len(body) > 400_000:
                return [{"type": "text", "text": f"{note}: a text file of {len(body):,} characters, too long to send whole. Ask the user which part matters."}]
            blocks = [{"type": "document", "source": {"type": "text", "media_type": "text/plain", "data": body}, "title": name}]
            seconds = source_seconds(body)
            if seconds >= 60:
                # A timed transcript of another video is a reference: research for the topic (what viewers ask,
                # what it gets wrong). It sets no length and no points to cover, and the script may not copy it.
                src = self.store.set_source(pid, name, body) if not self.store.get_source(pid) else None
                note = (
                    f"{name} is a reference ({fmt_clock(seconds)} by its timestamps): research for the topic only. "
                    "Never follow its outline, order, examples or length; the outline comes from the user's own experience and material."
                )
                if src:
                    note += f" read_source reads its {len(src['lines'])} timed lines."
                blocks.append({"type": "text", "text": note})
            return blocks
        return [{"type": "text", "text": f"{note} ({asset_kind(name)}, {len(data) / 1e6:.1f} MB)."}]

    def _ask_style(self, pid: str, chat: dict, ask, results: list[dict]) -> None:
        options, entry = self._style_entry(pid, ask.input if isinstance(ask.input, dict) else {})
        chat["pending"] = {"toolUseId": ask.id, "results": results, "options": options, "entryId": entry["id"]}
        self.store.save_chat(pid, chat)

    def _ask_style_cards(self, pid: str, args: dict) -> None:
        """The style question on Claude Code: the cards are shown, the pick comes back as the next message."""
        options, entry = self._style_entry(pid, args if isinstance(args, dict) else {})
        chat = self.store.load_chat(pid)
        chat["pending"] = {"toolUseId": None, "results": [], "options": options, "entryId": entry["id"]}
        self.store.save_chat(pid, chat)

    def _style_entry(self, pid: str, args: dict) -> tuple[list[dict], dict]:
        options = []
        for o in (args.get("options") or [])[:4]:
            if isinstance(o, dict) and o.get("name"):
                options.append({
                    "id": str(o.get("id") or len(options) + 1)[:12],
                    "name": str(o["name"])[:40],
                    "description": str(o.get("description", ""))[:200],
                    "palette": [c for c in (o.get("palette") or []) if br.to_hex(str(c))][:5],
                    "motion": o.get("motion") if o.get("motion") in ("snappy", "smooth") else "snappy",
                    "verb": str(o.get("verb", ""))[:24],
                })
        entry = self.hub.add(pid, {
            "kind": "style",
            "question": str(args.get("question") or "Which look?")[:200],
            "options": options,
            "allowOther": args.get("allowOther", True) is not False,
            "chosen": None,
        })
        return options, entry

    # ── tools ──

    def _ensure_snapshot(self, ctx: dict) -> None:
        if not ctx["snapshot"]:
            self.store.snapshot(ctx["pid"], "Before: " + ctx["label"])
            ctx["snapshot"] = True

    def _run_tool_args(self, ctx: dict, name: str, args, entry_id: str | None) -> dict:
        """Runs a tool given by name and arguments (how Claude Code calls them); returns {content, is_error}."""
        t = type("Call", (), {"id": "", "name": name, "input": args})()
        res = self._run_tool(ctx, t, entry_id)
        return {"content": res.get("content", ""), "is_error": bool(res.get("is_error"))}

    def _run_tool(self, ctx: dict, t, entry_id: str | None) -> dict:
        pid = ctx["pid"]
        args = t.input if isinstance(t.input, dict) else None
        try:
            if args is None:
                raise StoreError("INVALID_JSON: the tool input was not an object. Send the call again.")
            if t.name in MUTATING:
                self._ensure_snapshot(ctx)
            content, label = self._tool(pid, t.name, args)
            if entry_id:
                self.hub.patch(pid, entry_id, status="ok", label=label)
            return {"type": "tool_result", "tool_use_id": t.id, "content": content}
        except (StoreError, br.FetchError, rd.RenderError) as err:
            if entry_id:
                self.hub.patch(pid, entry_id, status="error", label=TOOL_LABELS.get(t.name, t.name), detail=str(err)[:300])
            return {"type": "tool_result", "tool_use_id": t.id, "is_error": True, "content": str(err)}
        except Exception as err:  # noqa: BLE001 - a tool bug must not end the turn
            if entry_id:
                self.hub.patch(pid, entry_id, status="error", label=TOOL_LABELS.get(t.name, t.name), detail=f"{type(err).__name__}: {err}"[:300])
            return {"type": "tool_result", "tool_use_id": t.id, "is_error": True, "content": f"The tool failed: {type(err).__name__}: {err}"[:800]}
        finally:
            self.hub.flush(pid)

    @staticmethod
    def _str(args: dict, key: str, required: bool = True) -> str | None:
        v = args.get(key)
        if v is None and not required:
            return None
        if not isinstance(v, str) or (required and not v.strip()):
            raise StoreError(f"INVALID_INPUT: {key} must be a non-empty string.")
        return v

    def _changed(self, pid: str, project: dict) -> None:
        self.hub.project_changed(pid, project["version"])

    def _review_text(self, pid: str) -> str:
        """The script check, for the storyboard and script tool results."""
        r = self.store.plan_review(pid)
        if r["problems"]:
            return "Before any scene code, fix:\n- " + "\n- ".join(r["problems"])
        if r["waiting"]:
            w = r["waiting"]
            slots = sum(len(x["asks"]) for x in w["slots"])
            return (
                "Script check passed. Now stop: the user puts the script in their own words and approves it before any scene code "
                f"({slots} place{'s' if slots != 1 else ''} left for their words). In a few lines, tell them it's ready in Script > Your words, "
                "list what each place asks for, and end your turn."
            )
        if r["window"]:
            return "Script check passed: the length and the wording are ready for scene code."
        return ""

    def _continue_note(self, pid: str, ctx: dict) -> str | None:
        """When Claude ends its turn in the middle of a build (some scenes written, some not), the message that
        sends it back to work. Stops when Claude made no progress since the last reminder, so a deliberate stop
        (the user asked to see a few scenes first) ends after one reminder."""
        if ctx["stop"].is_set() or ctx.get("asked"):
            return None
        try:
            p = self.store.get_project(pid)
        except Exception:  # noqa: BLE001 - the video was deleted
            return None
        scenes = [x for x in p["scenes"] if x.get("kind") not in CLOSING_KINDS]
        todo = [x["id"] for x in scenes if x.get("status") != "written"]
        done = len(scenes) - len(todo)
        if not todo or not done:
            return None
        nudges = ctx.get("nudges", 0)
        if nudges >= MAX_NUDGES or (nudges and ctx.get("doneAtNudge") == done):
            self.hub.add(pid, {"kind": "note", "text": f"Claude stopped with {len(todo)} scene{'s' if len(todo) != 1 else ''} still to write. Press Continue building, or send a message."})
            return None
        ctx["nudges"] = nudges + 1
        ctx["doneAtNudge"] = done
        self.hub.add(pid, {"kind": "note", "text": f"Continuing the build: {len(todo)} scene{'s' if len(todo) != 1 else ''} to go."})
        return (
            "(An automatic message from the tool, not from the user.) The build isn't finished: "
            f"{len(todo)} planned scene{'s' if len(todo) != 1 else ''} still have no code ({', '.join(todo[:40])}{' ...' if len(todo) > 40 else ''}). "
            "Keep going without asking: write them in order, the same way as the others, with a one-line update every five or so scenes. "
            "When every scene has code, run audit_video, fix what it finds, and finish the hand-off. "
            "If the user asked you to stop after some scenes, say so in one line and end your turn."
        )

    def _closing_guard(self, pid: str, ids: list) -> None:
        """The promo and the end screen belong to the video's settings: Claude doesn't write or edit them."""
        p = self.store.get_project(pid)
        kinds = {x["id"]: x.get("kind") for x in p["scenes"]}
        hit = [str(i) for i in ids if kinds.get(str(i)) in CLOSING_KINDS]
        if hit:
            raise StoreError(f"{', '.join(hit)} {'is' if len(hit) == 1 else 'are'} part of the closing (the AlgoInsight promo or the end screen), which the user controls in the video's settings. Leave {'it' if len(hit) == 1 else 'them'} as {'it is' if len(hit) == 1 else 'they are'}.")

    def _view_references(self, pid: str, a: dict) -> tuple[object, str]:
        """view_references: the screenshots of the source between from and to (source times), each as an image
        followed by its time, asset name and what is said then. More than `limit` (6, at most 12) in the range:
        an even spread over it, and the text says how many there are."""
        s = self.store
        refs = s.get_project(pid).get("references") or []
        if not refs:
            return "This video has no screenshots of its source (they come with a transcript made with Screenshots on).", "No screenshots of the source"
        try:
            lo = clock_seconds(a["from"]) if a.get("from") else 0.0
            hi = clock_seconds(a["to"]) if a.get("to") else float("inf")
        except (ValueError, TypeError, AttributeError):
            raise StoreError("INVALID_INPUT: from and to are source times like 1:40.") from None
        limit = a.get("limit", 6)
        if limit is None:
            limit = 6
        if isinstance(limit, bool) or not isinstance(limit, (int, float)):
            raise StoreError("INVALID_INPUT: limit is a number from 1 to 12.")
        limit = max(1, min(12, int(limit)))
        if a.get("from") and a.get("to"):
            where = f"between {ref_clock(lo)} and {ref_clock(hi)}"
        elif a.get("from"):
            where = f"from {ref_clock(lo)} on"
        elif a.get("to"):
            where = f"up to {ref_clock(hi)}"
        else:
            where = f"of the whole source, {ref_clock(refs[0]['t'])}-{ref_clock(refs[-1]['t'])}"
        hits = [r for r in refs if lo <= int(r["t"]) <= hi]  # whole seconds, as the times are shown
        if not hits:
            return f"No screenshots {where}. They run from {ref_clock(refs[0]['t'])} to {ref_clock(refs[-1]['t'])}.", "No screenshots of the source there"
        n = len(hits)
        shown = hits if n <= limit else ([hits[n // 2]] if limit == 1 else [hits[round(i * (n - 1) / (limit - 1))] for i in range(limit)])
        span = f"{ref_clock(hits[0]['t'])}-{ref_clock(hits[-1]['t'])}"
        head = f"{len(shown)} of {n} screenshots {where}"
        if n > len(shown):
            head += " (spread evenly; narrow from and to, or raise limit up to 12, to see the rest)"
        head += (
            ". Each image is followed by its source time and what is said then. Look at what the source shows at each point and how "
            "much it puts on one screen, then design your own page in the paper look: never copy their layout, words, brand, logos, "
            "characters, numbers or images, and never show these screenshots in the video."
        )
        out: list[dict] = [{"type": "text", "text": head}]
        for r in shown:
            try:
                data = s.asset_path(pid, r["asset"]).read_bytes()
            except StoreError:
                out.append({"type": "text", "text": f"[{ref_clock(r['t'])}] {r['asset']} is gone from the assets."})
                continue
            out.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(data).decode()}})
            said = r.get("text") or ""
            out.append({"type": "text", "text": f"[{ref_clock(r['t'])}] {r['asset']}: " + (f'"{said}"' if said else "(no speech)")})
        return out, f"Looked at {len(shown)} screenshot{'s' if len(shown) != 1 else ''} of the source ({span})"

    def _tool(self, pid: str, name: str, a: dict) -> tuple[object, str]:
        """Runs one tool. Returns (tool_result content, the label the chat shows)."""
        s = self.store
        if name in ("write_scene", "patch_scene", "set_props") and a.get("id"):
            self._closing_guard(pid, [a.get("id")])
        if name == "write_script" and isinstance(a.get("scenes"), list):
            self._closing_guard(pid, [e.get("id") for e in a["scenes"] if isinstance(e, dict)])
        if name == "write_storyboard":
            scenes = a.get("scenes")
            if not isinstance(scenes, list):
                raise StoreError("INVALID_INPUT: scenes must be a list.")
            p, notes = s.write_storyboard(
                pid, scenes, a.get("title"), a.get("aspect"), a.get("brief") if isinstance(a.get("brief"), dict) else None,
                a.get("targetMinutes"), a.get("plan"), bool(a.get("replaceOwnWords")),
            )
            self._changed(pid, p)
            total = sum(x["duration"] for x in p["scenes"])
            lines = [f'Storyboard saved: "{p["title"]}", {p["aspect"]}, {len(p["scenes"])} scenes, {fmt_clock(total)}.']
            lines += [f'- {x["id"]} "{x["name"]}" {x["duration"]} s, {x["transition"]}, {x.get("status")}' + (", the user's own words" if x.get("byUser") else "") for x in p["scenes"]]
            if notes:
                lines.append("Also: " + "; ".join(notes))
            review = self._review_text(pid)
            if review:
                lines.append(review)
            return "\n".join(lines), f"Planned {len(p['scenes'])} scenes ({fmt_clock(total)})"

        if name == "write_scene":
            sid = self._str(a, "id")
            html = self._str(a, "html")
            props = a.get("props") if isinstance(a.get("props"), dict) else {}
            levers = a.get("levers") if isinstance(a.get("levers"), list) else None
            text = {k: a[k] for k in ("narration", "label", "part") if isinstance(a.get(k), str)}
            text["replaceOwnWords"] = bool(a.get("replaceOwnWords"))
            current = s._find(s.get_project(pid), sid)
            if current.get("status") != "written":
                # A build starts only from a finished script: its plan chosen, a length the user set met, its own
                # wording, and, when the user puts it in their own words first, their approval. (Rewriting a
                # scene that already has code is an edit and is never held up.)
                review = s.plan_review(pid)
                if review["problems"]:
                    raise StoreError(
                        "Not saved: the script isn't ready for scene code yet. Fix these first (write_storyboard for the plan and the scenes, "
                        "write_script for the narration):\n- " + "\n- ".join(review["problems"])
                    )
                if review["waiting"]:
                    raise StoreError(
                        "Not saved: the user puts the script in their own words and approves it before any scene code "
                        "(Script > Your words). Tell them it's ready and end your turn; build the scenes after they approve it."
                    )
            p, warnings = s.write_scene(pid, sid, html, props, levers, a.get("name"), text)
            self._changed(pid, p)
            sc = next(x for x in p["scenes"] if x["id"] == sid)
            t = s.timing(pid, p, sc)
            msg = f"Scene {sid} saved (rev {sc['rev']}, {sc['duration']} s)."
            if t["narrated"]:
                msg += " Cue times now (s): " + ", ".join(f"cue({i})={c:.2f}" for i, c in enumerate(t["cues"])) + (" (estimated; real after Generate voice)" if not t["voiced"] else " (from the voice)")
            if warnings:
                msg += "\nFix these:\n- " + "\n- ".join(warnings)
            return msg, f"Wrote scene {sid} · {sc['name']}"

        if name == "write_script":
            entries = a.get("scenes")
            if not isinstance(entries, list):
                raise StoreError("INVALID_INPUT: scenes must be a list of {id, narration, label, part}.")
            p, notes = s.write_script(pid, entries, bool(a.get("replaceOwnWords")))
            self._changed(pid, p)
            total = sum(x["duration"] for x in p["scenes"])
            words = sum(s.timing(pid, p, x)["words"] for x in p["scenes"])
            msg = f"Script saved for {len(entries)} scene{'s' if len(entries) != 1 else ''}. The video is now about {fmt_clock(total)} ({words:,} spoken words)."
            if p.get("targetSeconds"):
                diff = (total - p["targetSeconds"]) / p["targetSeconds"] * 100
                msg += f" The length the user set is {fmt_clock(p['targetSeconds'])}: {'+' if diff >= 0 else ''}{diff:.0f} percent."
            elif (p.get("plan") or {}).get("minutes"):
                msg += f" The plan says about {p['plan']['minutes']:g} min."
            slots = sum(len(vc.slots(x.get("narration") or "")) for x in p["scenes"])
            if slots:
                msg += f" {slots} place{'s' if slots != 1 else ''} left for the user's own words."
            if notes:
                msg += "\nNarration to fix:\n- " + "\n- ".join(notes[:40])
            review = self._review_text(pid)
            if review:
                msg += "\n" + review
            return msg, f"Wrote the narration of {len(entries)} scene{'s' if len(entries) != 1 else ''} ({fmt_clock(total)})"

        if name == "read_source":
            src = s.get_source(pid)
            if not src:
                return "This video has no reference transcript.", "Read the reference"
            try:
                lo = clock_seconds(a["from"]) if a.get("from") else 0.0
                hi = clock_seconds(a["to"]) if a.get("to") else float("inf")
            except ValueError:
                raise StoreError("INVALID_INPUT: from and to are source times like 1:40.") from None
            rows = [f"[{fmt_clock(ln['t'])}] {ln['text']}" for ln in src["lines"] if lo <= ln["t"] <= hi]
            head = (
                f"{src['name']} ({fmt_clock(src['seconds'])}), a reference: research for the topic only (what viewers ask, what it "
                "gets wrong). Don't follow its outline, order, examples or length, and don't reuse its wording."
            )
            return head + "\n" + "\n".join(rows), f"Read the reference ({len(rows)} lines)"

        if name == "read_drawing":
            # the user's Excalidraw drawing, element by element, for drawing its parts on their own cues
            fname = self._str(a, "name")
            info = s.read_drawing(pid, fname)
            x, y, w, h = info["bounds"]
            rows = []
            for e in info["elements"][:400]:
                bx, by, bw, bh = e["box"]
                extra = [f'"{e["text"][:80]}"'] if e["text"] else []
                if e["groups"]:
                    extra.append("groups " + ",".join(e["groups"]))
                if e["frame"]:
                    extra.append(f'frame {e["frame"]}')
                if e["container"]:
                    extra.append(f'label of {e["container"]}')
                if e["name"]:
                    extra.append(f'named "{e["name"]}"')
                rows.append(f'- {e["id"]} {e["type"]} at {bx:g},{by:g} size {bw:g}x{bh:g}' + (" " + "; ".join(extra) if extra else ""))
            head = (
                f'{fname}: {len(info["elements"])} elements, bounds {x:g},{y:g} size {w:g}x{h:g} (drawing units; the drawing is scaled to fit its x-draw element)'
                + (f', {info["files"]} embedded image{"s" if info["files"] != 1 else ""}' if info["files"] else "")
                + ". Draw a part on its own cue with fx.drawPart(el, id or words, at); fx.drawIn draws the rest."
            )
            return head + "\n" + "\n".join(rows), f"Read the drawing {fname} ({len(info['elements'])} elements)"

        if name == "view_references":
            return self._view_references(pid, a)

        if name == "set_pronunciations":
            if not isinstance(a.get("entries"), list):
                raise StoreError("INVALID_INPUT: entries must be a list of {written, spoken}.")
            p = s.set_pronunciations(pid, a["entries"])
            self._changed(pid, p)
            table = "; ".join(f'{e["written"]} -> {e["spoken"]}' for e in p.get("pronunciations") or [])
            return "Pronunciations now: " + (table or "none"), f"Set {len(a['entries'])} pronunciation{'s' if len(a['entries']) != 1 else ''}"

        if name == "write_doc":
            fname = s.write_doc(pid, self._str(a, "name"), self._str(a, "content"))
            self.hub.emit(pid, {"op": "docs"})
            return f"Saved {fname}. The user sees it under Script > Documents.", f"Wrote {fname}"

        if name == "write_details":
            yt = a.get("youtube") if isinstance(a.get("youtube"), dict) else None
            ud = a.get("udemy") if isinstance(a.get("udemy"), dict) else None
            col = a.get("collection") if isinstance(a.get("collection"), dict) else None
            if yt is None and ud is None and col is None:
                raise StoreError("INVALID_INPUT: give youtube, udemy or collection details.")
            p, warnings = s.write_details(pid, yt, ud, col, bool(a.get("replace")))
            self._changed(pid, p)
            done = [k for k, v in (("YouTube", yt), ("Udemy", ud), ("playlist or course", col)) if v is not None]
            text = "Saved the " + " and ".join(done) + " details. The user sees and edits them in Details."
            if warnings:
                text += "\nWorth fixing:\n- " + "\n- ".join(warnings)
            return text, "Wrote the " + " and ".join(done) + " details"

        if name == "read_doc":
            name_ = self._str(a, "name")
            return s.read_doc(pid, name_ if name_.endswith(".md") else name_ + ".md"), f"Read {name_}"

        if name == "audit_video":
            ids = a.get("ids") if isinstance(a.get("ids"), list) else None
            bundle = s.bundle(pid)
            if ids is None:  # Claude's own scenes: the promo and the end screen aren't its to fix
                ids = [x["id"] for x in bundle["scenes"] if x.get("kind") not in CLOSING_KINDS]
            rows = self.render.call(self.render.audit, bundle, ids, timeout=900)
            problems = [r for r in rows if _issue_count(r) or r.get("words", 0) > 12]
            checked = len({r["id"] for r in rows if r["id"] != "*"})
            moments = sum(1 for r in rows if "gaps" not in r and "late" not in r)  # the timing rows aren't moments looked at
            if not problems:
                return f"Audit: {checked} scenes checked at {moments} moments and for their timing, no problems found.", f"Audited {checked} scenes: no problems"
            lines = [f"Audit: {checked} scenes checked at {moments} moments and for their timing; {len(problems)} problems:"]
            for r in problems[:80]:
                lines.append(f"- {r['id']} at {r['t']:.2f} s: " + _diag_line(r))
            return "\n".join(lines), f"Audited {checked} scenes: {len(problems)} problems"

        if name == "patch_scene":
            sid = self._str(a, "id")
            p, warnings, n = s.patch_scene(pid, sid, a.get("edits"))
            self._changed(pid, p)
            sc = next(x for x in p["scenes"] if x["id"] == sid)
            msg = f"Scene {sid} patched: {n} replacement{'s' if n != 1 else ''} (rev {sc['rev']})."
            if warnings:
                msg += "\nStill to check:\n- " + "\n- ".join(warnings)
            return msg, f"Edited scene {sid} · {sc['name']}"

        if name == "read_scene":
            sid = self._str(a, "id")
            p = s.get_project(pid)
            sc = s._find(p, sid)
            src = s.scene_source(pid, sid)
            t = s.timing(pid, p, sc)
            body = {
                "id": sid, "kind": sc.get("kind", "scene"), "name": sc["name"], "rev": sc.get("rev", 0), "duration": sc["duration"], "transition": sc["transition"],
                "label": sc.get("label", ""), "part": sc.get("part", ""), "narration": sc.get("narration", ""),
                "cues": t["cues"], "voiced": t["voiced"], "props": sc.get("props", {}), "levers": sc.get("levers", []),
            }
            return json.dumps(body, ensure_ascii=False, indent=1) + "\n\n" + (src if src is not None else "(no code yet)"), f"Read scene {sid}"

        if name == "set_props":
            sid = self._str(a, "id")
            if not isinstance(a.get("props"), dict):
                raise StoreError("INVALID_INPUT: props must be an object.")
            p = s.set_props(pid, sid, a["props"], bool(a.get("replace")))
            self._changed(pid, p)
            sc = next(x for x in p["scenes"] if x["id"] == sid)
            return f"Props of {sid} now: " + json.dumps(sc["props"], ensure_ascii=False), f"Changed props of {sid}"

        if name == "update_timeline":
            changes = a.get("changes") if isinstance(a.get("changes"), list) else None
            order = a.get("order") if isinstance(a.get("order"), list) else None
            if not changes and not order:
                raise StoreError("INVALID_INPUT: give changes and/or order.")
            p = s.update_timeline(pid, changes, order)
            self._changed(pid, p)
            total = sum(x["duration"] for x in p["scenes"])
            lines = [f"Timeline now ({total:.1f} s):"] + [f'- {x["id"]} {x["duration"]} s, {x["transition"]}' for x in p["scenes"]]
            return "\n".join(lines), f"Timeline updated ({_fmt_seconds(total)})"

        if name == "render_preview_frame":
            sid = self._str(a, "id")
            at = a.get("at")
            if not isinstance(at, (int, float)):
                raise StoreError("INVALID_INPUT: at must be a number of seconds.")
            bundle = s.bundle(pid)
            sc = next((x for x in bundle["scenes"] if x["id"] == sid), None)
            if not sc:
                raise StoreError(f"No scene {sid}.")
            if not sc.get("source"):
                raise StoreError(f"Scene {sid} has no code yet.")
            at = max(0.0, min(float(at), sc["duration"] - 0.001))
            img, diag = self.render.call(self.render.preview_frame, bundle, sid, at, 540, timeout=120)
            frames = s.renders_dir(pid) / "frames"
            frames.mkdir(exist_ok=True)
            fname = f"{sid}-{int(time.time() * 1000)}.jpg"
            (frames / fname).write_bytes(img)
            self.hub.add(pid, {"kind": "frame", "sceneId": sid, "at": round(at, 2), "url": f"/api/motion/projects/{pid}/frames/{fname}", "issues": _issue_count(diag)})
            return [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(img).decode()}},
                {"type": "text", "text": _diag_text(sid, at, diag)},
            ], f"Checked scene {sid} at {_fmt_seconds(at)}"

        if name == "write_thumbnail":
            # saved like a scene, then photographed at once: Claude sees the 1280 x 720 picture and its report
            html = self._str(a, "html")
            props = a.get("props") if isinstance(a.get("props"), dict) else {}
            p, warnings = s.write_thumbnail(pid, html, props)
            self._changed(pid, p)
            rev = (p.get("thumbnail") or {}).get("rev", 0)
            path, diag = thumbnail_image(s, self.render, pid, fresh=True)
            img = path.read_bytes()
            frames = s.renders_dir(pid) / "frames"
            frames.mkdir(exist_ok=True)
            fname = f"thumbnail-{int(time.time() * 1000)}.jpg"
            (frames / fname).write_bytes(img)  # the chat keeps this version's picture even after the next change
            self.hub.add(pid, {"kind": "frame", "sceneId": "thumbnail", "at": rd.THUMBNAIL_AT, "url": f"/api/motion/projects/{pid}/frames/{fname}", "issues": _issue_count(diag or {})})
            text = _diag_text(
                "thumbnail", rd.THUMBNAIL_AT, diag or {}, head=f"Thumbnail saved (rev {rev}). The first image is the thumbnail at YouTube's 1280 x 720.", max_words=THUMBNAIL_WORDS
            )
            # where it has to work: the feed, at 360 x 202, on the white and the dark page, with a colour check
            content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(img).decode()}}]
            try:
                length = fmt_clock(sum(float(x.get("duration") or 0) for x in p["scenes"]))
                kit = s.get_kit(p.get("brandKitId")) or {}
                channel = kit.get("wordmark") or kit.get("name") or ""
                feed, stats = self.render.call(self.render.thumbnail_feed, img, p["title"], length, channel, timeout=60)
                content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(feed).decode()}})
                text += (
                    "\nThe second image is the feed view: the thumbnail at YouTube's size between two plain placeholders, on the white page (top) and the dark one (bottom). "
                    f"Colour check: {round(stats['pale'] * 100)}% pale, {round(stats['dark'] * 100)}% dark, {round(stats['vivid'] * 100)}% strongly coloured."
                )
                warnings = warnings + thumbnail_colour_warnings(stats)
            except Exception as e:  # noqa: BLE001 - the thumbnail itself is saved; the feed view is a check
                text += f"\n(The feed view couldn't be made: {e})"
            if warnings:
                text += "\nFix these:\n- " + "\n- ".join(warnings)
            content.append({"type": "text", "text": text})
            return content, f"Designed the thumbnail (rev {rev})"

        if name == "find_icons":
            found = kitdata.find_icons(self._str(a, "query"), int(a.get("limit") or 30))
            lines = []
            if found["icons"]:
                lines.append("Icons (data-icon):")
                lines += [f"- {n}" + (f" ({', '.join(t)})" if t else "") for n, t in found["icons"]]
            if found["logos"]:
                lines.append("Logos (data-logo):")
                lines += [f"- {n}: {label}" for n, label in found["logos"]]
            return "\n".join(lines) or "Nothing matches: try a broader word (storage, network, message).", f"Found {len(found['icons'])} icons, {len(found['logos'])} logos"

        if name == "list_assets":
            # the references (screenshots of the source) are left out: view_references shows them
            refs = s.reference_assets(s.get_project(pid))
            items = [x for x in s.list_assets(pid) if x["name"] not in refs]
            text = json.dumps(items, ensure_ascii=False) if items else "No files uploaded yet."
            if refs:
                text += f"\n(Also {len(refs)} screenshots of the source, ref-*.jpg: layout references for view_references, never to show in the video.)"
            return text, "Listed the files"

        if name == "find_broll":
            # free stock (Pexels, Pixabay): candidates with their preview pictures, for Claude to look at
            try:
                cands = bl.search(
                    self._str(a, "query"), str(a.get("kind") or "video"), str(a.get("orientation") or "landscape"),
                    float(a.get("min_seconds") or 0), max(1, min(8, int(a.get("limit") or 6))),
                )
            except bl.BrollError as err:
                return str(err), "Searched for b-roll: nothing to show"
            if not cands:
                return "Nothing found: try other plain words (what is in the picture, not the idea it stands for).", "Searched for b-roll: nothing found"
            lines = [f"{len(cands)} candidates (their pictures follow, numbered the same). Import one with import_broll and its id."]
            pictures: list[dict] = []
            for i, c in enumerate(cands, 1):
                lines.append(f"{i}. {bl.describe(c)}")
                img = bl.preview(c.get("preview") or "")
                if img:
                    pictures.append({"type": "text", "text": f"{i}. {c['id']}"})
                    pictures.append({"type": "image", "source": {"type": "base64", "media_type": _picture_type(img), "data": base64.standard_b64encode(img).decode()}})
            lines.append("Both licences are free to use with no credit needed; import_broll keeps the credit in CREDITS.md anyway.")
            return [{"type": "text", "text": "\n".join(lines)}] + pictures, f"Found {len(cands)} b-roll candidates"

        if name == "import_broll":
            ffmpeg = rd.ffmpeg_exe(self.exports.find_ffmpeg())
            if not ffmpeg:
                raise StoreError("FFmpeg was not found, so stock clips can't be imported.")
            try:
                item = bl.import_stock(
                    s, pid, ffmpeg, self._str(a, "id"),
                    float(a["from"]) if isinstance(a.get("from"), (int, float)) else None,
                    float(a["seconds"]) if isinstance(a.get("seconds"), (int, float)) else None,
                    a.get("name") if isinstance(a.get("name"), str) and a.get("name").strip() else None,
                )
            except bl.BrollError as err:
                raise StoreError(str(err)) from None
            self.hub.emit(pid, {"op": "assets"})
            self.hub.emit(pid, {"op": "docs"})
            facts = f"{item['seconds']:.1f} s, {item['width']} x {item['height']}" + (f" at {item['fps']:g} fps" if item.get("fps") else "") if item["kind"] == "video" else f"{item['width']} x {item['height']}"
            how = '<video class="p-broll" data-id="..." data-src="asset://' + item["name"] + '"></video>' if item["kind"] == "video" else '<img class="p-broll" data-id="..." src="asset://' + item["name"] + '">'
            return f"Saved as asset://{item['name']} ({facts}); its credit is in CREDITS.md. Place it with {how} (see B-roll).", f"Imported {item['name']}"

        if name == "read_web_page":
            page = br.page_text(self._str(a, "url"))
            head = f"Page: {page['title'] or page['url']}\nLink: {page['url']}" + ("\n(Cut at 60,000 characters.)" if page["truncated"] else "")
            return head + "\n\n" + page["text"], f"Read {urllib.parse.urlsplit(page['url']).hostname}"

        if name == "import_asset":
            url = self._str(a, "url")
            data, ctype, final = br.fetch(url, max_bytes=25_000_000)
            fname = a.get("name") or Path(urllib.parse.urlsplit(final).path).name or "file"
            if "." not in fname:
                ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg", "image/webp": ".webp", "image/gif": ".gif", "audio/mpeg": ".mp3"}.get(ctype.split(";")[0].strip(), "")
                fname += ext
            item = s.save_asset(pid, safe_asset_name(fname), data)
            return f"Saved as asset://{item['name']} " + json.dumps(item), f"Imported {item['name']}"

        if name == "extract_brand":
            url = self._str(a, "url")
            info = br.extract(url)
            out: list[dict] = []
            try:
                shot = self.render.call(self.render.screenshot_url, info["source"]["url"], timeout=60)
                out.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(shot).decode()}})
            except Exception as err:  # noqa: BLE001 - the text findings are still useful
                out.append({"type": "text", "text": f"(No screenshot: {err})"[:300]})
            info.pop("inlineSvgLogo", None)
            out.append({"type": "text", "text": "Findings (a draft; decide the roles from the screenshot, then call save_brand_kit):\n" + json.dumps(info, ensure_ascii=False, indent=1)})
            return out, f"Read the brand of {urllib.parse.urlsplit(info['source']['url']).hostname}"

        if name == "save_brand_kit":
            data = {k: a.get(k) for k in ("name", "palette", "extras", "fonts", "radius", "motion", "background", "style", "endCard") if a.get(k) is not None}
            kit = s.create_kit(data, a.get("baseKitId") if isinstance(a.get("baseKitId"), str) else None)
            note = ""
            try:
                if isinstance(a.get("logoAsset"), str) and a["logoAsset"]:
                    path = s.asset_path(pid, a["logoAsset"])
                    kit = s.set_kit_logo(kit["id"], path.name, path.read_bytes())
                elif isinstance(a.get("logoUrl"), str) and a["logoUrl"]:
                    data_bytes, ctype, final = br.fetch(a["logoUrl"], max_bytes=5_000_000)
                    fname = Path(urllib.parse.urlsplit(final).path).name or "logo"
                    if "." not in fname:
                        fname += {"image/svg+xml": ".svg", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(ctype.split(";")[0].strip(), ".png")
                    kit = s.set_kit_logo(kit["id"], fname, data_bytes)
            except (StoreError, br.FetchError) as err:
                note = f" The logo could not be saved: {err}"
            p = s.update_project(pid, {"brandKitId": kit["id"]})
            self._changed(pid, p)
            self.hub.emit(pid, {"op": "kits"})
            return f'Brand kit "{kit["name"]}" saved as {kit["id"]} and this video now uses it.' + (" It has a logo." if kit.get("logo") else " It has no logo.") + note, f"Saved brand kit {kit['name']}"

        if name == "use_brand_kit":
            kid = self._str(a, "id")
            kit = s.get_kit(kid)
            if not kit:
                raise StoreError("No such kit. Kits: " + ", ".join(f'{k["id"]} ({k["name"]})' for k in s.list_kits()))
            p = s.update_project(pid, {"brandKitId": kid})
            self._changed(pid, p)
            return f'This video now uses the brand kit "{kit["name"]}".', f"Switched to {kit['name']}"

        if name == "export_video":
            res = a.get("resolution") or 1080
            job = self.exports.start(pid, int(res))
            return f"Export started ({res}p). The user sees its progress in the top bar.", f"Started the {job['resolution']}p export"

        raise StoreError(f"Unknown tool {name}.")


# gaps and late come from the player's timing check (audit_video): stretches where nothing moves while the
# voice talks, and elements that arrive after the phrase that should bring them has gone by
ISSUE_KEYS = ("errors", "offStage", "outsideSafe", "inZone", "overlaps", "crowded", "overflow", "smallText", "gaps", "late", "handChart", "penOver", "curvedArrow")


def _issue_count(diag: dict) -> int:
    return sum(len(diag.get(k) or []) for k in ISSUE_KEYS)


def _num_text(x) -> str:
    """A number of seconds as the report says it: one decimal (12.4), or ? when the player gave none."""
    try:
        return f"{float(x):.1f}"
    except (TypeError, ValueError):
        return "?"


def _late_text(x: dict) -> str:
    """One late entrance: "chip-a arrives late: cue(2) + 3.2 s lands 1.1 s into the next phrase (cue(3) at
    14.2 s); pin it to cue(3) or shorten the offset". nextCue is the time the next phrase starts (the voice's
    end after the last cue) and nextIndex its cue number, from the audit (render._timing_rows)."""
    who = x.get("id") or "an element"
    idx, when, into = x.get("nextIndex"), x.get("nextCue"), x.get("into")
    pinned = f"cue({x.get('cue')})" + (f" + {_num_text(x.get('plus'))} s" if x.get("plus") not in (None, 0) else "")
    if into is not None and idx is not None:
        where = f"lands {_num_text(into)} s into the next phrase (cue({idx}) at {_num_text(when)} s)"
        fix = f"pin it to cue({idx}) or shorten the offset"
    elif into is not None:
        where = f"lands {_num_text(into)} s after the voice ends (at {_num_text(when)} s)"
        fix = "bring it in while the voice still talks, or shorten the offset"
    else:
        where = f"lands at {_num_text(x.get('at'))} s, after the next phrase began"
        fix = "pin it to the cue whose words bring it, or shorten the offset"
    return f"{who} arrives late: {pinned} {where}; {fix}"


def _diag_line(d: dict) -> str:
    bits = []
    for gap in d.get("gaps") or []:
        bits.append(f"nothing moves from {_num_text(gap[0])} to {_num_text(gap[1])} s while the voice talks: add a change, a camera move or a flow there")
    for x in d.get("late") or []:
        bits.append(_late_text(x))
    if d.get("errors"):
        bits.append("ERRORS " + " | ".join(str(e) for e in d["errors"][:3]))
    if d.get("offStage"):
        bits.append("off the frame: " + ", ".join(d["offStage"][:6]))
    if d.get("outsideSafe"):
        bits.append("outside the content box: " + ", ".join(d["outsideSafe"][:6]))
    if d.get("inZone"):
        bits.append("in a reserved zone: " + ", ".join(d["inZone"][:6]))
    if d.get("overlaps"):
        bits.append("overlapping: " + ", ".join(" + ".join(p) for p in d["overlaps"][:4]))
    if d.get("crowded"):
        bits.append("too close (under 18 px apart, they look like they touch): " + ", ".join(" + ".join(p) for p in d["crowded"][:4]))
    if d.get("handChart"):
        bits.append("hand-drawn chart: use fx.chart (" + ", ".join(d["handChart"][:4]) + ")")
    if d.get("penOver"):
        bits.append(
            "a red pen mark runs over words or another card (move them apart, or link from a nearer side): "
            + ", ".join(f"{p[0]} over {p[1]}" for p in d["penOver"][:4])
        )
    if d.get("curvedArrow"):
        bits.append("curved arrow drawn by hand: draw it straight (M x y L x y) or as an elbow (" + ", ".join(d["curvedArrow"][:4]) + ")")
    if d.get("overflow"):
        bits.append(
            "words run into the box's padding or edge (size the box to its words, or shorten them): "
            + ", ".join(f'{x["id"]} by {x["px"]} px' for x in d["overflow"][:4])
        )
    if d.get("smallText"):
        bits.append("too small: " + ", ".join(f'{x["id"]} {x["px"]}px' for x in d["smallText"][:4]))
    if d.get("words", 0) > 12:
        bits.append(f"{d['words']} words on screen")
    return "; ".join(bits)


def _diag_text(sid: str, at: float, d: dict, head: str | None = None, max_words: int = 12) -> str:
    """The layout report that goes with a frame (render_preview_frame) or the thumbnail (write_thumbnail,
    which allows 5 words instead of 12)."""
    lines = [head or f"Scene {sid} at {at:.2f} s. The image is the frame, scaled down."]
    if d.get("errors"):
        lines.append("ERRORS: " + " | ".join(str(e) for e in d["errors"][:5]))
    if d.get("offStage"):
        lines.append("Off the stage: " + ", ".join(d["offStage"][:10]))
    if d.get("outsideSafe"):
        lines.append("Text outside the safe area or content box: " + ", ".join(d["outsideSafe"][:10]))
    if d.get("inZone"):
        lines.append("In a reserved zone (logo, label, title, narrator corner): " + ", ".join(d["inZone"][:10]))
    if d.get("overlaps"):
        lines.append("Overlapping text: " + ", ".join(" + ".join(p) for p in d["overlaps"][:8]))
    if d.get("smallText"):
        lines.append("Text too small: " + ", ".join(f'{x["id"]} ({x["px"]}px)' for x in d["smallText"][:8]))
    lines.append(f"Words on screen: {d.get('words', 0)}" + (f" (over {max_words})" if d.get("words", 0) > max_words else ""))
    visible = d.get("visible") or []
    if visible:
        lines.append("Visible elements: " + "; ".join(f'{v["id"]}' + (f' "{v["text"]}"' if v.get("text") else "") for v in visible[:25]))
    if not _issue_count(d):
        lines.insert(1, "No layout problems found.")
    return "\n".join(lines)


def _picture_type(data: bytes) -> str:
    """The media type of a preview picture from its first bytes (stock previews are mostly JPEG)."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/jpeg"
