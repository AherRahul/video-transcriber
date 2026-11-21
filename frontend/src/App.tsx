import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  cancelJob,
  deleteJob,
  downloadUrl,
  getHealth,
  getJob,
  listJobs,
  retryFailed,
  retryJob,
  splitLinks,
  startJob,
  type Frames,
  type Health,
  type Job,
} from "./api";
import { clock, linkAt, paragraphs, plainText, SOURCE_HINT, SOURCE_LABEL } from "./format";
import MotionApp from "./motion/MotionApp";
import NewVideoDialog, { type NewVideoSource } from "./motion/NewVideoDialog";
import PromptPanel from "./PromptPanel";
import ScreenshotsView, { useFrames } from "./Screenshots";

const MODEL_HINT: Record<string, string> = {
  tiny: "Fastest, least accurate",
  base: "Fast, fair accuracy",
  small: "Balanced (recommended)",
  medium: "Most accurate, slowest",
};

// a stage the server words itself ("waiting": which limit it waits for, and how many run at once) has no label here
const STAGE_LABEL: Record<string, string> = {
  queued: "Waiting to start",
  info: "Reading the video",
  captions: "Looking for captions",
  downloading: "Downloading the audio",
  "loading-model": "Loading the speech model",
  decoding: "Preparing the audio",
  transcribing: "Turning speech into text",
};

/** The address after # picks the screen: #/ the transcriber, #/motion the Motion library, #/motion/<id> a video. */
function useHashRoute(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [hash, (h: string) => (window.location.hash = h)];
}

export default function App() {
  const [hash, navigate] = useHashRoute();
  const motion = hash.startsWith("#/motion");
  const projectId = motion ? (hash.match(/^#\/motion\/([a-z0-9]+)/)?.[1] ?? null) : null;
  return (
    <>
      <nav className="topnav" aria-label="Sections">
        <span className="topnav-brand">Video Transcriber</span>
        <a href="#/" className={!motion ? "on" : ""} aria-current={!motion ? "page" : undefined}>
          Transcribe
        </a>
        <a href="#/motion" className={motion ? "on" : ""} aria-current={motion ? "page" : undefined}>
          Motion
        </a>
      </nav>
      {/* the transcriber stays mounted, so a running transcription survives a look at Motion */}
      <div hidden={motion}>
        <Transcriber />
      </div>
      {motion ? <MotionApp projectId={projectId} navigate={navigate} /> : null}
    </>
  );
}

/** Still being transcribed (waiting or running). */
const isActive = (j: Job) => j.state === "queued" || j.state === "running";
/** Its screenshots are still coming (the transcript itself is done). */
const shotsActive = (j: Job) => j.frames?.state === "waiting" || j.frames?.state === "running";

/**
 * The transcriber: paste one link or many, and every video goes into the list below, where each shows how
 * far it has got. Several run at the same time on the server (the downloads, the speech-to-text and the
 * screenshots each have their own limit), so the form never locks: more links can be added while others
 * run. A row opens its transcript, screenshots and video prompt underneath.
 */
function Transcriber() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [links, setLinks] = useState("");
  const [language, setLanguage] = useState("");
  const [model, setModel] = useState("small");
  const [forceWhisper, setForceWhisper] = useState(false);
  const [screenshots, setScreenshots] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // finished jobs with their transcripts, each fetched once (the list carries none)
  const [details, setDetails] = useState<Record<string, Job>>({});
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [refresh, setRefresh] = useState(0); // bumped to read the list again now (after a start, cancel or remove)

  useEffect(() => {
    getHealth()
      .then((h) => {
        setHealth(h);
        setModel(h.defaultModel);
      })
      .catch(() => setHealthError(true));
  }, []);

  // The list: read now, then every second while anything is waiting or running; a settled list rests.
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = () => {
      listJobs(controller.signal)
        .then((list) => {
          setJobs(list);
          setListError(null);
          if (list.some((j) => isActive(j) || shotsActive(j))) timer = window.setTimeout(load, 1000);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          // an app started before this page was built has no list (405): it needs a restart
          setListError(/405|Method Not Allowed/i.test(msg) ? "The app is older than this page: restart it (backend\\run.ps1), then reload." : msg);
          timer = window.setTimeout(load, 3000);
        });
    };
    load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const selectedDone = selected?.state === "done";

  // a finished transcript is fetched once, when its row is opened
  useEffect(() => {
    if (!selectedId || !selectedDone || details[selectedId]) return;
    const controller = new AbortController();
    getJob(selectedId, controller.signal)
      .then((j) => setDetails((d) => ({ ...d, [j.id]: j })))
      .catch(() => null);
    return () => controller.abort();
  }, [selectedId, selectedDone, details]);

  const shown = selectedDone && selectedId ? (details[selectedId] ?? null) : null;
  // The screenshots come after the transcript, with their own progress (the transcript is shown meanwhile).
  const frames = useFrames(shown?.id ?? null, !!shown?.transcript);

  const found = splitLinks(links);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStartError(null);
    if (!found.length) {
      setStartError("Paste a full video link, starting with http:// or https://.");
      return;
    }
    setStarting(true);
    const started: string[] = [];
    const failed: string[] = [];
    for (const link of found) {
      try {
        started.push(await startJob(link, { language, model, forceWhisper, screenshots }));
      } catch (err) {
        failed.push(link);
        setStartError(`${link}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setStarting(false);
    setLinks(failed.join("\n")); // the links that didn't start stay in the box
    // the first new video opens when nothing is open yet; an open transcript stays open
    if (started.length && !selectedId) setSelectedId(started[0]);
    setRefresh((n) => n + 1);
  }

  async function onCancel(id: string) {
    try {
      await cancelJob(id);
    } finally {
      setRefresh((n) => n + 1);
    }
  }

  async function onRemove(id: string) {
    try {
      await deleteJob(id);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
    if (selectedId === id) setSelectedId(null);
    setDetails((d) => {
      const { [id]: _gone, ...rest } = d;
      return rest;
    });
    setRefresh((n) => n + 1);
  }

  // the options a retried video uses when the app can't retry it in place (see retryJob): the form's own
  const fallbackOptions = () => ({ language, model, forceWhisper, screenshots });

  async function onRetry(job: Job) {
    setStartError(null);
    try {
      const id = await retryJob(job, fallbackOptions());
      if (selectedId === job.id) setSelectedId(id);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
    setRefresh((n) => n + 1);
  }

  async function onRetryFailed() {
    setStartError(null);
    try {
      await retryFailed(jobs.filter((j) => j.state === "error"), fallbackOptions());
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
    setRefresh((n) => n + 1);
  }

  async function clearFinished() {
    const done = jobs.filter((j) => !isActive(j) && !shotsActive(j));
    for (const j of done) await deleteJob(j.id).catch(() => null);
    if (selectedId && done.some((j) => j.id === selectedId)) setSelectedId(null);
    setDetails({});
    setRefresh((n) => n + 1);
  }

  return (
    <div className="page">
      <header className="header">
        <h1>Video Transcriber</h1>
        <p className="muted">
          Paste one or more video links from YouTube, X, LinkedIn, Facebook or most other sites, or direct video file links. They are transcribed side
          by side.
        </p>
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
          Video links <span className="muted small">(one or more, one per line)</span>
        </label>
        <div className="row row-top">
          <textarea
            id="url"
            className="links"
            rows={found.length > 1 || links.includes("\n") ? 4 : 1}
            placeholder="https://www.youtube.com/watch?v=…"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
            onKeyDown={(e) => {
              // Enter starts them, as the one-line box did; Shift+Enter adds a line for another link
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            spellCheck={false}
            autoFocus
          />
          <button type="submit" className="btn btn-primary" disabled={starting || !found.length}>
            {starting ? "Adding…" : found.length > 1 ? `Transcribe ${found.length} videos` : "Transcribe"}
          </button>
        </div>
        <p className="muted small hint">
          Shift+Enter for a new line.{" "}
          {health?.parallel
            ? `Up to ${health.parallel.speech} videos are turned into text at once and the rest wait their turn; a video with captions is done in seconds.`
            : null}
        </p>

        <details className="options">
          <summary>Options</summary>
          <p className="muted small options-note">These apply to the links you add next.</p>
          <div className="options-grid">
            <label>
              <span className="label">Language</span>
              <input
                type="text"
                placeholder="Auto-detect (e.g. en, hi, fr)"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                maxLength={12}
              />
            </label>
            <label>
              <span className="label">Speech model (when there are no captions)</span>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {(health?.models ?? ["tiny", "base", "small", "medium"]).map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {MODEL_HINT[m] ? ` - ${MODEL_HINT[m]}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={forceWhisper} onChange={(e) => setForceWhisper(e.target.checked)} />
              Ignore the video's captions and always use speech-to-text
            </label>
            <label className="check">
              <input type="checkbox" checked={screenshots} onChange={(e) => setScreenshots(e.target.checked)} />
              <span>
                Screenshots for layout references{" "}
                <span className="muted">(the video at each new scene, with what is said, for Motion)</span>
              </span>
            </label>
          </div>
        </details>
        {startError ? (
          <p className="error" role="alert">
            {startError}
          </p>
        ) : null}
      </form>

      {listError ? (
        <div className="banner banner-error" role="alert">
          {listError}
        </div>
      ) : null}

      {jobs.length ? (
        <JobList
          jobs={jobs}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onCancel={onCancel}
          onRemove={onRemove}
          onRetry={onRetry}
          onRetryFailed={onRetryFailed}
          onClear={clearFinished}
        />
      ) : null}

      {selected && selected.state !== "done" ? <JobStatus job={selected} onRemove={() => onRemove(selected.id)} onRetry={() => onRetry(selected)} /> : null}
      {selectedDone && !shown ? (
        <section className="card status" role="status">
          <div className="status-line">
            <span className="spinner" aria-hidden="true" /> Opening the transcript
          </div>
        </section>
      ) : null}
      {/* each of the three siblings below has a key of its own: two with the same key are drawn twice by React,
          and a click lands on the copy it no longer manages */}
      {shown?.transcript ? <TranscriptView key={`transcript-${shown.id}`} job={shown} frames={frames} /> : null}
      {/* the screenshots under the transcript: their progress, then the grid */}
      {shown?.transcript ? (
        // its own key (a sibling's key must differ from PromptPanel's), so a new job starts it afresh
        <ScreenshotsView key={`shots-${shown.id}`} jobId={shown.id} videoUrl={shown.transcript.url} frames={frames} />
      ) : null}
      {/* the prompt that builds a video from this transcript, written as soon as the transcript is ready */}
      {shown?.transcript ? <PromptPanel key={shown.id} transcript={shown.transcript} /> : null}
    </div>
  );
}

/** What a row says under its title: the step it is on, why it waits, or what came out. */
function jobLine(j: Job): string {
  if (j.state === "error") return j.attempts && j.attempts > 1 ? `${j.message} (tried ${j.attempts} times)` : j.message;
  if (j.state === "cancelled") return "Cancelled";
  if (j.state === "done") {
    const s = j.summary;
    const parts = [s ? SOURCE_LABEL[s.source] : "Done"];
    const length = s?.duration ?? j.duration;
    if (length) parts.push(clock(length));
    if (j.frames?.state === "waiting" || j.frames?.state === "running") parts.push(j.frames.message || "Taking screenshots");
    else if (j.frames?.state === "done") parts.push(j.frames.message || "Screenshots ready");
    return parts.join(" · ");
  }
  const label = STAGE_LABEL[j.stage] ?? j.message;
  return j.percent !== null ? `${label} · ${Math.round(j.percent)}%` : label;
}

/**
 * Every video in the server's memory, newest first: running ones with their progress bar, waiting ones
 * with what they wait for, finished ones with where the text came from. A row opens its transcript below.
 */
function JobList({
  jobs,
  selectedId,
  onOpen,
  onCancel,
  onRemove,
  onRetry,
  onRetryFailed,
  onClear,
}: {
  jobs: Job[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  /** tries a failed or cancelled video again, as it was asked */
  onRetry: (job: Job) => void;
  /** tries every failed one again */
  onRetryFailed: () => void;
  onClear: () => void;
}) {
  const running = jobs.filter((j) => j.state === "running" && j.stage !== "waiting").length;
  const waiting = jobs.filter((j) => j.state === "queued" || (j.state === "running" && j.stage === "waiting")).length;
  const settled = jobs.filter((j) => !isActive(j) && !shotsActive(j)).length;
  const failed = jobs.filter((j) => j.state === "error").length;
  // finished = transcribed (failed and cancelled ones are counted on their own, or not at all)
  const done = jobs.filter((j) => j.state === "done" && !shotsActive(j)).length;
  const counts = [
    running ? `${running} running` : "",
    waiting ? `${waiting} waiting` : "",
    done ? `${done} finished` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean);
  return (
    <section className="card queue" aria-label="Videos">
      <div className="queue-head">
        <h2>Videos</h2>
        <span className="muted small">{counts.join(" · ")}</span>
        {failed ? (
          <button type="button" className="btn btn-small queue-retry-all" onClick={onRetryFailed} title="Try every failed video again, as each was asked">
            Retry failed ({failed})
          </button>
        ) : null}
        {settled ? (
          <button type="button" className="btn btn-small queue-clear" onClick={onClear}>
            Clear finished
          </button>
        ) : null}
      </div>
      <ul className="queue-list">
        {jobs.map((j) => {
          const on = j.id === selectedId;
          const moving = j.state === "running" && j.stage !== "waiting";
          return (
            <li key={j.id} className={`queue-row${on ? " on" : ""}`}>
              <button type="button" className="queue-main" onClick={() => onOpen(j.id)} aria-current={on || undefined} title={j.url}>
                <span className={`queue-dot queue-${moving ? "moving" : j.state === "running" ? "queued" : j.state}`} aria-hidden="true" />
                <span className="queue-text">
                  <span className="queue-title">{j.title || j.url}</span>
                  <span className={`queue-sub small${j.state === "error" ? " error-text" : " muted"}`}>{jobLine(j)}</span>
                  {moving ? (
                    <span className="bar queue-bar" aria-hidden="true">
                      <span
                        className={j.percent === null ? "bar-fill bar-indeterminate" : "bar-fill"}
                        style={j.percent === null ? undefined : { width: `${j.percent}%` }}
                      />
                    </span>
                  ) : null}
                </span>
              </button>
              {isActive(j) ? (
                <button type="button" className="btn btn-small" onClick={() => onCancel(j.id)}>
                  Cancel
                </button>
              ) : (
                <span className="queue-actions">
                  {j.state === "error" || j.state === "cancelled" ? (
                    <button type="button" className="btn btn-small btn-retry" onClick={() => onRetry(j)} title="Try this link again, as it was asked">
                      Retry
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => onRemove(j.id)}
                    disabled={shotsActive(j)}
                    title={shotsActive(j) ? "Its screenshots are still being taken" : "Remove from the list (screenshots stay on disk)"}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function JobStatus({ job, onRemove, onRetry }: { job: Job; onRemove: () => void; onRetry: () => void }) {
  if (job.state === "error" || job.state === "cancelled") {
    return (
      <section className="card status" role={job.state === "error" ? "alert" : "status"}>
        <h2>{job.state === "error" ? "Could not transcribe this video" : "Cancelled"}</h2>
        {job.state === "error" ? <p className="error">{job.message}</p> : <p className="muted">{job.title || job.url}</p>}
        {job.attempts && job.attempts > 1 ? <p className="muted small">Tried {job.attempts} times.</p> : null}
        <div className="status-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
          <button type="button" className="btn" onClick={onRemove}>
            Remove from the list
          </button>
        </div>
      </section>
    );
  }
  const label = STAGE_LABEL[job.stage] ?? job.message;
  return (
    <section className="card status" role="status" aria-live="polite">
      <p className="status-title">{job.title || job.url}</p>
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

function TranscriptView({ job, frames }: { job: Job; frames: Frames | null }) {
  const t = job.transcript!;
  const [timestamps, setTimestamps] = useState(true);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  // the new-video dialog: where the video goes, its playlist or course and episode, the tone, the length
  // and the user's notes are chosen before the video exists, and the first message is written from them
  const [newVideo, setNewVideo] = useState<NewVideoSource | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  /** Opens the new-video dialog with this transcript as the reference (and its screenshots as layout
   *  references, when they are ready: copied in as ref-<mm>m<ss>s.jpg for Claude to look at). */
  function makeVideo() {
    const shotsReady = frames?.state === "done" && frames.items.length > 0;
    setNewVideo({
      title: t.title,
      url: t.url,
      text: plainText(t, true),
      framesJob: shotsReady ? job.id : undefined,
      shotsComing: frames?.state === "running" || frames?.state === "waiting",
    });
  }

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
          <button
            type="button"
            className="btn"
            onClick={makeVideo}
            title={
              frames?.state === "done" && frames.items.length
                ? "Start a Motion video with this transcript and its screenshots attached"
                : "Start a Motion video with this transcript attached"
            }
          >
            Make a Motion video
          </button>
        </div>
      </div>
      {newVideo ? (
        <NewVideoDialog source={newVideo} onClose={() => setNewVideo(null)} onCreated={(id) => (window.location.hash = `#/motion/${id}`)} />
      ) : null}

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
