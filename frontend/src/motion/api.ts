// Calls to the Motion routes (backend/motion/api.py).

import type {
  Asset,
  Aspect,
  BrandExtraction,
  BrandKit,
  CaptionFormat,
  ChatState,
  Collection,
  CollectionMeta,
  CommentTarget,
  Destination,
  DetailsView,
  ExportJob,
  HubOp,
  MotionHealth,
  Project,
  ProjectSummary,
  ProjectView,
  Pronunciation,
  ScriptView,
  ThumbnailSource,
  Tone,
  VoiceJob,
  VoiceStatus,
} from "./types";

const BASE = "/api/motion";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* not JSON */
    }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const motionApi = {
  health: () => call<MotionHealth>("/health"),

  listProjects: () => call<ProjectSummary[]>("/projects"),
  createProject: (body: {
    title?: string;
    aspect?: Aspect;
    brandKitId?: string | null;
    sourceText?: string;
    sourceTitle?: string;
    sourceUrl?: string;
    settings?: Record<string, string>;
    targetSeconds?: number;
    /** how the script speaks: normal, funny, focused or informational */
    tone?: Tone;
    /** a transcription job whose screenshots come along as layout references (ref-<mm>m<ss>s.jpg assets) */
    framesJob?: string;
    /** where it goes (a collection decides it when given) */
    destination?: Destination;
    /** the playlist or course, the episode number (the end when left out) and the Udemy section */
    collection?: { id: string; order?: number; section?: string | null } | null;
    /** whether Claude waits for the user's own words before building scenes (on when left out) */
    scriptReview?: boolean;
  }) =>
    // references: how many screenshots came along
    call<{ project: Project; attachments: string[]; references: number }>("/projects", json("POST", body)),
  getProject: (id: string) => call<ProjectView>(`/projects/${id}`),
  patchProject: (id: string, body: Record<string, unknown>) => call<ProjectView>(`/projects/${id}`, json("PATCH", body)),
  deleteProject: (id: string) => call<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
  editScene: (id: string, sceneId: string, body: Record<string, unknown>) => call<ProjectView>(`/projects/${id}/scenes/${sceneId}`, json("PUT", body)),
  undo: (id: string) => call<ProjectView>(`/projects/${id}/undo`, { method: "POST" }),

  listAssets: (id: string) => call<Asset[]>(`/projects/${id}/assets`),
  uploadAssets: (id: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    return call<Asset[]>(`/projects/${id}/assets`, { method: "POST", body: form });
  },
  deleteAsset: (id: string, name: string) => call<Asset[]>(`/projects/${id}/assets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  assetUrl: (id: string, name: string) => `${BASE}/projects/${id}/assets/${encodeURIComponent(name)}`,
  posterUrl: (id: string, version: number) => `${BASE}/projects/${id}/poster.jpg?v=${version}`,

  getChat: (id: string) => call<ChatState>(`/projects/${id}/chat`),
  send: (
    id: string,
    body: { text?: string; attachments?: string[]; comment?: CommentTarget; styleChoice?: { optionId: string }; model?: string; effort?: string; engine?: string },
  ) => call<{ ok: boolean }>(`/projects/${id}/chat`, json("POST", body)),
  stop: (id: string) => call<{ ok: boolean }>(`/projects/${id}/chat/stop`, { method: "POST" }),
  newChat: (id: string) => call<{ ok: boolean }>(`/projects/${id}/chat/new`, { method: "POST" }),
  events: (id: string, after: number, boot: string, signal: AbortSignal) =>
    call<{ boot: string; events: HubOp[] }>(`/projects/${id}/events?after=${after}&boot=${boot}&timeout=25`, { signal }),

  voiceStatus: (id: string) => call<VoiceStatus>(`/projects/${id}/voice`),
  generateVoice: (id: string, scenes?: string[]) => call<VoiceJob>(`/projects/${id}/voice`, json("POST", { scenes })),
  cancelVoice: (id: string) => call<{ ok: boolean }>(`/projects/${id}/voice/cancel`, { method: "POST" }),
  setPronunciations: (id: string, entries: Pronunciation[]) => call<VoiceStatus>(`/projects/${id}/pronunciations`, json("PUT", { entries })),
  script: (id: string) => call<ScriptView>(`/projects/${id}/script`),
  /** the user approves the script in their own words (refused while a [[you: ...]] place is open) */
  approveScript: (id: string) => call<ProjectView>(`/projects/${id}/script/approve`, { method: "POST" }),
  reopenScript: (id: string) => call<ProjectView>(`/projects/${id}/script/reopen`, { method: "POST" }),
  scriptUrl: (id: string) => `${BASE}/projects/${id}/script.md`,
  doc: async (id: string, name: string) => {
    const res = await fetch(`${BASE}/projects/${id}/docs/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  },
  docUrl: (id: string, name: string) => `${BASE}/projects/${id}/docs/${encodeURIComponent(name)}`,

  /** narration and sfx default to on; off leaves the voice or the paper sounds out of the MP4. loudness
   * (on by default) evens the mix to -14 LUFS, YouTube's level. */
  startExport: (id: string, resolution: number, opts: { narration?: boolean; sfx?: boolean; loudness?: boolean } = {}) =>
    call<ExportJob>(
      `/projects/${id}/export`,
      json("POST", { resolution, narration: opts.narration ?? true, sfx: opts.sfx ?? true, loudness: opts.loudness ?? true }),
    ),
  cancelExport: (id: string) => call<{ ok: boolean }>(`/projects/${id}/export/cancel`, { method: "POST" }),

  // ── publishing: the captions and the thumbnail for the YouTube or Udemy upload ──

  /** The captions as a file to download, timed from the voice (scenes without a voice use estimates). */
  captionsUrl: (id: string, format: CaptionFormat) => `${BASE}/projects/${id}/captions.${format}`,
  /** The captions' text. Throws with .status (404 while the server has no captions route or no narration). */
  captions: async (id: string, format: CaptionFormat) => {
    const res = await fetch(`${BASE}/projects/${id}/captions.${format}`);
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.text();
  },
  /** The 1280x720 thumbnail; rev (from project.thumbnail) busts the cache when Claude redesigns it. The
   * server draws it on the first request after a change, so that one can take 20 s or so. */
  // v changes with the thumbnail's rev and with what it is drawn from (the brand kit, the frame settings):
  // the server sends a versioned link as cacheable for a year, so a stale v would show an old picture
  // the thumbnail, captions, chapters, DETAILS.md and YOUTUBE.md in one zip named after the video
  publishKitUrl: (id: string) => `${BASE}/projects/${id}/publish-kit.zip`,
  thumbnailUrl: (id: string, rev: number, look = "") => `${BASE}/projects/${id}/thumbnail.jpg?v=${rev}${look ? `-${look}` : ""}`,
  /** The HTML and values the thumbnail is drawn from. */
  getThumbnail: (id: string) => call<ThumbnailSource>(`/projects/${id}/thumbnail`),
  /** Saves a new design; the project's thumbnail.rev goes up. baseRev refuses (409) a save over a newer one. */
  putThumbnail: (id: string, body: { html: string; props?: Record<string, unknown>; baseRev?: number }) =>
    call<ThumbnailSource & { warnings?: string[]; version?: number }>(`/projects/${id}/thumbnail`, json("PUT", body)),

  // ── YouTube playlists and Udemy courses, and each video's publishing details ──

  listCollections: () => call<Collection[]>("/collections"),
  createCollection: (kind: Destination, title: string) => call<Collection>("/collections", json("POST", { kind, title })),
  /** renames it, or sets its own details (a playlist's description, a course's landing page) */
  updateCollection: (id: string, body: { title?: string; meta?: CollectionMeta }) => call<Collection>(`/collections/${id}`, json("PATCH", body)),
  /** the episode order, first to last; returns every collection again */
  reorderCollection: (id: string, ids: string[]) => call<Collection[]>(`/collections/${id}/order`, json("POST", { ids })),
  /** its videos stay, in no collection */
  deleteCollection: (id: string) => call<{ ok: boolean }>(`/collections/${id}`, { method: "DELETE" }),
  details: (id: string) => call<DetailsView>(`/projects/${id}/details`),
  /** every YouTube and Udemy field in one Markdown file */
  detailsMdUrl: (id: string) => `${BASE}/projects/${id}/details.md`,
  /** an exported MP4's link for downloading: the server marks the video downloaded when it is fetched this way */
  downloadMp4Url: (url: string) => `${url}${url.includes("?") ? "&" : "?"}download=1`,

  listKits: () => call<BrandKit[]>("/brand-kits"),
  createKit: (kit: Partial<BrandKit>, opts: { baseKitId?: string; logoUrl?: string | null } = {}) =>
    call<BrandKit>("/brand-kits", json("POST", { kit, ...opts })),
  updateKit: (id: string, kit: Partial<BrandKit>) => call<BrandKit>(`/brand-kits/${id}`, json("PUT", kit)),
  deleteKit: (id: string) => call<{ ok: boolean }>(`/brand-kits/${id}`, { method: "DELETE" }),
  uploadLogo: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return call<BrandKit>(`/brand-kits/${id}/logo`, { method: "POST", body: form });
  },
  removeLogo: (id: string) => call<BrandKit>(`/brand-kits/${id}/logo`, { method: "DELETE" }),
  logoUrl: (kit: BrandKit) => (kit.logo ? `${BASE}/brand-kits/${kit.id}/logo?v=${Math.round(kit.updatedAt ?? 0)}` : null),
  extractBrand: (url: string) => call<BrandExtraction>("/brand-kits/extract", json("POST", { url })),
};

/** Seconds as m:ss.s */
export function clockTenths(s: number): string {
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
}

/** Seconds as m:ss (h:mm:ss from an hour). */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** A length people read: "8.4 s" under a minute, else "11:29". */
export function lengthLabel(s: number): string {
  return s < 60 ? `${s.toFixed(1)} s` : clock(s);
}

/** "a" or "an" before a number said aloud: an 8, an 11, an 18, an 80, but a 10, a 21. */
export function articleFor(n: number): "a" | "an" {
  const r = Math.round(n);
  return r === 8 || r === 11 || r === 18 || /^8/.test(String(r)) ? "an" : "a";
}

export function bytesLabel(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** A video title as a file name: "Load balancing, simply" -> "load-balancing-simply". */
export function fileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "motion-video";
}

export function ago(ts: number): string {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A draft message handed from another page (for example "make a video from this transcript"). */
export type Draft = { text: string; attachments: string[] };

export function saveDraft(projectId: string, draft: Draft) {
  try {
    sessionStorage.setItem(`motion-draft-${projectId}`, JSON.stringify(draft));
  } catch {
    /* storage blocked: the user types the message */
  }
}

export function takeDraft(projectId: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(`motion-draft-${projectId}`);
    if (!raw) return null;
    sessionStorage.removeItem(`motion-draft-${projectId}`);
    return JSON.parse(raw) as Draft;
  } catch {
    return null;
  }
}
