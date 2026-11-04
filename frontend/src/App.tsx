import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { downloadUrl, getHealth, getJob, startJob, type Health, type Job } from "./api";
import { clock, linkAt, paragraphs, plainText, SOURCE_HINT, SOURCE_LABEL } from "./format";

const MODEL_HINT: Record<string, string> = {
  tiny: "Fastest, least accurate",
  base: "Fast, fair accuracy",
  small: "Balanced (recommended)",
  medium: "Most accurate, slowest",
};

const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting",
  info: "Reading the video",
  captions: "Looking for captions",
  downloading: "Downloading the audio",
  "loading-model": "Loading the speech model",
  decoding: "Preparing the audio",
  transcribing: "Turning speech into text",
};

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [url, setUrl] = useState("");
  const [language, setLanguage] = useState("");
  const [model, setModel] = useState("small");
  const [forceWhisper, setForceWhisper] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    getHealth()
      .then((h) => {
        setHealth(h);
        setModel(h.defaultModel);
      })
      .catch(() => setHealthError(true));
  }, []);

  // Poll the job until it finishes.
  const jobId = job?.id;
  const finished = job?.state === "done" || job?.state === "error";
  useEffect(() => {
    if (!jobId || finished) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      getJob(jobId, controller.signal)
        .then(setJob)
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setJob((j) => (j ? { ...j, state: "error", message: err instanceof Error ? err.message : String(err) } : j));
        });
    }, 1000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [jobId, finished]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setStartError(null);
    setStarting(true);
    try {
      const id = await startJob(trimmed, { language, model, forceWhisper });
      setJob({ id, url: trimmed, state: "queued", stage: "queued", percent: null, message: "Starting" });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const busy = starting || (job !== null && !finished);

  return (
    <div className="page">
      <header className="header">
        <h1>Video Transcriber</h1>
        <p className="muted">Paste a video link from YouTube, X, LinkedIn, Facebook or most other sites, or a direct video file link.</p>
      </header>

      {healthError ? (
        <div className="banner banner-error" role="alert">
          The transcriber service is not running. Start it with <code>backend\run.ps1</code>, then reload this page.
        </div>
      ) : null}
      {health && !health.ffmpeg ? (
        <div className="banner banner-warn" role="status">
          FFmpeg was not found, so some sites (streamed video) may fail.
        </div>
      ) : null}

      <form className="card form" onSubmit={onSubmit}>
        <label htmlFor="url" className="label">
          Video URL
        </label>
        <div className="row">
          <input
            id="url"
            type="url"
            inputMode="url"
            required
            placeholder="https://www.youtube.com/watch?v=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
            {busy ? "Working…" : "Transcribe"}
          </button>
        </div>

        <details className="options">
          <summary>Options</summary>
          <div className="options-grid">
            <label>
              <span className="label">Language</span>
              <input
                type="text"
                placeholder="Auto-detect (e.g. en, hi, fr)"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={busy}
                maxLength={12}
              />
            </label>
            <label>
              <span className="label">Speech model (when there are no captions)</span>
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                {(health?.models ?? ["tiny", "base", "small", "medium"]).map((m) => (
                  <option key={m} value={m}>
                    {m} — {MODEL_HINT[m] ?? ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={forceWhisper}
                onChange={(e) => setForceWhisper(e.target.checked)}
                disabled={busy}
              />
              Ignore the video's captions and always use speech-to-text
            </label>
          </div>
        </details>
        {startError ? (
          <p className="error" role="alert">
            {startError}
          </p>
        ) : null}
      </form>

      {job && job.state !== "done" ? <JobStatus job={job} onRetry={() => setJob(null)} /> : null}
      {job?.state === "done" && job.transcript ? <TranscriptView job={job} /> : null}
    </div>
  );
}

function JobStatus({ job, onRetry }: { job: Job; onRetry: () => void }) {
  if (job.state === "error") {
    return (
      <section className="card status" role="alert">
        <h2>Could not transcribe this video</h2>
        <p className="error">{job.message}</p>
        <button type="button" className="btn" onClick={onRetry}>
          Try another
        </button>
      </section>
    );
  }
  const label = STAGE_LABEL[job.stage] ?? job.message;
  return (
    <section className="card status" role="status" aria-live="polite">
      <div className="status-line">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
        {job.percent !== null ? <span className="muted">{Math.round(job.percent)}%</span> : null}
      </div>
      <div className="bar" aria-hidden="true">
        <div
          className={job.percent === null ? "bar-fill bar-indeterminate" : "bar-fill"}
          style={job.percent === null ? undefined : { width: `${job.percent}%` }}
        />
      </div>
      {job.stage === "transcribing" || job.stage === "loading-model" || job.stage === "decoding" ? (
        <p className="muted small">
          This video has no captions, so the speech is being transcribed on this computer. That takes a while for long
          videos. The first run also downloads the speech model.
        </p>
      ) : null}
    </section>
  );
}

function TranscriptView({ job }: { job: Job }) {
  const t = job.transcript!;
  const [timestamps, setTimestamps] = useState(true);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  const paras = useMemo(() => paragraphs(t), [t]);
  const q = query.trim().toLowerCase();
  const shown = q ? paras.filter((p) => p.text.toLowerCase().includes(q)) : paras;
  const words = useMemo(() => t.segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0), [t]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(plainText(t, timestamps));
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="card result">
      <div className="result-head">
        <div className="result-title">
          <h2>
            <a href={t.url} target="_blank" rel="noopener noreferrer">
              {t.title}
            </a>
          </h2>
          <div className="meta">
            <span className={`chip chip-${t.source}`} title={SOURCE_HINT[t.source]}>
              {SOURCE_LABEL[t.source]}
            </span>
            {t.language ? <span className="muted">Language: {t.language}</span> : null}
            {t.duration ? <span className="muted">Length: {clock(t.duration)}</span> : null}
            <span className="muted">{words.toLocaleString()} words</span>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
          <a className="btn" href={downloadUrl(job.id, "txt", timestamps)}>
            .txt
          </a>
          <a className="btn" href={downloadUrl(job.id, "srt", true)}>
            .srt
          </a>
          <a className="btn" href={downloadUrl(job.id, "vtt", true)}>
            .vtt
          </a>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="search"
          placeholder="Search the transcript"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the transcript"
        />
        <label className="check">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          Timestamps
        </label>
      </div>

      {shown.length === 0 ? <p className="muted">No match for “{query}”.</p> : null}
      <div className="transcript">
        {shown.map((p) => {
          const href = linkAt(t.url, p.start);
          return (
            <p key={p.start} className="para">
              {timestamps ? (
                href ? (
                  <a className="ts" href={href} target="_blank" rel="noopener noreferrer" title="Open the video here">
                    {clock(p.start)}
                  </a>
                ) : (
                  <span className="ts">{clock(p.start)}</span>
                )
              ) : null}
              <span>{q ? <Highlight text={p.text} query={q} /> : p.text}</span>
            </p>
          );
        })}
      </div>
    </section>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const hit = lower.indexOf(query, i);
    if (hit < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(<mark key={k++}>{text.slice(hit, hit + query.length)}</mark>);
    i = hit + query.length;
  }
  return <>{parts}</>;
}
