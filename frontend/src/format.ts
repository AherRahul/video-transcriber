import type { Transcript } from "./api";

/** 75.4 → "1:15", 3725 → "1:02:05". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export const SOURCE_LABEL: Record<Transcript["source"], string> = {
  captions: "Captions",
  "auto-captions": "Auto-captions",
  whisper: "Speech-to-text",
};

export const SOURCE_HINT: Record<Transcript["source"], string> = {
  captions: "From the video's own captions",
  "auto-captions": "From the site's automatic captions",
  whisper: "Transcribed on this computer with Whisper",
};

/** A link that opens the video at `seconds`, for sites that support it; otherwise null. */
export function linkAt(url: string, seconds: number): string | null {
  try {
    const u = new URL(url);
    const t = Math.floor(seconds);
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) {
      u.searchParams.set("t", `${t}s`);
      return u.toString();
    }
    if (/(^|\.)vimeo\.com$/.test(u.hostname)) {
      u.hash = `t=${t}s`;
      return u.toString();
    }
    if (/\.(mp4|webm|mov|m4a|mp3)$/i.test(u.pathname)) {
      u.hash = `t=${t}`;
      return u.toString();
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** Plain text of the transcript, as copied to the clipboard. */
export function plainText(t: Transcript, timestamps: boolean): string {
  if (!timestamps) return t.segments.map((s) => s.text).join(" ");
  return t.segments.map((s) => `[${clock(s.start)}] ${s.text}`).join("\n");
}

/** Group short caption lines into readable paragraphs (a new one after a pause or ~45 s). */
export function paragraphs(t: Transcript): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  let cur: { start: number; text: string; end: number } | null = null;
  for (const s of t.segments) {
    const pause = cur ? s.start - cur.end : 0;
    if (!cur || pause > 2 || s.start - cur.start > 45) {
      if (cur) out.push({ start: cur.start, text: cur.text });
      cur = { start: s.start, text: s.text, end: s.end };
    } else {
      cur.text += " " + s.text;
      cur.end = s.end;
    }
  }
  if (cur) out.push({ start: cur.start, text: cur.text });
  return out;
}
