/**
 * The Screenshots section under a finished transcript: stills of the video at each new scene and at least
 * every 15 seconds, each with its time and what is said then. They are layout references for Motion (Make a
 * Motion video takes them along); here they can be checked, opened large and downloaded as one zip.
 */
import { useEffect, useRef, useState } from "react";

import { framesZipUrl, getFrames, type FrameItem, type Frames } from "./api";
import { clock, linkAt } from "./format";

/** How many tiles show before "Show all" (three rows on a wide screen); a set only a row longer shows whole. */
const FIRST_TILES = 12;
const COLLAPSE_OVER = FIRST_TILES + 4;

/** The job's screenshots: asked for once the transcript is done, then every second while they are being
 *  taken. Null until the first answer. */
export function useFrames(jobId: string | null, enabled: boolean): Frames | null {
  const [frames, setFrames] = useState<Frames | null>(null);
  useEffect(() => {
    setFrames(null);
    if (!jobId || !enabled) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = () => {
      getFrames(jobId, controller.signal)
        .then((f) => {
          setFrames(f);
          if (f.state === "waiting" || f.state === "running") timer = window.setTimeout(poll, 1000);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setFrames({ state: "none", percent: null, message: err instanceof Error ? err.message : String(err), items: [] });
        });
    };
    poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [jobId, enabled]);
  return frames;
}

export default function ScreenshotsView({ jobId, videoUrl, frames }: { jobId: string; videoUrl: string; frames: Frames | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const items = frames?.items ?? [];
  const working = !frames || frames.state === "waiting" || frames.state === "running";
  const collapsible = items.length > COLLAPSE_OVER;
  const shown = all || !collapsible ? items : items.slice(0, FIRST_TILES);

  return (
    <section className="card shots" aria-labelledby="shots-title">
      <div className="shots-head">
        <div className="shots-title">
          <h2 id="shots-title">
            Screenshots{items.length ? <span className="muted"> · {items.length}</span> : null}
          </h2>
          <p className="muted small">
            The video at each new scene and at least every 15 seconds, with what is said then: layout references for
            Motion. <b>Make a Motion video</b> takes them along.
          </p>
        </div>
        {items.length ? (
          <a className="btn" href={framesZipUrl(jobId)} download>
            Download all (.zip)
          </a>
        ) : null}
      </div>

      {working ? <ShotsProgress frames={frames} /> : null}
      {!working && frames && !items.length ? <NoShots frames={frames} /> : null}

      {items.length ? (
        <>
          <ul className="shots-grid">
            {shown.map((it, i) => (
              <li key={it.file}>
                <button type="button" className="shot" onClick={() => setOpen(i)} title="Open it large">
                  <img src={it.url} alt="" loading="lazy" decoding="async" />
                  <span className="shot-caption">
                    <span className="shot-time">{clock(it.t)}</span>
                    <span className={it.text ? "shot-text" : "shot-text muted"}>{it.text || "No speech here"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {collapsible ? (
            <button type="button" className="btn btn-small shots-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${items.length}`}
            </button>
          ) : null}
        </>
      ) : null}

      {open !== null && items[open] ? (
        <Lightbox items={items} index={open} videoUrl={videoUrl} onMove={setOpen} onClose={() => setOpen(null)} />
      ) : null}
    </section>
  );
}

/** While they are being taken: the step (downloading, finding the scene changes, taking them) and a bar. */
function ShotsProgress({ frames }: { frames: Frames | null }) {
  const pct = frames?.percent ?? null;
  return (
    <div className="shots-status" role="status" aria-live="polite">
      <div className="status-line">
        <span className="spinner" aria-hidden="true" />
        <span>{frames?.state === "waiting" ? "Waiting for the transcript" : "Taking screenshots"}</span>
        {pct !== null ? <span className="muted">{Math.round(pct)}%</span> : null}
      </div>
      <div className="bar" aria-hidden="true">
        <div className={pct === null ? "bar-fill bar-indeterminate" : "bar-fill"} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      {frames?.message ? <p className="muted small shots-step">{frames.message}</p> : null}
    </div>
  );
}

/** None: turned off, or why they couldn't be taken (the transcript is fine either way). */
function NoShots({ frames }: { frames: Frames }) {
  if (frames.state === "off") {
    return (
      <p className="muted shots-note">
        Screenshots were off for this video. Tick <b>Screenshots for layout references</b> under Options to take them next
        time.
      </p>
    );
  }
  return (
    <div className="banner banner-warn shots-note" role="status">
      <b>No screenshots.</b> {frames.message || "None could be taken from this video."} The transcript is not affected.
    </div>
  );
}

/** One screenshot large, with its time and what is said, in a modal dialog. Left and right step through
 *  them; Escape, Close or a click outside closes it. */
function Lightbox({
  items,
  index,
  videoUrl,
  onMove,
  onClose,
}: {
  items: FrameItem[];
  index: number;
  videoUrl: string;
  onMove: (index: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    closeRef.current?.focus();
  }, []);

  // the arrow keys work wherever the focus is (a button that turns disabled at the end drops it)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : -1;
      if (next >= 0 && next < items.length) {
        e.preventDefault();
        onMove(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onMove]);

  const it = items[index];
  const href = linkAt(videoUrl, it.t);
  return (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={`Screenshot at ${clock(it.t)}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close(); // the backdrop
      }}
    >
      <div className="lightbox-body">
        <img src={it.url} alt={`The video at ${clock(it.t)}`} />
        <div className="lightbox-caption">
          <div className="lightbox-meta">
            <span className="shot-time">{clock(it.t)}</span>
            <span className="muted small">
              {index + 1} of {items.length}
            </span>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="small">
                Open the video here
              </a>
            ) : null}
          </div>
          <p className={it.text ? "lightbox-text" : "lightbox-text muted"}>{it.text || "No speech here."}</p>
        </div>
        <div className="lightbox-actions">
          <button type="button" className="btn" onClick={() => onMove(index - 1)} disabled={index === 0}>
            Previous
          </button>
          <button type="button" className="btn" onClick={() => onMove(index + 1)} disabled={index === items.length - 1}>
            Next
          </button>
          <button ref={closeRef} type="button" className="btn btn-primary" onClick={() => ref.current?.close()}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
