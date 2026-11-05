import { useMemo, useRef, useState } from "react";

import type { Transcript } from "./api";
import { findShortForms, suggestSay, type ShortForm } from "./shortForms";
import { buildPrompt, defaultOptions, LANGUAGES, promptFileName, type PromptOptions } from "./videoPrompt";

/** The choices worth keeping from one video to the next (the rest belong to each video). */
const REMEMBER = "video-prompt-defaults";
type Remembered = Pick<PromptOptions, "language" | "length" | "stopForOk" | "timestamps">;

function remembered(): Partial<Remembered> {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER) ?? "{}") as Partial<Remembered>;
  } catch {
    return {};
  }
}
function remember(o: PromptOptions) {
  try {
    const keep: Remembered = { language: o.language, length: o.length, stopForOk: o.stopForOk, timestamps: o.timestamps };
    localStorage.setItem(REMEMBER, JSON.stringify(keep));
  } catch {
    /* storage unavailable: the defaults just don't carry over */
  }
}

/**
 * The video prompt for a finished transcript: generated straight away from the transcript, its short forms found
 * and given a way to be said, every choice editable, ready to copy or download.
 */
export default function PromptPanel({ transcript }: { transcript: Transcript }) {
  const [opts, setOpts] = useState<PromptOptions>(() => ({ ...defaultOptions(transcript), ...remembered() }));
  const [forms, setForms] = useState<ShortForm[]>(() => findShortForms(transcript));
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const prompt = useMemo(() => buildPrompt(transcript, opts, forms), [transcript, opts, forms]);
  const chosen = forms.filter((f) => f.include).length;

  function set<K extends keyof PromptOptions>(key: K, value: PromptOptions[K]) {
    setOpts((o) => {
      const next = { ...o, [key]: value };
      remember(next);
      return next;
    });
  }
  function setForm(i: number, patch: Partial<ShortForm>) {
    setForms((fs) => fs.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  }
  function addForm() {
    setForms((fs) => [...fs, { form: "", say: "", count: 0, include: true, from: "added" }]);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([prompt], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = promptFileName(opts, transcript);
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="card prompt" aria-labelledby="prompt-title">
      <div className="result-head">
        <div className="result-title">
          <h2 id="prompt-title">Video prompt</h2>
          <p className="muted small">
            Paste this to Claude to build the daily video from this transcript. It is written as you change anything
            below.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={copy}>
            {copied ? "Copied" : "Copy prompt"}
          </button>
          <button type="button" className="btn" onClick={download}>
            .md
          </button>
        </div>
      </div>

      <div className="prompt-grid">
        <label className="wide">
          <span className="label">Topic</span>
          <input type="text" value={opts.topic} onChange={(e) => set("topic", e.target.value)} />
        </label>
        <label>
          <span className="label">Language</span>
          <select value={opts.language} onChange={(e) => set("language", e.target.value as PromptOptions["language"])}>
            {Object.entries(LANGUAGES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Length (minutes)</span>
          <input type="text" value={opts.length} onChange={(e) => set("length", e.target.value)} maxLength={20} />
        </label>
        <label className="wide">
          <span className="label">Episode</span>
          <input type="text" value={opts.episode} onChange={(e) => set("episode", e.target.value)} />
        </label>
        <label className="wide">
          <span className="label">Anything special</span>
          <textarea
            rows={2}
            placeholder="A demo you want, examples to use or avoid"
            value={opts.special}
            onChange={(e) => set("special", e.target.value)}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.stopForOk} onChange={(e) => set("stopForOk", e.target.checked)} />
          Stop for my OK after the script, before the screens
        </label>
        <label className="check">
          <input type="checkbox" checked={opts.includeTranscript} onChange={(e) => set("includeTranscript", e.target.checked)} />
          Put the transcript in the prompt
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={opts.timestamps}
            onChange={(e) => set("timestamps", e.target.checked)}
            disabled={!opts.includeTranscript}
          />
          With timestamps
        </label>
      </div>

      <div className="forms-head">
        <h3>Short forms and how to say them</h3>
        <span className="muted small">
          {forms.length ? `${chosen} of ${forms.length} in the prompt` : "None found in the transcript"}
        </span>
      </div>
      <p className="muted small">
        Found in the transcript, including English letters written in Hindi (सीआईसीडी is CI/CD). Write each one the
        way the captions should show it, and how the voice should say it: letters joined by hyphens (C-I C-D), the word
        (yammel), or the name as written (GitHub).
      </p>
      {forms.length ? (
        <div className="forms" role="table" aria-label="Short forms">
          <div className="forms-row forms-labels" role="row">
            <span role="columnheader">Use</span>
            <span role="columnheader">Written</span>
            <span role="columnheader">Said</span>
            <span role="columnheader">Seen</span>
          </div>
          {forms.map((f, i) => (
            <div className={f.include ? "forms-row" : "forms-row forms-off"} role="row" key={i}>
              <input type="checkbox" checked={f.include} onChange={(e) => setForm(i, { include: e.target.checked })} aria-label={`Use ${f.form || "this short form"}`} />
              <input
                type="text"
                value={f.form}
                placeholder="e.g. K8s"
                aria-label="Written"
                onChange={(e) => {
                  const form = e.target.value;
                  // a new row says nothing yet: suggest how to say what was typed
                  setForm(i, f.from === "added" && (!f.say || f.say === suggestSay(f.form).say) ? { form, ...suggestSay(form) } : { form });
                }}
              />
              <input type="text" value={f.say} placeholder="e.g. Kubernetes" aria-label="Said" onChange={(e) => setForm(i, { say: e.target.value, check: false })} />
              <span className="muted small">
                {f.from === "added" ? "added" : `${f.count}×${f.from === "hindi" ? " (Hindi)" : ""}`}
                {f.check ? <span className="chip chip-check" title="A guess: it may be said as a word">check</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <button type="button" className="btn btn-small" onClick={addForm}>
        Add a short form
      </button>

      <label className="prompt-preview">
        <span className="label">The prompt</span>
        <textarea readOnly value={prompt} rows={16} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
      </label>
    </section>
  );
}
