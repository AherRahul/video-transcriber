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
  state: "queued" | "running" | "done" | "error";
  stage: string;
  percent: number | null;
  message: string;
  transcript?: Transcript;
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

export type Health = { ok: boolean; ffmpeg: boolean; models: string[]; defaultModel: string };

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
