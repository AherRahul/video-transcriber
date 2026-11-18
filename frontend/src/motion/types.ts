// Shapes shared by the Motion pages and the player. They mirror backend/motion/store.py and api.py.

export type Palette = { bg: string; surface: string; ink: string; muted: string; accent: string; accent2: string };

export type EndCard = { enabled: boolean; headline: string; cta: string; url: string };

export type BrandKit = {
  id: string;
  name: string;
  builtin?: boolean;
  theme?: "plain" | "paper";
  tagline?: string;
  wordmark?: string;
  icon?: string | null;
  palette: Palette;
  extras: Record<string, string>;
  fonts: { display: string; body: string; mono: string; hand?: string };
  radius: number;
  motion: "snappy" | "smooth";
  background: string;
  style: string;
  endCard: EndCard;
  logo?: string | null;
  updatedAt?: number;
};

/** The brand as the player sees it (a kit plus its logo URL). showLogo and showUrl follow the video's
 * closing settings (a Udemy film shows neither); missing means shown. */
export type Brand = Omit<BrandKit, "id" | "style" | "builtin" | "logo" | "icon"> & {
  id: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  showLogo?: boolean;
  showUrl?: boolean;
};

export type Lever = {
  key: string;
  label: string;
  type: "text" | "textarea" | "color" | "number" | "image" | "select" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};

export type PropValue = string | number | boolean | null | (string | number | boolean)[];

/** "promo" is the AlgoInsight promo before the end (written and narrated by the app, not by Claude);
 * "endscreen" is drawn by the player. Neither counts as a scene Claude still has to write. */
export type SceneKind = "scene" | "endscreen" | "promo";

export type BundleScene = {
  id: string;
  kind: SceneKind;
  name: string;
  idea: string;
  start: number;
  duration: number;
  transition: Transition;
  label: string;
  part: string;
  narration: string;
  hold: number;
  /** when the voice starts (after the page change) */
  lead: number;
  /** seconds of speech (estimated until the voice exists) */
  speech: number;
  /** scene-local seconds: cues[0] the voice starts, cues[n] the n-th <cue/> */
  cues: number[];
  voiced: boolean;
  stale: boolean;
  props: Record<string, PropValue>;
  levers: Lever[];
  rev: number;
  status: "planned" | "written";
  source: string | null;
};

export type Transition = "cut" | "fade" | "slide-up" | "slide-left" | "zoom" | "wipe" | "tear" | "turn";

export type Bundle = {
  projectId: string;
  version: number;
  title: string;
  aspect: Aspect;
  theme: "plain" | "paper";
  width: number;
  height: number;
  fps: number;
  duration: number;
  brand: Brand;
  assetBase: string;
  themeBase: string;
  audio: string | null;
  narration: { url: string; hash: string } | null;
  scenes: BundleScene[];
};

export type Aspect = "9:16" | "16:9" | "1:1" | "4:5";

export type Project = {
  id: string;
  title: string;
  aspect: Aspect;
  fps: number;
  brandKitId: string | null;
  brief: Record<string, string>;
  audio: string | null;
  settings: { model: string | null; effort: string | null; engine?: string | null };
  targetSeconds?: number | null;
  pronunciations?: Pronunciation[];
  /** where the film goes: a Udemy film shows no website, URL, price or platform of ours */
  destination?: Destination;
  closing?: Closing;
  /** the YouTube thumbnail Claude designed (write_thumbnail); null or missing when there is none */
  thumbnail?: Thumbnail | null;
  /** the script waits for the user's own words before any scene code (on for new videos) */
  scriptReview?: boolean;
  /** how the script speaks (normal when missing) */
  tone?: Tone;
  /** the shape and length Claude chose for the topic, each with why */
  plan?: VideoPlan | null;
  /** the scenes as saved: byUser marks narration the user rewrote in their own words */
  scenes?: { id: string; byUser?: boolean }[];
  /** the playlist or course it sits in (null or missing: none) */
  collection?: Placement | null;
  /** the user's marks: downloaded (also set by a download from the page) and uploaded */
  status?: VideoStatus;
  /** the publishing details (Claude's write_details and the user's edits in Details) */
  details?: { youtube?: YoutubeDetails; udemy?: UdemyDetails; at?: number };
  version: number;
  createdAt: number;
  updatedAt: number;
};

// ── publishing: playlists and courses, each video's place and status, and its details ──

/** A YouTube playlist or a Udemy course (the kind is where its videos go). */
export type Collection = {
  id: string;
  kind: Destination;
  title: string;
  meta: CollectionMeta;
  createdAt: number;
  /** its videos in episode order (missing on a collection just created) */
  videos?: CollectionVideo[];
};

/** A playlist's own details (title, description) or a course's landing page (title 60, subtitle 120,
 * description of 200 words or more, 4 or more objectives, requirements, audience, level). */
export type CollectionMeta = {
  title?: string;
  subtitle?: string;
  description?: string;
  objectives?: string[];
  requirements?: string[];
  audience?: string[];
  level?: string | null;
};

export type CollectionVideo = { id: string; title: string; episode: number; section: string | null; status: VideoStatus; duration: number };

/** A video's place in a collection: the episode (or lecture) number and, for a course, its section. */
export type Placement = { id: string; order: number; section: string | null };

/** Times are seconds since the epoch, like the project's own. */
export type VideoStatus = { downloadedAt?: number; downloadedFile?: string; uploadedAt?: number; uploadUrl?: string };

/** How far a video has got, step by step (store.progress); stage is the furthest step reached. */
export type Progress = {
  stage: "new" | "script" | "built" | "voiced" | "exported" | "downloaded" | "uploaded";
  script: boolean;
  built: boolean;
  voiced: boolean;
  exported: boolean;
  downloaded: boolean;
  uploaded: boolean;
};

export type DetailLink = { label: string; url: string };

/** YouTube's fields (backend/motion/publishing.py): what gets pasted, and the keyword it is written for. */
export type YoutubeDetails = {
  titles?: string[];
  title?: string;
  primaryKeyword?: string;
  /** Claude's post, with a {chapters} line where the app puts the chapters */
  description?: string;
  hashtags?: string[];
  tags?: string[];
  /** the user's own final post, used as it is */
  post?: string;
};

export type QuizQuestion = { question: string; options: string[]; answer: number | null; why: string };

/** A Udemy lecture's fields (never AlgoInsight, our website, prices or the platform). */
export type UdemyDetails = {
  lectureTitle?: string;
  lectureDescription?: string;
  objectives?: string[];
  keyTerms?: string[];
  resources?: DetailLink[];
  quiz?: QuizQuestion[];
  freePreview?: boolean;
  freePreviewWhy?: string;
  /** the user's own final lecture description */
  post?: string;
};

/** Where a video sits, as the Details page shows it. */
export type PlacementView = {
  collection: Collection;
  episode: number;
  count: number;
  section: string | null;
  previous: string | null;
  next: string | null;
  episodes: { id: string; title: string; episode: number; section: string | null }[];
};

/** GET /details: everything the upload needs, with the descriptions as they are pasted. */
export type DetailsView = {
  destination: Destination;
  youtube: YoutubeDetails;
  udemy: UdemyDetails;
  at: number | null;
  chapters: { start: number; clock: string; title: string }[];
  youtubeDescription: string;
  udemyDescription: string;
  warnings: { youtube: string[]; udemy: string[] };
  placement: PlacementView | null;
  status: VideoStatus;
  progress: Progress;
  /** Claude is working on this video (Write with Claude waits for its turn to end) */
  running?: boolean;
};

export const STAGE_LABEL: Record<Progress["stage"], string> = {
  new: "New",
  script: "Script",
  built: "Scenes built",
  voiced: "Voiced",
  exported: "Exported",
  downloaded: "Downloaded",
  uploaded: "Uploaded",
};

export type VideoPlan = { shape: string; why: string; minutes: number; lengthWhy: string };

/** How the script speaks (the server's TONES; the prompt's Tone section says what each asks of Claude). */
export type Tone = "normal" | "funny" | "focused" | "informational";

export const TONE_OPTIONS: { id: Tone; label: string; hint: string }[] = [
  { id: "normal", label: "Normal", hint: "Simple, warm English with a little character, like the daily films." },
  { id: "funny", label: "Funny", hint: "The same ideas with light, kind humour: small jokes, playful comparisons, a cheerful feel." },
  { id: "focused", label: "Focused", hint: "Knowledge-heavy and precise: every sentence teaches, still in simple English." },
  { id: "informational", label: "Informational", hint: "Research papers and technical sources decoded in simple English, in a calm tone." },
];

/** The script and the user's own words (store.script_state): whether it waits for their rewrite, whether
 * they approved it, how many narrated scenes they rewrote, and the places still left for their words. */
export type ScriptState = {
  review: boolean;
  approved: boolean;
  narrated: number;
  byUser: number;
  slots: { id: string; name: string; asks: string[] }[];
  waiting: boolean;
};

/** A place in Claude's draft for the user's own words: [[you: what goes here]] (the server's SLOT_RE). */
export const SLOT_RE = /\[\[\s*you\s*:\s*([\s\S]*?)\s*\]\]/gi;

export type Destination = "youtube" | "udemy";

/** What frames and ends the video: the logo card and web address on every page, the AlgoInsight promo
 * before the end, and the end screen. */
export type Closing = { logo: boolean; url: boolean; promo: boolean; endscreen: boolean };

export const DEFAULT_CLOSING: Closing = { logo: true, url: true, promo: false, endscreen: true };

/** The saved thumbnail: rev goes up on every new design, so the image URL changes with it. updatedAt
 * is in seconds, like the project's own times. */
export type Thumbnail = { rev: number; updatedAt: number; props?: Record<string, unknown> };

/** What the thumbnail is made from (GET /thumbnail, and PUT's reply): one still in the scene file format
 * that the server draws at 1280x720, and the values it reads. html is null before there is one. */
export type ThumbnailSource = { html: string | null; props: Record<string, unknown>; rev: number; url?: string | null };

/** The two caption files YouTube and Udemy take. */
export type CaptionFormat = "srt" | "vtt";

/** Scenes Claude writes (not the promo or the end screen, which the app adds). */
export const isBuildable = (s: { kind: SceneKind }) => s.kind !== "endscreen" && s.kind !== "promo";

export type ProjectSummary = {
  id: string;
  title: string;
  aspect: Aspect;
  scenes: number;
  duration: number;
  version: number;
  createdAt: number;
  updatedAt: number;
  brandKitId: string | null;
  /** missing from a server older than collections */
  destination?: Destination;
  tone?: Tone;
  collection?: Placement | null;
  status?: VideoStatus;
  progress?: Progress;
  /** which platforms have publishing details written */
  details?: { youtube: boolean; udemy: boolean };
};

export type ExportJob = {
  id: string;
  state: "queued" | "running" | "done" | "error" | "cancelled";
  percent: number;
  message: string;
  resolution: number;
  version: number;
  result?: {
    file: string;
    url: string;
    bytes: number;
    width: number;
    height: number;
    seconds: number;
    renderedScenes: number;
    cachedScenes: number;
    took: number;
    /** the captions written next to the MP4 (null for a video without narration; exports made before
     * captions existed have none) */
    captions?: Partial<Record<CaptionFormat, string>> | null;
  };
};

export type RenderFile = { file: string; bytes: number; at: number; url: string };

export type ProjectView = {
  project: Project;
  bundle: Bundle;
  undo: { label: string; at: number; count: number } | null;
  running: boolean;
  exportJob: ExportJob | null;
  voiceJob: VoiceJob | null;
  renders: RenderFile[];
  totals: { cost?: number; planCost?: number; turns?: number };
  /** missing from a server older than the script review */
  script?: ScriptState;
};

export type Pronunciation = { written: string; spoken: string };

export type VoiceJob = { id: string; state: "queued" | "running" | "done" | "error" | "cancelled"; done: number; total: number; chars: number; message: string };

export type VoiceStatus = {
  voice: { id: string; name: string; model: string };
  scenes: { id: string; name: string; state: "voiced" | "ready" | "changed" | "none"; words: number; chars: number; seconds: number }[];
  charsNeeded: number;
  voiced: number;
  total: number;
  keySet: boolean;
  job: VoiceJob | null;
  pronunciations: Pronunciation[];
};

export type ScriptView = { markdown: string; chapters: { start: number; title: string }[]; docs: { name: string; bytes: number; at: number }[] };

/** A file in the video's assets. A b-roll clip ("video") also has its length and frame rate, where it came from
 * (an upload, or stock from pexels or pixabay), and state "converting" while an upload is being converted. */
export type Asset = {
  name: string;
  /** drawing: an Excalidraw file (.excalidraw) a scene draws in with the x-draw markup */
  kind: "image" | "audio" | "video" | "document" | "font" | "drawing";
  bytes: number;
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
  source?: string;
  state?: "converting" | "ready";
};

export type StyleOption = { id: string; name: string; description: string; palette: string[]; motion: "snappy" | "smooth"; verb: string };

export type CommentTarget = { sceneId: string; elementId: string | null; at: number; label?: string };

export type LogEntry = { id: string; ts: number } & (
  | { kind: "user"; text: string; attachments: string[]; comment: CommentTarget | null }
  | { kind: "assistant"; text: string }
  | { kind: "progress"; text: string }
  | { kind: "tool"; tool: string; label: string; status: "running" | "ok" | "error"; detail?: string }
  | { kind: "frame"; sceneId: string; at: number; url: string; issues: number }
  | { kind: "style"; question: string; options: StyleOption[]; allowOther: boolean; chosen: string | null }
  | {
      kind: "usage";
      engine?: string;
      model: string;
      effort: string;
      steps: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number;
      total: number;
      seconds: number;
    }
  | { kind: "error"; text: string }
  | { kind: "note"; text: string }
  | { kind: "divider"; text: string }
);

export type ChatState = { boot: string; seq: number; log: LogEntry[]; running: boolean; pending: boolean; totals: { cost?: number } };

export type HubOp =
  | { op: "add"; seq: number; entry: LogEntry }
  | { op: "patch"; seq: number; id: string; fields: Partial<LogEntry> }
  | { op: "append"; seq: number; id: string; text: string }
  | { op: "project"; seq: number; version: number }
  | { op: "running"; seq: number; running: boolean }
  | { op: "export"; seq: number; job: ExportJob }
  | { op: "kits"; seq: number }
  | { op: "voice"; seq: number; job: VoiceJob }
  | { op: "docs"; seq: number }
  | { op: "assets"; seq: number }
  | { op: "reload"; seq: number };

export type MotionHealth = {
  claude: { ready: boolean; source: string | null };
  claudeCode: { ready: boolean; version?: string | null; loggedIn?: boolean; reason?: string | null };
  engines: string[];
  defaultEngine: string;
  elevenlabs: boolean;
  voice: { id: string; name: string; model: string };
  playerBuilt: boolean;
  ffmpeg: boolean;
  browser: string | null;
  models: { id: string; label: string }[];
  defaultModel: string;
  efforts: string[];
  defaultEffort: string;
  aspects: Aspect[];
  transitions: Transition[];
};

export type BrandExtraction = {
  draft: Omit<BrandKit, "id" | "extras" | "background"> & { extras?: Record<string, string>; background?: string };
  logoUrl: string | null;
  candidates: { colors: { hex: string; count: number }[]; variables: Record<string, string>; themeColor: string | null; fonts: string[]; logos: string[] };
  source: { url: string; title: string };
};

// Messages between the editor page and the player iframe.
export type ToPlayer =
  | { type: "load"; bundle: Bundle }
  | { type: "seek"; t: number }
  | { type: "comment"; on: boolean }
  | { type: "guides"; on: boolean }
  | { type: "highlight"; sceneId: string; elementId: string | null };

export type FromPlayer =
  | { type: "ready" }
  | { type: "loaded"; version: number; duration: number; errors: string[]; sfx: { sceneId: string; t: number; name: string; gain: number }[] }
  | { type: "pick"; sceneId: string; elementId: string | null; label: string; x: number; y: number }
  | { type: "key"; key: string };
