// The Script dialog: "Your words" (Claude's draft for the user to rewrite and approve before any scene
// code), the whole narration scene by scene (with parts, labels and timings), the YouTube chapters (one
// per part, final once the voice exists), and the documents Claude wrote for this video (FACTS.md with
// sources, notes; older videos also have a YOUTUBE.md). The publishing details are in Details.

import { useEffect, useState } from "react";

import { clock, motionApi } from "./api";
import Markdown from "./Markdown";
import ScriptWords from "./ScriptWords";
import type { ProjectView, ScriptView } from "./types";

/** Headings, lists, tables, links and paragraphs; <cue/> marks become small pins. */
function MarkdownView({ text }: { text: string }) {
  return <Markdown className="mo-md" text={text} cues />;
}

type Props = {
  projectId: string;
  view: ProjectView;
  running: boolean;
  /** the tab to open on ("words" when the script waits for the user) */
  initialTab?: string;
  onSaved: (view: ProjectView) => void;
  /** after the user approves the script: ask Claude to build the scenes */
  onBuild: () => void;
  onClose: () => void;
};

export default function ScriptModal({ projectId, view, running, initialTab, onSaved, onBuild, onClose }: Props) {
  const script = view.script;
  const [scriptView, setScriptView] = useState<ScriptView | null>(null);
  const [tab, setTab] = useState<string>(initialTab ?? (script?.waiting ? "words" : "script"));
  const [doc, setDoc] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const version = view.project.version;

  // the script as text follows every saved change (the user's words, Claude's edits)
  useEffect(() => {
    motionApi.script(projectId).then(setScriptView).catch((err) => setError(err.message));
  }, [projectId, version]);

  useEffect(() => {
    if (tab === "script" || tab === "chapters" || tab === "words") return;
    setDoc("");
    motionApi.doc(projectId, tab).then(setDoc).catch((err) => setError(err.message));
  }, [projectId, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => null);
  const chaptersText = (scriptView?.chapters ?? []).map((c) => `${clock(c.start)} ${c.title}`).join("\n");
  const slotsLeft = (script?.slots ?? []).reduce((n, x) => n + x.asks.length, 0);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await motionApi.approveScript(projectId));
      onBuild();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await motionApi.reopenScript(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const wordsFooter = () => {
    if (!script?.narrated) return <span />;
    if (script.approved) {
      return (
        <>
          <span className="muted small">Approved: Claude builds the scenes from this script and leaves your words as they are.</span>
          <button type="button" className="btn" disabled={busy || running} onClick={() => void reopen()} title="Claude waits for you again before writing more scenes">
            Take the approval back
          </button>
        </>
      );
    }
    const why = running ? "Claude is working on this video" : slotsLeft ? `${slotsLeft} place${slotsLeft === 1 ? "" : "s"} still wait for your words` : "";
    return (
      <>
        <span className="muted small">{script.review ? "Claude waits for your approval before writing any scene." : "The wait for your words is off for this video (Video settings)."}</span>
        <button type="button" className="btn btn-primary" disabled={busy || running || slotsLeft > 0} onClick={() => void approve()} title={why || "Approve the script and ask Claude to build the scenes"}>
          Approve and build the scenes
        </button>
      </>
    );
  };

  return (
    <div className="mo-modal-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mo-modal mo-script" role="dialog" aria-modal="true" aria-label="Script and documents">
        <header className="mo-modal-head">
          <h2>Script and documents</h2>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="mo-script-tabs" role="tablist">
          <button type="button" role="tab" className={tab === "words" ? "on" : ""} onClick={() => setTab("words")}>
            Your words{slotsLeft ? ` (${slotsLeft})` : ""}
          </button>
          <button type="button" role="tab" className={tab === "script" ? "on" : ""} onClick={() => setTab("script")}>
            Script
          </button>
          <button type="button" role="tab" className={tab === "chapters" ? "on" : ""} onClick={() => setTab("chapters")}>
            Chapters
          </button>
          {(scriptView?.docs ?? []).map((d) => (
            <button key={d.name} type="button" role="tab" className={tab === d.name ? "on" : ""} onClick={() => setTab(d.name)}>
              {d.name}
            </button>
          ))}
        </div>
        <div className="mo-modal-body">
          {error ? <p className="error">{error}</p> : null}
          {tab === "words" ? <ScriptWords projectId={projectId} view={view} running={running} onSaved={onSaved} /> : null}
          {tab !== "words" && !scriptView ? <span className="spinner" /> : null}
          {scriptView && tab === "script" ? <MarkdownView text={scriptView.markdown} /> : null}
          {scriptView && tab === "chapters" ? (
            scriptView.chapters.length ? (
              <>
                <pre className="mo-chapters">{chaptersText}</pre>
                <p className="muted small">One chapter per part, at the time its first scene starts. They are final once every scene has its voice.</p>
              </>
            ) : (
              <p className="muted">No parts yet: chapters come from the scenes' parts.</p>
            )
          ) : null}
          {scriptView && tab !== "script" && tab !== "chapters" && tab !== "words" ? doc ? <MarkdownView text={doc} /> : <span className="spinner" /> : null}
        </div>
        <footer className="mo-modal-foot">
          {tab === "words" ? (
            wordsFooter()
          ) : (
            <>
              <span />
              {tab === "script" && scriptView ? (
                <>
                  <button type="button" className="btn" onClick={() => copy(scriptView.markdown)}>
                    Copy
                  </button>
                  <a className="btn btn-primary" href={motionApi.scriptUrl(projectId)} download>
                    Download .md
                  </a>
                </>
              ) : tab === "chapters" ? (
                <button type="button" className="btn btn-primary" onClick={() => copy(chaptersText)} disabled={!chaptersText}>
                  Copy chapters
                </button>
              ) : (
                <>
                  <button type="button" className="btn" onClick={() => copy(doc)} disabled={!doc}>
                    Copy
                  </button>
                  <a className="btn btn-primary" href={motionApi.docUrl(projectId, tab)} download={tab}>
                    Download
                  </a>
                </>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
