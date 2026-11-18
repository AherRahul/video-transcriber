"""
The Claude Code engine: a chat turn run by Claude Code (through the Claude Agent SDK) instead of the API.

It uses the Claude Code login on this computer (the user's Claude plan), not an API key: the API key is
blanked in the child's environment so it can't take over. Motion's tools are served in-process as an MCP
server ("motion"); Claude Code's own file, shell and edit tools are switched off, so the only things it can
touch are this video (through those tools) and the web (WebSearch and WebFetch, for facts). The user's own
Claude Code settings, memory and hooks are not loaded (setting_sources=[]).

Each video keeps one Claude Code session and resumes it every turn. The style question works like this:
ask_style shows the cards and tells Claude to end its turn; the user's pick comes back as the next message.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
import time
from pathlib import Path

from .prompts import CLAUDE_CODE_NOTE, SYSTEM_PROMPT, TOOL_LABELS, TOOLS
from .store import StoreError


def system_prompt_file() -> str:
    """The system prompt as a file, for the CLI's --system-prompt-file. It no longer fits on the command
    line: Windows caps a whole command line at 32,767 characters and the prompt alone is over 31,000. Past
    the cap the CLI can't even start, and Windows' "the filename or extension is too long" reaches the SDK
    as a FileNotFoundError, reported as "Claude Code not found at ...\\claude.exe" though the file is there.
    The file is named by its content, so turns running at once share it and a changed prompt gets a new one;
    it is written again whenever the temp folder has been cleared."""
    data = (SYSTEM_PROMPT + CLAUDE_CODE_NOTE).encode("utf-8")
    path = Path(tempfile.gettempdir()) / "motion" / f"system-prompt-{hashlib.sha256(data).hexdigest()[:16]}.md"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_bytes(data)  # bytes: the text exactly, no newline translation
        os.replace(tmp, path)
    return str(path)

BUILTIN_TOOLS = ["WebSearch", "WebFetch", "TodoWrite"]


def available() -> dict:
    """Whether the SDK and its bundled Claude Code are installed, and whether a login seems to exist."""
    try:
        import claude_agent_sdk  # noqa: F401
    except ImportError:
        return {"ready": False, "reason": "The Claude Agent SDK is not installed (pip install -r backend\\requirements.txt)."}
    sdk = Path(claude_agent_sdk.__file__).parent
    bundled = sdk / "_bundled" / ("claude.exe" if os.name == "nt" else "claude")
    version = (sdk / "_bundled" / "claude.version").read_text().strip() if (sdk / "_bundled" / "claude.version").exists() else None
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))
    logged_in = (home / ".credentials.json").exists() or (Path.home() / ".claude.json").exists()
    return {"ready": bundled.exists(), "version": version, "loggedIn": logged_in, "reason": None if bundled.exists() else "Claude Code is missing from the SDK."}


def _mcp_content(content) -> list[dict]:
    """A tool result in the Anthropic block format, as MCP content (text and images pass through)."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    out = []
    for b in content:
        if b.get("type") == "image":
            src = b.get("source", {})
            out.append({"type": "image", "data": src.get("data", ""), "mimeType": src.get("media_type", "image/jpeg")})
        elif b.get("type") == "text":
            out.append({"type": "text", "text": b.get("text", "")})
    return out or [{"type": "text", "text": "(no output)"}]


class ClaudeCodeTurn:
    """One turn: build the tools, send the message, stream what comes back into the chat panel."""

    def __init__(self, agent, pid: str, model: str, effort: str, stop, ctx: dict):
        self.agent = agent
        self.hub = agent.hub
        self.store = agent.store
        self.pid = pid
        self.model = model
        self.effort = effort
        self.stop = stop
        self.ctx = ctx
        self.result: dict = {}
        self._blocks: dict[int, dict] = {}  # stream index -> {"kind", "entry"}
        self._builtin: dict[str, str] = {}  # tool_use id -> chat entry, for WebSearch / WebFetch / TodoWrite

    # ── tools ──

    def _make_tools(self):
        from claude_agent_sdk import tool

        made = []
        for spec in TOOLS:
            made.append(tool(spec["name"], spec["description"], spec["input_schema"])(self._handler(spec["name"])))
        return made

    def _handler(self, name: str):
        async def run(args: dict) -> dict:
            if self.stop.is_set():
                return {"content": [{"type": "text", "text": "Stopped by the user. End your turn."}], "is_error": True}
            if name == "ask_style":
                self.agent._ask_style_cards(self.pid, args)
                self.ctx["asked"] = True
                return {"content": [{"type": "text", "text": "The style cards are shown to the user. End your turn now with no more tool calls; their pick arrives as the next message."}]}
            entry = self.hub.add(self.pid, {"kind": "tool", "tool": name, "label": TOOL_LABELS.get(name, name), "status": "running"})
            res = await asyncio.to_thread(self.agent._run_tool_args, self.ctx, name, args, entry["id"])
            out = {"content": _mcp_content(res.get("content", ""))}
            if res.get("is_error"):
                out["is_error"] = True
            return out

        return run

    # ── the message ──

    async def _messages(self, blocks: list[dict]):
        yield {"type": "user", "message": {"role": "user", "content": blocks}, "parent_tool_use_id": None}

    def _on_stream(self, event: dict) -> None:
        et = event.get("type")
        if et == "message_start":
            self._blocks = {}
        elif et == "content_block_start":
            cb = event.get("content_block") or {}
            idx = event.get("index", 0)
            if cb.get("type") == "tool_use" and cb.get("name") in BUILTIN_TOOLS:
                e = self.hub.add(self.pid, {"kind": "tool", "tool": cb["name"], "label": TOOL_LABELS.get(cb["name"], cb["name"]), "status": "running"})
                self._builtin[cb.get("id", "")] = e["id"]
            self._blocks[idx] = {"kind": cb.get("type"), "entry": None}
        elif et == "content_block_delta":
            d = event.get("delta") or {}
            b = self._blocks.setdefault(event.get("index", 0), {"kind": None, "entry": None})
            if d.get("type") == "text_delta" and d.get("text"):
                if not b["entry"]:
                    b["entry"] = self.hub.add(self.pid, {"kind": "assistant", "text": ""})["id"]
                self.hub.append_text(self.pid, b["entry"], d["text"])
            elif d.get("type") == "thinking_delta" and d.get("thinking"):
                if not b["entry"]:
                    b["entry"] = self.hub.add(self.pid, {"kind": "progress", "text": ""})["id"]
                self.hub.append_text(self.pid, b["entry"], d["thinking"])

    async def run(self, blocks: list[dict], session_id: str | None) -> dict:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ClaudeSDKClient,
            ResultMessage,
            StreamEvent,
            SystemMessage,
            UserMessage,
            create_sdk_mcp_server,
        )
        from claude_agent_sdk.types import ToolResultBlock

        server = create_sdk_mcp_server("motion", "1.0.0", self._make_tools())
        names = [f"mcp__motion__{t['name']}" for t in TOOLS]
        stderr_tail: list[str] = []
        options = ClaudeAgentOptions(
            system_prompt={"type": "file", "path": system_prompt_file()},  # too long for a Windows command line
            mcp_servers={"motion": server},
            strict_mcp_config=True,
            tools=list(BUILTIN_TOOLS),
            allowed_tools=names + BUILTIN_TOOLS,
            resume=session_id,
            model=self.model,
            effort=self.effort,
            include_partial_messages=True,
            setting_sources=[],
            cwd=str(self.store._dir(self.pid)),
            env={"ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""},  # use the Claude Code login, never the API key
            max_turns=400,
            stderr=lambda line: stderr_tail.append(line[-300:]) if len(stderr_tail) < 50 else None,
        )
        interrupted = False
        async with ClaudeSDKClient(options=options) as client:
            await client.query(self._messages(blocks))
            async for msg in client.receive_response():
                if self.stop.is_set() and not interrupted:
                    interrupted = True
                    await client.interrupt()
                if isinstance(msg, StreamEvent):
                    self._on_stream(msg.event)
                elif isinstance(msg, SystemMessage) and msg.subtype == "init":
                    self.result["sessionId"] = msg.data.get("session_id")
                elif isinstance(msg, AssistantMessage):
                    if msg.error:
                        self.hub.add(self.pid, {"kind": "error", "text": _assistant_error(str(msg.error))})
                elif isinstance(msg, UserMessage) and isinstance(msg.content, list):
                    for b in msg.content:
                        if isinstance(b, ToolResultBlock) and b.tool_use_id in self._builtin:
                            self.hub.patch(self.pid, self._builtin.pop(b.tool_use_id), status="error" if b.is_error else "ok")
                elif isinstance(msg, ResultMessage):
                    self.result.update(
                        sessionId=msg.session_id,
                        cost=msg.total_cost_usd or 0.0,
                        usage=msg.usage or {},
                        turns=msg.num_turns,
                        isError=msg.is_error,
                        text=msg.result,
                        subtype=msg.subtype,
                    )
        for eid in self._builtin.values():
            self.hub.patch(self.pid, eid, status="ok")
        if interrupted:
            self.result["interrupted"] = True
        if self.result.get("isError") and not interrupted:
            detail = self.result.get("text") or self.result.get("subtype") or "unknown error"
            if not self.result.get("text") and stderr_tail:
                detail += " | " + stderr_tail[-1]
            raise StoreError(_assistant_error(detail))
        return self.result


def _assistant_error(text: str) -> str:
    low = text.lower()
    if "login" in low or "authentication" in low or "api key" in low or "oauth" in low:
        return "Claude Code isn't logged in on this computer. Open a terminal, run `claude`, log in with your Claude account, then try again (or switch the engine to API key in the Claude menu)."
    if ("rate" in low and "limit" in low) or "usage limit" in low:
        return "Your Claude plan's usage limit is reached for now. Try again later, or switch the engine to API key in the Claude menu."
    return f"Claude Code: {text}"[:600]


def run_turn(agent, pid: str, blocks: list[dict], model: str, effort: str, stop, ctx: dict, session_id: str | None) -> dict:
    """Runs one Claude Code turn to the end (on the calling thread's own event loop)."""
    started = time.time()
    loop = asyncio.ProactorEventLoop() if os.name == "nt" else asyncio.new_event_loop()
    try:
        result = loop.run_until_complete(ClaudeCodeTurn(agent, pid, model, effort, stop, ctx).run(blocks, session_id))
    finally:
        loop.close()
    result["seconds"] = round(time.time() - started, 1)
    return result

