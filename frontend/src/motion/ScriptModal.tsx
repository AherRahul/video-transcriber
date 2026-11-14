// The Script dialog: the whole narration scene by scene (with parts, labels and timings), the YouTube
// chapters (one per part, final once the voice exists), and the documents Claude wrote for this video
// (FACTS.md with sources, YOUTUBE.md with titles, description, tags and the thumbnail idea).

import { useEffect, useState } from "react";

import { clock, motionApi } from "./api";
import Markdown from "./Markdown";
import type { ScriptView } from "./types";

/** Headings, lists, tables, links and paragraphs; <cue/> marks become small pins. */
function MarkdownView({ text }: { text: string }) {
  return <Markdown className="mo-md" text={text} cues />;
}

export default function ScriptModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [view, setView] = useState<ScriptView | null>(null);
  const [tab, setTab] = useState<string>("script");
  const [doc, setDoc] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    motionApi.script(projectId).then(setView).catch((err) => setError(err.message));
  }, [projectId]);

  useEffect(() => {
    if (tab === "script" || tab === "chapters") return;
    setDoc("");
    motionApi.doc(projectId, tab).then(setDoc).catch((err) => setError(err.message));
  }, [projectId, tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => null);
  const chaptersText = (view?.chapters ?? []).map((c) => `${clock(c.start)} ${c.title}`).join("\n");

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
          <button type="button" role="tab" className={tab === "script" ? "on" : ""} onClick={() => setTab("script")}>
            Script
          </button>
          <button type="button" role="tab" className={tab === "chapters" ? "on" : ""} onClick={() => setTab("chapters")}>
            Chapters
          </button>
          {(view?.docs ?? []).map((d) => (
            <button key={d.name} type="button" role="tab" className={tab === d.name ? "on" : ""} onClick={() => setTab(d.name)}>
              {d.name}
            </button>
          ))}
        </div>
        <div className="mo-modal-body">
          {error ? <p className="error">{error}</p> : null}
          {!view ? <span className="spinner" /> : null}
          {view && tab === "script" ? <MarkdownView text={view.markdown} /> : null}
          {view && tab === "chapters" ? (
            view.chapters.length ? (
              <>
                <pre className="mo-chapters">{chaptersText}</pre>
                <p className="muted small">One chapter per part, at the time its first scene starts. They are final once every scene has its voice.</p>
              </>
            ) : (
              <p className="muted">No parts yet: chapters come from the scenes' parts.</p>
            )
          ) : null}
          {view && tab !== "script" && tab !== "chapters" ? doc ? <MarkdownView text={doc} /> : <span className="spinner" /> : null}
        </div>
        <footer className="mo-modal-foot">
          <span />
          {tab === "script" && view ? (
            <>
              <button type="button" className="btn" onClick={() => copy(view.markdown)}>
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
        </footer>
      </div>
    </div>
  );
}
