// The new-video dialog: everything decided before a video exists, in one place. Where it goes (YouTube or
// Udemy), which playlist or course and at which episode (and, for a course, which section), the script's
// tone, the length, whether Claude waits for the user's own words, and the user's own notes.
//
// It opens from the transcriber's "Make a Motion video" (the transcript comes along as a reference, its
// screenshots too when they are ready) and from the library's "+ New video" and narrated starters. The
// video is created with these settings, and the first message for Claude is written from them (see
// firstMessage): it lands in the chat box, where the user can still change it before sending.

import { useEffect, useMemo, useState } from "react";

import "./motion.css";
import { motionApi, saveDraft } from "./api";
import { TONE_OPTIONS, type Collection, type Destination, type Tone } from "./types";

/** What a video made from a transcription starts with. */
export type NewVideoSource = {
  title: string;
  url?: string;
  /** the transcript as timed plain text */
  text: string;
  /** the transcription whose screenshots come along as layout references (only when they are ready) */
  framesJob?: string;
  /** the screenshots are still being taken, so they won't come along */
  shotsComing?: boolean;
};

/** A starter's preset (the library's narrated starters). */
export type NewVideoPreset = { title?: string; tone?: Tone; notes?: string };

/** What the user chose in the dialog. */
export type NewVideoChoice = {
  title: string;
  destination: Destination;
  collection: Collection | null;
  /** 1-based; one past the last video means "at the end" */
  episode: number;
  section: string;
  tone: Tone;
  /** null: the reference's length when there is one, else the topic decides */
  minutes: number | null;
  notes: string;
};

/** How each tone reads in the first message (the system prompt's Tone section has the details). */
const TONE_PROMPT: Record<Tone, string> = {
  normal: "normal - simple, warm English with a little character",
  funny: "funny - the same ideas with light, kind humour and a cheerful feel",
  focused: "focused - knowledge-heavy and precise, every sentence teaching, still in simple English",
  informational: "informational - the source decoded in simple English, in a calm tone, highly informational",
};

const PLACE = { youtube: { name: "YouTube", unit: "episode", group: "playlist" }, udemy: { name: "Udemy", unit: "lecture", group: "course" } } as const;

/** The first message Claude gets, written from the choices: where the video sits and what comes either side,
 *  the tone, the length (the reference's when there is one), the reference and the user's notes. Claude decides
 *  everything and builds in one go. */
export function firstMessage(c: NewVideoChoice, ctx: { sourceTitle?: string; screenshots?: boolean } = {}): string {
  const place = PLACE[c.destination];
  const notes = c.notes.trim();
  const topic = ctx.sourceTitle ? `on the topic of the attached video ("${ctx.sourceTitle}")` : c.title.trim() ? `about ${c.title.trim()}` : "about [TOPIC]";
  const lines = [`Make a narrated explainer in our daily paper look ${topic}.`];

  if (c.collection) {
    const videos = c.collection.videos ?? [];
    const count = videos.length + 1;
    const episode = Math.min(Math.max(1, c.episode), count);
    const before = videos[episode - 2];
    const after = videos[episode - 1];
    const near = [before ? `after "${before.title}"` : `the first ${place.unit}`, after ? `before "${after.title}"` : null].filter(Boolean);
    const section = c.destination === "udemy" && c.section.trim() ? `, section "${c.section.trim()}"` : "";
    // the first one opens the series; a later one builds on the ones before it
    const build = before
      ? ` Build on what the earlier ${place.unit}s taught and don't teach it again.`
      : after
        ? ` It comes first: set up what the ${place.unit}s after it build on.`
        : ` It opens the ${place.group}: set up what later ${place.unit}s can build on.`;
    lines.push(`- Made for: ${place.name}, ${place.unit} ${episode} of ${count} in the ${place.group} "${c.collection.title}"${section} (${near.join(", ")}).${build}`);
  } else {
    lines.push(`- Made for: ${place.name}, not in a ${place.group} yet.`);
  }
  if (c.destination === "udemy") lines.push("- It's a Udemy lecture: no AlgoInsight, website, prices or platform in the narration or the scenes (the frame's logo card is the only exception).");
  lines.push(`- Tone: ${TONE_PROMPT[c.tone]}.`);
  lines.push(
    c.minutes
      ? `- Length: about ${c.minutes} minute${c.minutes === 1 ? "" : "s"}.`
      : ctx.sourceTitle
        ? "- Length: about as long as the attached video (the project state shows the window)."
        : "- Length: what the topic needs. Pick it with the shape and say why.",
  );
  if (ctx.sourceTitle) {
    lines.push(
      "- The attached video is the reference: cover every point it makes, nothing dropped, in our own words, examples and look." +
        (ctx.screenshots ? " Its screenshots show how it put each idea on screen (view_references); our pages are our own design in the paper look." : ""),
    );
  }
  if (notes) lines.push(`- My notes: ${notes}`);

  lines.push("");
  // with a reference (or a length of the user's) the length is set: Claude picks only the shape
  const shape = c.minutes || ctx.sourceTitle ? "the shape" : "the shape and length this topic needs";
  // Claude decides everything (the founder, 2026-11-19): no questions first, no places left for the user's words
  lines.push(
    `Decide everything yourself: pick ${shape} in a line, then write the script and build every scene in one go, every fact checked in FACTS.md. ` +
      "Don't ask me anything and leave no places for my words: write my take and opinions yourself.",
  );
  const groupDetails = c.collection && !c.collection.meta?.description ? ` and the ${place.group}'s own details (it has none yet)` : "";
  lines.push(
    c.destination === "udemy"
      ? `At the end, write the Udemy lecture details with write_details${groupDetails}.`
      : `At the end, write the YouTube details with write_details${groupDetails}, then the thumbnail.`,
  );
  return lines.join("\n");
}

// the last playlist or course used for each destination, so the next episode lands in the same one
const lastKey = (d: Destination) => `motion-last-collection-${d}`;
function readLast(d: Destination): string {
  try {
    return localStorage.getItem(lastKey(d)) ?? "";
  } catch {
    return "";
  }
}
function writeLast(d: Destination, id: string) {
  try {
    localStorage.setItem(lastKey(d), id);
  } catch {
    /* storage blocked: the dialog starts on "None" next time */
  }
}

type Props = {
  source?: NewVideoSource | null;
  preset?: NewVideoPreset | null;
  onCreated: (projectId: string) => void;
  onClose: () => void;
};

const NEW = "__new";

export default function NewVideoDialog({ source, preset, onCreated, onClose }: Props) {
  const [title, setTitle] = useState(source?.title ?? preset?.title ?? "");
  const [destination, setDestination] = useState<Destination>("youtube");
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [newName, setNewName] = useState("");
  const [episode, setEpisode] = useState(1);
  const [section, setSection] = useState("");
  const [tone, setTone] = useState<Tone>(preset?.tone ?? "normal");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState(preset?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    motionApi
      .listCollections()
      .then((list) => {
        setCollections(list);
        // start where the last video of this kind went
        const last = list.find((c) => c.id === readLast("youtube") && c.kind === "youtube");
        if (last) pick(last.id, list);
      })
      .catch(() => setCollections([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const ofKind = useMemo(() => (collections ?? []).filter((c) => c.kind === destination), [collections, destination]);
  const collection = ofKind.find((c) => c.id === collectionId) ?? null;
  const videos = collection?.videos ?? [];
  const sections = useMemo(() => [...new Set(videos.map((v) => v.section).filter((s): s is string => !!s))], [videos]);

  /** Picks a playlist or course: the new video goes at its end, in the section of its last lecture. */
  function pick(id: string, list: Collection[] | null = collections) {
    setCollectionId(id);
    const c = (list ?? []).find((x) => x.id === id);
    const vids = c?.videos ?? [];
    setEpisode(vids.length + 1);
    setSection(vids.length ? vids[vids.length - 1].section ?? "" : "");
  }

  function switchDestination(d: Destination) {
    setDestination(d);
    const last = (collections ?? []).find((c) => c.id === readLast(d) && c.kind === d);
    if (last) pick(last.id);
    else {
      setCollectionId("");
      setEpisode(1);
      setSection("");
    }
  }

  const minutesValue = (() => {
    const n = Number(minutes.trim());
    return minutes.trim() && Number.isFinite(n) && n > 0 ? Math.min(45, Math.round(n * 10) / 10) : null;
  })();
  // a playlist or course typed in but not created yet still shows in the message as it will be
  const shownCollection: Collection | null = collectionId === NEW && newName.trim() ? { id: NEW, kind: destination, title: newName.trim(), meta: {}, createdAt: 0, videos: [] } : collection;
  const choice: NewVideoChoice = { title, destination, collection: shownCollection, episode, section, tone, minutes: minutesValue, notes };
  const message = firstMessage(choice, { sourceTitle: source?.title, screenshots: !!source?.framesJob });

  async function create() {
    if (collectionId === NEW && !newName.trim()) {
      setError(`Name the new ${PLACE[destination].group}, or pick None.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let col = collection;
      if (collectionId === NEW) {
        col = { ...(await motionApi.createCollection(destination, newName.trim())), videos: [] };
      }
      const { project, attachments, references } = await motionApi.createProject({
        title: title.trim() || source?.title || "",
        // the daily films' look and voice
        brandKitId: "algoinsight-paper",
        aspect: "16:9",
        tone,
        destination,
        collection: col ? { id: col.id, order: Math.min(episode, (col.videos?.length ?? 0) + 1), ...(destination === "udemy" ? { section: section.trim() || null } : {}) } : null,
        targetSeconds: minutesValue ? Math.round(minutesValue * 60) : undefined,
        sourceText: source?.text,
        sourceTitle: source?.title,
        sourceUrl: source?.url,
        framesJob: source?.framesJob,
      });
      if (col) writeLast(destination, col.id);
      const text = firstMessage({ ...choice, collection: col }, { sourceTitle: source?.title, screenshots: references > 0 });
      saveDraft(project.id, { text, attachments });
      onCreated(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const place = PLACE[destination];
  return (
    <div className="mo-modal-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mo-modal mo-newvideo" role="dialog" aria-modal="true" aria-label="New video">
        <header className="mo-modal-head">
          <h2>New video</h2>
          <button type="button" className="btn btn-small" onClick={onClose} disabled={busy} aria-label="Close">
            ×
          </button>
        </header>

        <div className="mo-modal-body">
          {source ? (
            <p className="mo-nv-source small">
              <b>Reference:</b> {source.title} <span className="muted">(research only, never the outline)</span>
              {source.framesJob ? <span className="muted"> · its screenshots come along</span> : null}
              {source.shotsComing ? <span className="mo-warn-text"> · its screenshots are still being taken, so they won't come along</span> : null}
            </p>
          ) : null}

          <label className="mo-field">
            <span className="label">Title</span>
            <input type="text" value={title} autoFocus maxLength={120} placeholder="What the video is about" onChange={(e) => setTitle(e.target.value)} />
          </label>

          <div className="mo-field">
            <span className="label">Made for</span>
            <div className="mo-seg mo-seg-wide" role="radiogroup" aria-label="Made for">
              {(["youtube", "udemy"] as Destination[]).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={destination === d} className={destination === d ? "on" : ""} onClick={() => destination !== d && switchDestination(d)}>
                  <span className={`mo-dest mo-dest-${d}`} aria-hidden="true" /> {PLACE[d].name}
                </button>
              ))}
            </div>
            {destination === "udemy" ? <p className="muted small">A Udemy lecture carries the AlgoInsight logo card (no tagline), but no web address, promo or end screen, and never names AlgoInsight.</p> : null}
          </div>

          <div className="mo-nv-row">
            <label className="mo-field">
              <span className="label">{destination === "udemy" ? "Course" : "Playlist"}</span>
              <select value={collectionId} onChange={(e) => (e.target.value === NEW ? setCollectionId(NEW) : pick(e.target.value))} disabled={collections === null}>
                <option value="">None for now</option>
                {ofKind.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.videos?.length ?? 0})
                  </option>
                ))}
                <option value={NEW}>+ New {place.group}...</option>
              </select>
            </label>
            {collectionId === NEW ? (
              <label className="mo-field">
                <span className="label">New {place.group}'s name</span>
                <input type="text" value={newName} maxLength={150} placeholder={destination === "udemy" ? "System design from zero" : "AI for Everyone"} onChange={(e) => setNewName(e.target.value)} />
              </label>
            ) : collection ? (
              <label className="mo-field">
                <span className="label">{destination === "udemy" ? "Lecture" : "Episode"}</span>
                <select value={episode} onChange={(e) => setEpisode(Number(e.target.value))}>
                  {Array.from({ length: videos.length + 1 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} - {!videos.length ? "the first" : n > videos.length ? "at the end" : `before "${videos[n - 1].title}"`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {destination === "udemy" && collectionId ? (
            <label className="mo-field">
              <span className="label">Section</span>
              <input type="text" list="mo-nv-sections" value={section} maxLength={80} placeholder="Like: Scaling the database" onChange={(e) => setSection(e.target.value)} />
              <datalist id="mo-nv-sections">
                {sections.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </label>
          ) : null}

          <div className="mo-field" role="radiogroup" aria-label="Script tone">
            <span className="label">Script tone</span>
            <div className="mo-nv-tones">
              {TONE_OPTIONS.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={tone === t.id} className={`mo-nv-tone ${tone === t.id ? "on" : ""}`} onClick={() => setTone(t.id)}>
                  <span className="mo-check-title">{t.label}</span>
                  <span className="muted small">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mo-nv-row">
            <label className="mo-field">
              <span className="label">Length (minutes)</span>
              <input type="number" min={0.5} max={45} step={0.5} value={minutes} placeholder={source ? "As long as the reference" : "The topic decides"} onChange={(e) => setMinutes(e.target.value)} />
              <span className="muted small">
                {source ? "Empty: about as long as the reference video, covering everything it covers." : "Empty: Claude picks the length the topic needs and says why."}
              </span>
            </label>
          </div>

          <label className="mo-field">
            <span className="label">Your notes (optional)</span>
            <textarea
              rows={3}
              value={notes}
              placeholder="Your take, a real story, real numbers or runs, the AlgoInsight lessons to use, what the reference gets wrong"
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <details className="mo-nv-message">
            <summary>The first message Claude gets</summary>
            <pre>{message}</pre>
            <p className="muted small">It goes into the chat box: change it there before sending if you like.</p>
          </details>
        </div>

        <footer className="mo-modal-foot">
          <span className="mo-warn-text small" role="alert">
            {error}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy}>
            {busy ? "Creating..." : "Create video"}
          </button>
        </footer>
      </div>
    </div>
  );
}
