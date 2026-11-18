// Details: one place for what a YouTube or Udemy upload needs, plus where the video sits and how far it has
// got.
//
// - Where it sits: its playlist or course, its episode (or lecture) number and, for a course, its section.
//   Moving it into a Udemy course makes it a Udemy video (the server turns off our logo, web address, promo
//   and end screen); into a playlist, a YouTube one.
// - Status: the steps it has been through (script, scenes, voice, export), downloaded (marked by itself when
//   the MP4 is downloaded from the page) and uploaded (the user ticks it or pastes the video's link).
// - What gets pasted, and nothing else: YouTube's title, post description and tags; Udemy's lecture title,
//   lecture description and quiz. Each has a copy button. "Write with Claude" (here, from the editor or from
//   the library) sends Claude the ask and waits for its write_details; the user can then edit any of it.
//   The description is plain text (YouTube shows Markdown as typed); its chapter lines follow the video.
//
// CollectionDetails edits a playlist's or course's own details (a course's landing page).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ago, motionApi } from "./api";
import { STAGE_LABEL, type Collection, type CollectionMeta, type DetailsView, type Destination, type Progress, type QuizQuestion } from "./types";

// ── small parts ──

/** Copies text, and says so on the button for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 1200);
    } catch {
      /* the clipboard is blocked: the text can still be selected and copied by hand */
    }
  }
  return (
    <button type="button" className="btn btn-small mo-copy" disabled={!text.trim()} onClick={() => void copy()}>
      {done ? "Copied" : label}
    </button>
  );
}

/** A field: its label, a count (red past the limit), a copy button. */
function Field({ label, copy, count, hint, children }: { label: string; copy: string; count?: { n: number; max: number; unit?: string }; hint?: string; children: ReactNode }) {
  return (
    <div className="mo-field mo-dt-field">
      <div className="mo-dt-label">
        <span className="label">{label}</span>
        {count ? (
          <span className={`small ${count.n > count.max ? "mo-warn-text" : "muted"}`}>
            {count.n} / {count.max}
            {count.unit ? ` ${count.unit}` : ""}
          </span>
        ) : null}
        <CopyButton text={copy} />
      </div>
      {children}
      {hint ? <span className="muted small">{hint}</span> : null}
    </div>
  );
}

/** A text box that grows with its text, so the dialog keeps one scroll (no box scrolling inside it). */
function GrowText({ value, onChange, placeholder, minRows = 2 }: { value: string; onChange: (v: string) => void; placeholder?: string; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} className="mo-grow" rows={minRows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

const fromList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const wordCount = (s: string) => (s.match(/[A-Za-z0-9][A-Za-z0-9'.+#-]*/g) ?? []).length;

const quizText = (q: QuizQuestion, i: number) =>
  `${i + 1}. ${q.question}\n` + q.options.map((o, k) => `${q.answer === k ? "*" : "-"} ${o}`).join("\n") + (q.why ? `\nWhy: ${q.why}` : "");

const STEPS: (keyof Omit<Progress, "stage">)[] = ["script", "built", "voiced", "exported", "downloaded", "uploaded"];

/** The message that asks Claude for the details. */
export function detailsAsk(destination: Destination, withCollection: boolean): string {
  const what = destination === "udemy" ? "the Udemy lecture's title, description and quiz" : "the YouTube title, post description, hashtags and tags";
  return (
    `Write ${what} with write_details, from the video as it is now (its plan, its parts, my own words and FACTS.md), following Publishing details: SEO first, plain text, the episodes either side by name` +
    (withCollection ? `. Also write the ${destination === "udemy" ? "course" : "playlist"}'s own details, which it doesn't have yet.` : ".")
  );
}

// the editable text: what gets pasted
type Forms = { ytTitle: string; ytPost: string; ytTags: string; udTitle: string; udPost: string };
const formsOf = (v: DetailsView): Forms => ({
  ytTitle: v.youtube.title ?? "",
  ytPost: v.youtubeDescription,
  ytTags: (v.youtube.tags ?? []).join(", "),
  udTitle: v.udemy.lectureTitle ?? "",
  udPost: v.udemyDescription,
});

// ── the Details modal ──

type Props = {
  projectId: string;
  title: string;
  /** the project's version: the page reloads when it changes (Claude wrote details, a download was marked) */
  version?: number;
  /** sends a chat message through the editor (so its chat shows it); without it the message is sent here */
  onAsk?: (text: string) => Promise<unknown>;
  onChanged?: () => void;
  onClose: () => void;
};

export default function DetailsModal({ projectId, title, version, onAsk, onChanged, onClose }: Props) {
  const [view, setView] = useState<DetailsView | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tab, setTab] = useState<Destination | null>(null);
  const [forms, setForms] = useState<Forms | null>(null);
  const [dirty, setDirty] = useState<Partial<Record<keyof Forms, boolean>>>({});
  const [place, setPlace] = useState<{ id: string; order: number; section: string } | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // Claude was asked to write the details: the page waits for its turn to end, then shows what it wrote
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editCollection, setEditCollection] = useState<Collection | null>(null);
  const dirtyAny = Object.values(dirty).some(Boolean);

  const load = useCallback(
    async (keepForms: boolean) => {
      const [v, cols] = await Promise.all([motionApi.details(projectId), motionApi.listCollections()]);
      setView(v);
      setCollections(cols);
      setTab((t) => t ?? v.destination);
      setUrl(v.status.uploadUrl ?? "");
      setPlace(v.placement ? { id: v.placement.collection.id, order: v.placement.episode, section: v.placement.section ?? "" } : { id: "", order: 1, section: "" });
      if (!keepForms) {
        setForms(formsOf(v));
        setDirty({});
      }
      return v;
    },
    [projectId],
  );

  useEffect(() => {
    load(false).catch((err) => setError(err.message));
  }, [load]);

  // a change elsewhere (a download marked, Claude's write_details): show it, keeping unsaved edits
  useEffect(() => {
    if (version === undefined || writing) return;
    load(dirtyAny).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // while Claude writes: check every few seconds, and show its details when its turn ends
  useEffect(() => {
    if (!writing) return;
    let seen = false;
    let polls = 0;
    const timer = window.setInterval(async () => {
      polls += 1;
      try {
        const v = await motionApi.details(projectId);
        if (v.running) seen = true;
        else if (seen || polls >= 4) {
          setWriting(false);
          await load(false);
          onChanged?.();
        }
      } catch {
        /* a missed check: the next one tries again */
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [writing, projectId, load, onChanged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !editCollection && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editCollection, onClose]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Saves only what the user changed: a hand-edited description is kept as their own text. */
  const save = () =>
    run(async () => {
      if (!forms) return;
      const youtube: Record<string, unknown> = {};
      const udemy: Record<string, unknown> = {};
      if (dirty.ytTitle) youtube.title = forms.ytTitle.trim();
      if (dirty.ytPost) youtube.post = forms.ytPost;
      if (dirty.ytTags) youtube.tags = fromList(forms.ytTags);
      if (dirty.udTitle) udemy.lectureTitle = forms.udTitle.trim();
      if (dirty.udPost) udemy.post = forms.udPost;
      const details: Record<string, unknown> = {};
      if (Object.keys(youtube).length) details.youtube = youtube;
      if (Object.keys(udemy).length) details.udemy = udemy;
      await motionApi.patchProject(projectId, { details });
      await load(false);
    });

  const write = () =>
    run(async () => {
      if (!view) return;
      if (dirtyAny && !window.confirm("Claude's new details replace the changes you haven't saved. Go on?")) return;
      const text = detailsAsk(view.destination, !!view.placement && !view.placement.collection.meta?.description);
      if (onAsk) await onAsk(text);
      else await motionApi.send(projectId, { text, attachments: [] });
      setWriting(true);
    });

  const patchStatus = (status: Record<string, unknown>) =>
    run(async () => {
      await motionApi.patchProject(projectId, { status });
      await load(true);
    });

  const savePlace = () =>
    run(async () => {
      if (!place) return;
      const target = collections.find((c) => c.id === place.id);
      const body = target ? { id: target.id, order: place.order, ...(target.kind === "udemy" ? { section: place.section.trim() || null } : {}) } : null;
      await motionApi.patchProject(projectId, { collection: body });
      await load(true);
    });

  const set = (k: keyof Forms, v: string) => (setForms((f) => (f ? { ...f, [k]: v } : f)), setDirty((d) => ({ ...d, [k]: true })));

  const target = collections.find((c) => c.id === place?.id) ?? null;
  const current = view?.placement ?? null;
  const inTarget = !!target && current?.collection.id === target.id;
  // the numbers it can take: its own place counts when it is already in that collection
  const count = target ? (target.videos?.length ?? 0) + (inTarget ? 0 : 1) : 0;
  const others = (target?.videos ?? []).filter((v) => v.id !== projectId);
  const placeChanged = !!view && !!place && (place.id !== (current?.collection.id ?? "") || (!!target && (place.order !== current?.episode || (target.kind === "udemy" && place.section.trim() !== (current?.section ?? "")))));
  const sections = useMemo(() => [...new Set((target?.videos ?? []).map((v) => v.section).filter((s): s is string => !!s))], [target]);

  if (!view || !forms || !place) {
    return (
      <div className="mo-modal-back" role="presentation">
        <div className="mo-modal mo-details" role="dialog" aria-modal="true" aria-label="Details">
          <div className="mo-modal-body">{error ? <p className="error">{error}</p> : <span className="spinner" />}</div>
        </div>
      </div>
    );
  }

  const shownTab = tab ?? view.destination;
  const warnings = view.warnings[shownTab];
  const has = shownTab === "youtube" ? Object.keys(view.youtube).length > 0 : Object.keys(view.udemy).length > 0;
  const claudeBusy = writing || view.running;
  const tagChars = fromList(forms.ytTags).join(",").length;
  const otherTitles = (view.youtube.titles ?? []).filter((t) => t !== forms.ytTitle);

  return (
    <div className="mo-modal-back" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mo-modal mo-details" role="dialog" aria-modal="true" aria-label="Publishing details">
        <header className="mo-modal-head">
          <h2>Details: {title}</h2>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="mo-modal-body">
          {/* where it sits */}
          <section className="mo-dt-section">
            <h3 className="mo-dt-h">Where it sits</h3>
            <div className="mo-nv-row">
              <label className="mo-field">
                <span className="label">Playlist or course</span>
                <select
                  value={place.id}
                  disabled={busy}
                  onChange={(e) => {
                    const c = collections.find((x) => x.id === e.target.value);
                    const stays = c && current?.collection.id === c.id;
                    const vids = c?.videos ?? [];
                    setPlace({ id: e.target.value, order: stays ? current!.episode : vids.length + 1, section: stays ? current!.section ?? "" : vids.length ? vids[vids.length - 1].section ?? "" : "" });
                  }}
                >
                  <option value="">None</option>
                  {(["youtube", "udemy"] as Destination[]).map((kind) => {
                    const list = collections.filter((c) => c.kind === kind);
                    return list.length ? (
                      <optgroup key={kind} label={kind === "youtube" ? "YouTube playlists" : "Udemy courses"}>
                        {list.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </select>
              </label>
              {target ? (
                <label className="mo-field">
                  <span className="label">{target.kind === "udemy" ? "Lecture" : "Episode"}</span>
                  <select value={place.order} disabled={busy} onChange={(e) => setPlace({ ...place, order: Number(e.target.value) })}>
                    {Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n} - {n > others.length ? (others.length ? "at the end" : "the first") : `before "${others[n - 1].title}"`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {target?.kind === "udemy" ? (
              <label className="mo-field">
                <span className="label">Section</span>
                <input type="text" list="mo-dt-sections" value={place.section} maxLength={80} disabled={busy} onChange={(e) => setPlace({ ...place, section: e.target.value })} />
                <datalist id="mo-dt-sections">
                  {sections.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </label>
            ) : null}
            {target && target.kind !== view.destination ? (
              <p className="mo-settings-note">
                {target.kind === "udemy"
                  ? "Moving it into a Udemy course makes it a Udemy video: no logo card, web address, promo or end screen, and no AlgoInsight in it."
                  : "Moving it into a YouTube playlist makes it a YouTube video again, with the logo card, web address and end screen."}
              </p>
            ) : null}
            <div className="mo-dt-actions">
              {current ? (
                <span className="muted small">
                  {current.collection.kind === "udemy" ? "Lecture" : "Episode"} {current.episode} of {current.count} in "{current.collection.title}"
                  {current.section ? `, section "${current.section}"` : ""}
                </span>
              ) : (
                <span className="muted small">In no playlist or course yet.</span>
              )}
              {current ? (
                <button type="button" className="btn btn-small" onClick={() => setEditCollection(current.collection)}>
                  {current.collection.kind === "udemy" ? "Course details" : "Playlist details"}
                </button>
              ) : null}
              {placeChanged ? (
                <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void savePlace()}>
                  Save place
                </button>
              ) : null}
            </div>
          </section>

          {/* how far it has got */}
          <section className="mo-dt-section">
            <h3 className="mo-dt-h">Status</h3>
            <ol className="mo-steps" aria-label="Progress">
              {STEPS.map((k) => (
                <li key={k} className={view.progress[k] ? "done" : ""}>
                  {STAGE_LABEL[k]}
                </li>
              ))}
            </ol>
            <div className="mo-dt-checks">
              <label className="mo-check-row">
                <input type="checkbox" checked={!!view.status.downloadedAt} disabled={busy} onChange={(e) => void patchStatus({ downloaded: e.target.checked })} />
                <span>
                  <span className="mo-check-title">Downloaded</span>
                  <span className="muted small">{view.status.downloadedAt ? `${view.status.downloadedFile ?? "The MP4"}, ${ago(view.status.downloadedAt)}` : "Ticked by itself when you download the MP4."}</span>
                </span>
              </label>
              <label className="mo-check-row">
                <input type="checkbox" checked={!!view.status.uploadedAt} disabled={busy} onChange={(e) => void patchStatus({ uploaded: e.target.checked })} />
                <span>
                  <span className="mo-check-title">Uploaded</span>
                  <span className="muted small">{view.status.uploadedAt ? `Marked ${ago(view.status.uploadedAt)}` : `Tick it once it is up on ${view.destination === "udemy" ? "Udemy" : "YouTube"}.`}</span>
                </span>
              </label>
            </div>
            <div className="mo-dt-url">
              <input type="url" value={url} placeholder={view.destination === "udemy" ? "The lecture's link on Udemy" : "The video's link, like https://youtu.be/..."} disabled={busy} onChange={(e) => setUrl(e.target.value)} />
              {url.trim() !== (view.status.uploadUrl ?? "") ? (
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => void patchStatus({ uploadUrl: url.trim() })}>
                  Save link
                </button>
              ) : null}
              {view.status.uploadUrl ? (
                <a className="btn btn-small" href={view.status.uploadUrl} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              ) : null}
            </div>
          </section>

          {/* what gets pasted */}
          <section className="mo-dt-section">
            <div className="mo-dt-tabs" role="tablist">
              {(["youtube", "udemy"] as Destination[]).map((d) => (
                <button key={d} type="button" role="tab" aria-selected={shownTab === d} className={shownTab === d ? "on" : ""} onClick={() => setTab(d)}>
                  <span className={`mo-dest mo-dest-${d}`} aria-hidden="true" /> {d === "youtube" ? "YouTube" : "Udemy"}
                  {d === view.destination ? <span className="muted small"> (this video)</span> : null}
                </button>
              ))}
            </div>

            {claudeBusy ? (
              <p className="mo-closing-line small">
                <span className="spinner" aria-hidden="true" /> {writing ? "Claude is writing the details. They show here when it's done (a minute or two)." : "Claude is working on this video."}
              </p>
            ) : !has ? (
              <p className="mo-closing-line small">
                No {shownTab === "youtube" ? "YouTube" : "Udemy"} details yet: press <b>Write with Claude</b>, or type them in yourself.
              </p>
            ) : null}
            {warnings.length && !claudeBusy ? (
              <div className="mo-settings-note">
                Worth fixing:
                <ul>
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {shownTab === "youtube" ? (
              <>
                <Field label="Title" copy={forms.ytTitle} count={{ n: forms.ytTitle.length, max: 70 }}>
                  <input type="text" value={forms.ytTitle} maxLength={100} onChange={(e) => set("ytTitle", e.target.value)} />
                </Field>
                {otherTitles.length ? (
                  <div className="mo-dt-options">
                    <span className="muted small">Other titles:</span>
                    {otherTitles.map((t) => (
                      <button key={t} type="button" className="mo-chip" onClick={() => set("ytTitle", t)} title="Use this title">
                        {t} <span className="muted">({t.length})</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <Field
                  label="Description"
                  copy={forms.ytPost}
                  count={{ n: wordCount(forms.ytPost), max: 400, unit: "words" }}
                  hint="Paste as it is. The chapter lines follow the video's parts and voice, even after you edit the rest."
                >
                  <GrowText value={forms.ytPost} minRows={6} placeholder="The post description: Write with Claude fills it in." onChange={(v) => set("ytPost", v)} />
                </Field>
                <Field label="Tags" copy={fromList(forms.ytTags).join(", ")} count={{ n: tagChars, max: 500, unit: "characters" }}>
                  <GrowText value={forms.ytTags} placeholder="Comma separated, the main keyword first" onChange={(v) => set("ytTags", v)} />
                </Field>
              </>
            ) : (
              <>
                <Field label="Lecture title" copy={forms.udTitle} count={{ n: forms.udTitle.length, max: 80 }}>
                  <input type="text" value={forms.udTitle} maxLength={80} onChange={(e) => set("udTitle", e.target.value)} />
                </Field>
                <Field label="Lecture description" copy={forms.udPost}>
                  <GrowText value={forms.udPost} minRows={4} placeholder="What the learner will be able to do: Write with Claude fills it in." onChange={(v) => set("udPost", v)} />
                </Field>
                {(view.udemy.quiz ?? []).length ? (
                  <div className="mo-field">
                    <div className="mo-dt-label">
                      <span className="label">Quiz</span>
                      <CopyButton text={(view.udemy.quiz ?? []).map(quizText).join("\n\n")} label="Copy all" />
                    </div>
                    {(view.udemy.quiz ?? []).map((q, i) => (
                      <div key={i} className="mo-dt-quiz">
                        <b>
                          {i + 1}. {q.question}
                        </b>
                        <ol type="A">
                          {q.options.map((o, k) => (
                            <li key={k} className={q.answer === k ? "right" : ""}>
                              {o}
                              {q.answer === k ? " (right)" : ""}
                            </li>
                          ))}
                        </ol>
                        {q.why ? <span className="muted small">Why: {q.why}</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>

        <footer className="mo-modal-foot">
          <span className={`small ${error ? "mo-warn-text" : "muted"}`} role="status">
            {error ?? (dirtyAny ? "Unsaved changes" : view.at ? `Saved ${ago(view.at)}` : "")}
          </span>
          <a className="btn btn-small" href={motionApi.detailsMdUrl(projectId)} download>
            DETAILS.md
          </a>
          <button
            type="button"
            className={`btn btn-small ${has || dirtyAny ? "" : "btn-primary"}`}
            disabled={busy || claudeBusy}
            onClick={() => void write()}
            title={claudeBusy ? "Claude is working on this video" : "Claude writes the title, description, hashtags and tags from the video"}
          >
            {claudeBusy ? "Claude is writing..." : has ? "Rewrite with Claude" : "Write with Claude"}
          </button>
          {dirtyAny ? (
            <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={() => void save()}>
              Save changes
            </button>
          ) : null}
        </footer>
      </div>
      {editCollection ? (
        <CollectionDetails
          collection={editCollection}
          onClose={() => setEditCollection(null)}
          onSaved={() => {
            setEditCollection(null);
            void load(true);
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

// ── a playlist's or course's own details ──

const toLines = (v?: string[]) => (v ?? []).join("\n");
const fromLines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

type CollectionProps = { collection: Collection; onClose: () => void; onSaved: (c: Collection) => void };

/** A playlist's title and description, or a Udemy course's landing page: title (60), subtitle (120), a
 *  description of 200 words or more, 4 or more objectives, requirements, who it is for and the level. */
export function CollectionDetails({ collection, onClose, onSaved }: CollectionProps) {
  const course = collection.kind === "udemy";
  const m = collection.meta ?? {};
  const [form, setForm] = useState({
    name: collection.title,
    title: m.title ?? "",
    subtitle: m.subtitle ?? "",
    description: m.description ?? "",
    objectives: toLines(m.objectives),
    requirements: toLines(m.requirements),
    audience: toLines(m.audience),
    level: m.level ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const words = wordCount(form.description);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const meta: CollectionMeta = course
        ? {
            title: form.title.trim(),
            subtitle: form.subtitle.trim(),
            description: form.description.trim(),
            objectives: fromLines(form.objectives),
            requirements: fromLines(form.requirements),
            audience: fromLines(form.audience),
            level: form.level || null,
          }
        : { title: form.title.trim(), description: form.description.trim() };
      onSaved(await motionApi.updateCollection(collection.id, { title: form.name.trim() || collection.title, meta }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="mo-modal-back mo-modal-over" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mo-modal" role="dialog" aria-modal="true" aria-label={course ? "Course details" : "Playlist details"}>
        <header className="mo-modal-head">
          <h2>
            <span className={`mo-dest mo-dest-${collection.kind}`} aria-hidden="true" /> {course ? "Course" : "Playlist"}: {collection.title}
          </h2>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="mo-modal-body">
          <label className="mo-field">
            <span className="label">Name in this app</span>
            <input type="text" value={form.name} maxLength={150} onChange={(e) => set("name", e.target.value)} />
          </label>
          <Field label={course ? "Course title" : "Playlist title"} copy={form.title} count={{ n: form.title.length, max: course ? 60 : 150 }}>
            <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          {course ? (
            <Field label="Subtitle" copy={form.subtitle} count={{ n: form.subtitle.length, max: 120 }}>
              <input type="text" value={form.subtitle} onChange={(e) => set("subtitle", e.target.value)} />
            </Field>
          ) : null}
          <Field label="Description" copy={form.description} hint={course ? `${words} words: Udemy asks for 200 or more.` : "What the series teaches and in what order."}>
            <GrowText value={form.description} minRows={course ? 8 : 5} onChange={(v) => set("description", v)} />
          </Field>
          {course ? (
            <>
              <Field label="What students will learn (one a line)" copy={form.objectives} hint="At least 4.">
                <GrowText value={form.objectives} minRows={4} onChange={(v) => set("objectives", v)} />
              </Field>
              <Field label="Requirements (one a line)" copy={form.requirements}>
                <GrowText value={form.requirements} onChange={(v) => set("requirements", v)} />
              </Field>
              <Field label="Who this course is for (one a line)" copy={form.audience}>
                <GrowText value={form.audience} onChange={(v) => set("audience", v)} />
              </Field>
              <label className="mo-field">
                <span className="label">Level</span>
                <select value={form.level} onChange={(e) => set("level", e.target.value)}>
                  <option value="">Not set</option>
                  {["Beginner", "Intermediate", "Expert", "All levels"].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
        <footer className="mo-modal-foot">
          <span className="mo-warn-text small" role="alert">
            {error}
          </span>
          <button type="button" className="btn btn-small" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-small" onClick={() => void save()} disabled={busy}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
