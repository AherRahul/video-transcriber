// The chat panel: Claude's messages, progress notes and tool steps as they stream in, the frames it
// checked, the style question as clickable cards, and the message box (attachments, slash commands).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { bytesLabel, motionApi } from "./api";
import Markdown from "./Markdown";
import type { Asset, LogEntry, StyleOption } from "./types";

export type SendInput = { text: string; attachments: string[]; styleChoice?: { optionId: string } };
export type Command = "export" | "undo" | "new" | "clear";

type Props = {
  projectId: string;
  log: LogEntry[];
  running: boolean;
  assets: Asset[];
  initialDraft: { text: string; attachments: string[] } | null;
  onSend: (msg: SendInput) => Promise<void>;
  onStop: () => void;
  onCommand: (cmd: Command) => void;
  onAssetsChanged: () => void;
  blocked: string | null;
  // planned scenes with no code yet, and scenes written: a build that stopped part-way offers Continue building
  unwritten: number;
  written: number;
};

const CONTINUE_TEXT = "Continue building: write the remaining scenes in order, then run the audit, fix what it finds and finish the hand-off.";

const EXAMPLES = [
  "A narrated explainer in our daily paper look on the topic of the attached video (research only, not our outline): ask me for my take and my numbers first, then a draft with places for my own words.",
  "A 30-second 9:16 reel explaining consistent hashing: a hook question, the hash ring builds step by step, one takeaway, end card.",
  "A 20-second 16:9 animated bar chart of our monthly sign-ups. Use [YOUR NUMBERS] where you need data.",
  "A 6-second logo sting for our brand: the logo draws itself, then the tagline.",
  "Turn the attached transcript into a 45-second explainer reel with the three key ideas.",
];

const COMMANDS: { cmd: Command; help: string }[] = [
  { cmd: "export", help: "Export the MP4 (1080p)" },
  { cmd: "undo", help: "Undo the last change" },
  { cmd: "clear", help: "Start a new chat (keeps the scenes)" },
  { cmd: "new", help: "Start a new video" },
];

const MODEL_SHORT: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
};

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function duration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function StyleCards({ entry, active, onPick }: { entry: Extract<LogEntry, { kind: "style" }>; active: boolean; onPick: (id: string) => void }) {
  const card = (o: StyleOption) => (
    <button key={o.id} type="button" className={`mo-style-card ${entry.chosen === o.id ? "chosen" : ""}`} disabled={!active} onClick={() => onPick(o.id)}>
      <span className="mo-swatches" aria-hidden="true">
        {o.palette.map((c, i) => (
          <i key={i} style={{ background: c }} />
        ))}
      </span>
      <span className="mo-style-name">{o.name}</span>
      {o.verb ? <span className="chip mo-verb">{o.verb}</span> : null}
      <span className="mo-style-desc">{o.description}</span>
    </button>
  );
  return (
    <div className="mo-style">
      <div className="mo-style-q">{entry.question}</div>
      <div className="mo-style-grid">
        {entry.options.map(card)}
        {entry.allowOther ? (
          <button type="button" className={`mo-style-card other ${entry.chosen === "other" ? "chosen" : ""}`} disabled={!active} onClick={() => onPick("other")}>
            <span className="mo-style-name">Other / my brand</span>
            <span className="mo-style-desc">Describe the look, paste hex codes or a website.</span>
          </button>
        ) : null}
      </div>
      {entry.chosen === "typed" ? <div className="muted small">Answered in a message.</div> : null}
    </div>
  );
}

export default function Chat({ projectId, log, running, assets, initialDraft, onSend, onStop, onCommand, onAssetsChanged, blocked, unwritten, written }: Props) {
  const [text, setText] = useState(initialDraft?.text ?? "");
  const [attachments, setAttachments] = useState<string[]>(initialDraft?.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  const lastStyle = useMemo(() => {
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.kind === "style") return e.id;
      if (e.kind === "user") return null;
    }
    return null;
  }, [log]);

  // keep the newest message in view unless the user scrolled up
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await motionApi.uploadAssets(projectId, files);
      setAttachments((a) => [...new Set([...a, ...saved.map((s) => s.name)])]);
      onAssetsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function submit(styleChoice?: { optionId: string }) {
    const trimmed = text.trim();
    if (!styleChoice && trimmed.startsWith("/")) {
      const cmd = COMMANDS.find((c) => trimmed === "/" + c.cmd);
      if (cmd) {
        setText("");
        onCommand(cmd.cmd);
        return;
      }
    }
    if (!trimmed && !styleChoice && !attachments.length) return;
    setError(null);
    try {
      const choice = styleChoice ?? (other && lastStyle ? { optionId: "other" } : undefined);
      await onSend({ text: trimmed, attachments, styleChoice: choice });
      setText("");
      setAttachments([]);
      setOther(false);
      stick.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const pickStyle = (id: string) => {
    if (id === "other") {
      setOther(true);
      inputRef.current?.focus();
      return;
    }
    void submit({ optionId: id });
  };

  const showCommands = text.startsWith("/") && !text.includes(" ");

  return (
    <div
      className={`mo-chat ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(Array.from(e.dataTransfer.files));
      }}
    >
      <div
        className="mo-log"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {log.length === 0 ? (
          <div className="mo-welcome">
            <h3>What should the video show?</h3>
            <p className="muted">
              One sentence is enough. It helps to say who it's for, where it will play and how long it should be. Claude asks one
              question about the look, plans the scenes and writes them while you watch.
            </p>
            <div className="mo-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="mo-example" onClick={() => (setText(ex), inputRef.current?.focus())}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {log.map((e) => {
          switch (e.kind) {
            case "user":
              return (
                <div key={e.id} className="mo-msg mo-user">
                  {e.comment ? (
                    <div className="mo-comment-tag">
                      On {e.comment.elementId ? <code>{e.comment.elementId}</code> : "a spot"} in scene {e.comment.sceneId} at {e.comment.at.toFixed(1)} s
                    </div>
                  ) : null}
                  {e.text ? <div className="mo-user-text">{e.text}</div> : null}
                  {e.attachments?.length ? (
                    <div className="mo-attached">
                      {e.attachments.map((a) => (
                        <span key={a} className="chip">
                          {a}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            case "assistant":
              return (
                <Markdown key={e.id} className="mo-msg mo-assistant mo-md-chat" text={e.text} />
              );
            case "progress":
              return e.text.trim() ? (
                <div key={e.id} className="mo-progress">
                  {e.text}
                </div>
              ) : null;
            case "tool":
              return (
                <div key={e.id} className={`mo-tool ${e.status}`} title={e.detail}>
                  <span className="mo-tool-icon" aria-hidden="true">
                    {e.status === "running" ? <span className="spinner" /> : e.status === "ok" ? "✓" : "!"}
                  </span>
                  <span>{e.label}</span>
                  {e.status === "error" && e.detail ? <span className="mo-tool-detail">{e.detail}</span> : null}
                </div>
              );
            case "frame":
              return (
                <div key={e.id} className="mo-frame-check">
                  <button type="button" onClick={() => setZoom(e.url)} title="Show larger">
                    <img src={e.url} alt={`Scene ${e.sceneId} at ${e.at} s`} loading="lazy" />
                  </button>
                  <span className="muted small">
                    Checked {e.sceneId} at {e.at} s{e.issues ? ` · ${e.issues} issue${e.issues > 1 ? "s" : ""}` : " · looks fine"}
                  </span>
                </div>
              );
            case "style":
              return <StyleCards key={e.id} entry={e} active={!running && !e.chosen && e.id === lastStyle} onPick={pickStyle} />;
            case "usage":
              return (
                <div
                  key={e.id}
                  className="mo-usage"
                  title={
                    e.engine === "claude-code"
                      ? `Claude Code on your Claude plan. The dollar figure is what the same tokens would cost on the API; your plan isn't billed per token. Total so far: ${e.total.toFixed(2)}`
                      : `Cache writes ${tokens(e.cacheWrite)}. Total for this video so far: ${e.total.toFixed(2)}`
                  }
                >
                  {e.engine === "claude-code" ? "Claude Code · " : ""}
                  {MODEL_SHORT[e.model] ?? e.model} · {e.effort} · {e.steps} step{e.steps > 1 ? "s" : ""} · {tokens(e.input + e.cacheRead + e.cacheWrite)} in
                  {e.cacheRead ? ` (${tokens(e.cacheRead)} cached)` : ""} · {tokens(e.output)} out · ~${e.cost.toFixed(2)}
                  {e.engine === "claude-code" ? " at API prices (plan)" : ""} · {duration(e.seconds)}
                </div>
              );
            case "error":
              return (
                <div key={e.id} className="mo-error" role="alert">
                  {e.text}
                </div>
              );
            case "note":
              return (
                <div key={e.id} className="mo-note">
                  {e.text}
                </div>
              );
            case "divider":
              return (
                <div key={e.id} className="mo-divider">
                  <span>{e.text}</span>
                </div>
              );
            default:
              return null;
          }
        })}
        {running ? (
          <div className="mo-working">
            <span className="spinner" aria-hidden="true" /> Claude is working…
          </div>
        ) : unwritten > 0 && written > 0 ? (
          <div className="mo-continue">
            <span>
              {unwritten} planned scene{unwritten > 1 ? "s have" : " has"} no code yet.
            </span>
            <button
              type="button"
              className="btn btn-primary btn-small"
              disabled={!!blocked}
              onClick={() => {
                setError(null);
                stick.current = true;
                onSend({ text: CONTINUE_TEXT, attachments: [] }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
              }}
            >
              Continue building
            </button>
          </div>
        ) : null}
      </div>

      <div className="mo-composer">
        {showCommands ? (
          <div className="mo-commands">
            {COMMANDS.filter((c) => ("/" + c.cmd).startsWith(text)).map((c) => (
              <button key={c.cmd} type="button" onClick={() => (setText(""), onCommand(c.cmd))}>
                <code>/{c.cmd}</code> {c.help}
              </button>
            ))}
          </div>
        ) : null}
        {other ? (
          <div className="mo-other-hint">
            Describe the look you want (colours, fonts, a website or a brand guide).{" "}
            <button type="button" className="linkish" onClick={() => setOther(false)}>
              Cancel
            </button>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="mo-attached">
            {attachments.map((a) => {
              const info = assets.find((x) => x.name === a);
              return (
                <span key={a} className="chip mo-attach-chip">
                  {/* a b-roll clip: a small preview once it is converted */}
                  {info?.kind === "video" && info.state !== "converting" ? (
                    <video className="mo-attach-clip" src={motionApi.assetUrl(projectId, a)} preload="metadata" muted playsInline aria-hidden="true" />
                  ) : null}
                  {a}
                  {info?.kind === "video" ? (
                    <span className="muted"> {info.state === "converting" ? "converting..." : `${(info.seconds ?? 0).toFixed(1)} s`}</span>
                  ) : info ? (
                    <span className="muted"> {bytesLabel(info.bytes)}</span>
                  ) : null}
                  <button type="button" aria-label={`Remove ${a}`} onClick={() => setAttachments((x) => x.filter((n) => n !== a))}>
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
        {error ? <div className="error small">{error}</div> : null}
        {blocked ? <div className="banner banner-warn small">{blocked}</div> : null}
        <div className="mo-input-row">
          <button type="button" className="btn mo-attach" onClick={() => fileRef.current?.click()} disabled={uploading} title="Attach images, a video clip (b-roll), a PDF, a text file or audio">
            {uploading ? <span className="spinner" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 6.5 8.4 14.6a2 2 0 0 0 2.8 2.8l8.1-8.1a4 4 0 0 0-5.6-5.6l-8.4 8.4a6 6 0 0 0 8.5 8.5l7.4-7.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,audio/*,video/*,.mp4,.mov,.webm,.mkv,.m4v,.pdf,.txt,.md,.csv,.json,.srt,.vtt,.svg,.woff,.woff2,.ttf,.otf,.excalidraw"
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={running ? "Claude is working. You can type your next message." : "Describe the video, or what to change…  (/ for commands)"}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void upload(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!running) void submit();
              }
            }}
          />
          {running ? (
            <button type="button" className="btn mo-stop" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!!blocked || uploading || (!text.trim() && !attachments.length)}>
              Send
            </button>
          )}
        </div>
      </div>
      {dragging ? <div className="mo-drop">Drop files to attach them</div> : null}
      {zoom ? (
        <div className="mo-zoom" role="dialog" aria-label="Checked frame" onClick={() => setZoom(null)}>
          <img src={zoom} alt="Checked frame" />
        </div>
      ) : null}
    </div>
  );
}
