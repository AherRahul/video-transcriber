export type Segment = { start: number; end: number; text: string };

export type Transcript = {
  title: string;
  url: string;
  duration: number | null;
  language: string | null;
  source: "captions" | "auto-captions" | "whisper";
  segments: Segment[];
};

export type Job = {
  id: string;
  url: string;
  /** the video's title, once the server has read it (null before) */
  title?: string | null;
  duration?: number | null;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  stage: string;
  percent: number | null;
  message: string;
  createdAt?: number;
  /** the screenshots' own progress (the list shows it next to a finished transcript) */
  frames?: { state: Frames["state"]; percent?: number | null; message?: string };
  transcript?: Transcript;
  /** in the list (no transcript there): where the text came from and how long it is */
  summary?: { source: Transcript["source"]; language: string | null; duration: number | null; lines: number };
  /** the speech model it was asked with */
  model?: string;
  /** how many times it has been tried (2 or more after Retry) */
  attempts?: number;
};

export type JobOptions = {
  language?: string;
  model: string;
  forceWhisper: boolean;
  /** screenshots of the video with what is said at each, taken after the transcript (layout references for Motion) */
  screenshots: boolean;
};

/** One screenshot: its time in the video (seconds), its address and what is said around it. */
export type FrameItem = { t: number; url: string; file: string; text: string };

/** A job's screenshots. off: not asked for; waiting: the transcript comes first; running: being taken;
 *  done: items are ready; none: none were taken (message says why). */
export type Frames = {
  state: "off" | "waiting" | "running" | "done" | "none";
  percent: number | null;
  message: string;
  items: FrameItem[];
};

export type Health = {
  ok: boolean;
  ffmpeg: boolean;
  models: string[];
  defaultModel: string;
  /** how much runs side by side (an older server has none) */
  parallel?: { speech: number; downloads: number; screenshots: number; whisperThreads: number };
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (Array.isArray(body?.detail)) detail = "Check the URL and options.";
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export async function getHealth(): Promise<Health> {
  return json<Health>(await fetch("/api/health"));
}

export async function startJob(url: string, opts: JobOptions): Promise<string> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      language: opts.language?.trim() || null,
      model: opts.model,
      forceWhisper: opts.forceWhisper,
      screenshots: opts.screenshots,
    }),
  });
  return (await json<{ id: string }>(res)).id;
}

export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
  return json<Job>(await fetch(`/api/jobs/${id}`, { signal }));
}

/** Every transcription the server has in memory, newest first, without the transcripts. */
export async function listJobs(signal?: AbortSignal): Promise<Job[]> {
  return json<Job[]>(await fetch("/api/jobs", { signal }));
}

export async function cancelJob(id: string): Promise<void> {
  await json(await fetch(`/api/jobs/${id}/cancel`, { method: "POST" }));
}

/** Removes a finished job from the list (its screenshots stay on disk). */
export async function deleteJob(id: string): Promise<void> {
  await json(await fetch(`/api/jobs/${id}`, { method: "DELETE" }));
}

/**
 * Tries a failed or cancelled video again, as it was first asked, in its own row; returns the id that now
 * carries it. An app started before Retry existed answers 404 or 405 (and so does one restarted since, which
 * no longer has the job): the same link then goes in as a new job (with `fallback`'s options and the job's own
 * model) and the failed row is removed.
 */
export async function retryJob(job: Job, fallback: JobOptions): Promise<string> {
  const res = await fetch(`/api/jobs/${job.id}/retry`, { method: "POST" });
  if (res.ok) return job.id;
  if (res.status === 404 || res.status === 405) {
    const id = await startJob(job.url, { ...fallback, model: job.model || fallback.model });
    await deleteJob(job.id).catch(() => null);
    return id;
  }
  await json(res); // throws with the server's reason (409: it isn't failed or cancelled)
  return job.id;
}

/** Tries every failed video again (one request when the app has the route, one per video otherwise). */
export async function retryFailed(failed: Job[], fallback: JobOptions): Promise<void> {
  const res = await fetch("/api/jobs/retry-failed", { method: "POST" });
  if (res.ok) return;
  if (res.status !== 404 && res.status !== 405) {
    await json(res);
    return;
  }
  for (const j of failed) await retryJob(j, fallback).catch(() => null);
}

/** The links in pasted text: anything starting with http(s)://, split on spaces and new lines (a comma can
 *  be part of a link), each once, in order. */
export function splitLinks(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/\s+/)) {
    const link = part.trim();
    if (/^https?:\/\/\S+$/i.test(link) && !out.includes(link)) out.push(link);
  }
  return out;
}

export function downloadUrl(id: string, format: "txt" | "srt" | "vtt", timestamps: boolean): string {
  return `/api/jobs/${id}/download?format=${format}&timestamps=${timestamps}`;
}

export async function getFrames(id: string, signal?: AbortSignal): Promise<Frames> {
  return json<Frames>(await fetch(`/api/jobs/${id}/frames`, { signal }));
}

/** Every screenshot, with REFERENCES.md and references.json, in one zip. */
export function framesZipUrl(id: string): string {
  return `/api/jobs/${id}/frames.zip`;
}
