// Motion's home: a "New video" button (the new-video dialog: where it goes, its playlist or course and
// episode, the tone, the length), starter templates, every saved video and the brand kits.
//
// The videos are arranged by where they go: each YouTube playlist and Udemy course with its videos in
// episode order (a course's grouped by section), then the videos in none. Each shows how far it has got
// (script, scenes, voice, export) and its downloaded and uploaded tags; Details holds everything the upload
// needs.

import { useCallback, useEffect, useMemo, useState } from "react";

import { ago, clock, lengthLabel, motionApi, saveDraft } from "./api";
import BrandKitEditor from "./BrandKitEditor";
import NewVideoDialog, { type NewVideoPreset } from "./NewVideoDialog";
import DetailsModal, { CollectionDetails } from "./PublishDetails";
import { STAGE_LABEL, TONE_OPTIONS, type Aspect, type BrandKit, type Collection, type Destination, type MotionHealth, type ProjectSummary } from "./types";

type Props = { health: MotionHealth | null; onOpen: (id: string) => void };

/** A starter either opens the new-video dialog with a preset (the narrated films) or makes a short video
 *  straight away with its brief in the chat box. */
type Starter = { title: string; hint: string } & ({ preset: NewVideoPreset } | { aspect: Aspect; kit: string; text: string });

const STARTERS: Starter[] = [
  {
    title: "AlgoInsight daily (narrated)",
    hint: "16:9 paper look · playlist or course, tone and length chosen first · Pooja's voice",
    preset: {},
  },
  {
    title: "Research paper, decoded",
    hint: "16:9 paper look · informational tone · the paper's own numbers",
    preset: { tone: "informational", notes: "The paper: [title or link; attach the PDF if you have it]. Why it matters to our learners: " },
  },
  {
    title: "System design reel",
    aspect: "9:16",
    kit: "algoinsight",
    hint: "9:16 · hook, diagram builds, takeaway, end card",
    text: "A 30-second 9:16 system design reel about [CONCEPT]: a hook question, the diagram builds step by step (boxes, arrows, a request travelling through), one takeaway line, then the end card.",
  },
  {
    title: "Paper explainer",
    aspect: "16:9",
    kit: "algoinsight-paper",
    hint: "16:9 · graph paper, marker and red pen",
    text: "A 40-second 16:9 explainer on graph paper about [TOPIC]: three ideas, each one a sticky-note card with a marker highlight, ending on the end card.",
  },
  {
    title: "Animated chart",
    aspect: "16:9",
    kit: "",
    hint: "16:9 · bars or lines that build",
    text: "A 15-second 16:9 animated bar chart of [WHAT]. Data: [YOUR NUMBERS]. Bars grow one by one, the biggest gets highlighted, then a one-line conclusion.",
  },
  {
    title: "Logo sting",
    aspect: "1:1",
    kit: "",
    hint: "1:1 · 5-6 seconds",
    text: "A 6-second 1:1 logo sting: the logo draws or snaps in, then the tagline appears under it.",
  },
];

/** The tags on a video: how far it has got (until it is exported), then exported, downloaded, uploaded,
 *  and whether its publishing details are written for where it goes. */
function StatusTags({ p }: { p: ProjectSummary }) {
  const pr = p.progress;
  if (!pr) return null;
  const dest: Destination = p.destination ?? "youtube";
  const st = p.status ?? {};
  // before the export: the furthest of the making steps (downloaded and uploaded have their own tags)
  const making = pr.voiced ? "voiced" : pr.built ? "built" : pr.script ? "script" : "new";
  return (
    <span className="mo-tags">
      {!pr.exported ? <span className="mo-tag">{STAGE_LABEL[making]}</span> : <span className="mo-tag on">Exported</span>}
      {pr.downloaded ? (
        <span className="mo-tag on" title={st.downloadedAt ? `${st.downloadedFile ?? "The MP4"}, ${ago(st.downloadedAt)}` : undefined}>
          Downloaded
        </span>
      ) : null}
      {pr.uploaded ? (
        st.uploadUrl ? (
          <a className="mo-tag on" href={st.uploadUrl} target="_blank" rel="noopener noreferrer" title={st.uploadUrl}>
            Uploaded ↗
          </a>
        ) : (
          <span className="mo-tag on">Uploaded</span>
        )
      ) : null}
      {p.details?.[dest] ? <span className="mo-tag on">Details</span> : <span className="mo-tag dim">No details</span>}
    </span>
  );
}

export default function Library({ health, onOpen }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kitEditor, setKitEditor] = useState<{ kit: BrandKit | null; copyFrom?: BrandKit | null } | null>(null);
  const [newVideo, setNewVideo] = useState<NewVideoPreset | null>(null);
  const [details, setDetails] = useState<ProjectSummary | null>(null);
  const [editCollection, setEditCollection] = useState<Collection | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    motionApi.listProjects().then(setProjects).catch((err) => setError(err.message));
    motionApi.listCollections().then(setCollections).catch(() => null);
    motionApi.listKits().then(setKits).catch(() => null);
  }, []);
  useEffect(load, [load]);

  // each playlist and course with its videos in episode order; the videos in none after them
  const { groups, loose } = useMemo(() => {
    const byId = new Map((projects ?? []).map((p) => [p.id, p]));
    const placed = new Set<string>();
    const groups = [...collections]
      .sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === "youtube" ? -1 : 1))
      .map((c) => {
        const rows = (c.videos ?? []).flatMap((v) => {
          const p = byId.get(v.id);
          if (!p) return [];
          placed.add(p.id);
          return [{ p, episode: v.episode, section: v.section }];
        });
        return { c, rows };
      });
    return { groups, loose: (projects ?? []).filter((p) => !placed.has(p.id)) };
  }, [collections, projects]);

  /** A short video straight away (a reel, a sting, a chart) with its brief in the chat box. */
  async function createShort(opts: { aspect: Aspect; kit: string; text: string; title: string }) {
    setBusy(true);
    setError(null);
    try {
      const kitId = opts.kit && kits.some((k) => k.id === opts.kit) ? opts.kit : undefined;
      const { project } = await motionApi.createProject({ aspect: opts.aspect, brandKitId: kitId, title: opts.title });
      saveDraft(project.id, { text: opts.text, attachments: [] });
      onOpen(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const newCollection = (kind: Destination) =>
    act(async () => {
      const name = window.prompt(kind === "udemy" ? "The new Udemy course's name:" : "The new YouTube playlist's name:");
      if (!name?.trim()) return;
      await motionApi.createCollection(kind, name.trim());
      load();
    });

  const renameCollection = (c: Collection) =>
    act(async () => {
      const name = window.prompt("New name:", c.title);
      if (!name?.trim() || name.trim() === c.title) return;
      await motionApi.updateCollection(c.id, { title: name.trim() });
      load();
    });

  const deleteCollection = (c: Collection) =>
    act(async () => {
      const n = c.videos?.length ?? 0;
      if (!window.confirm(`Delete the ${c.kind === "udemy" ? "course" : "playlist"} "${c.title}"?${n ? ` Its ${n} video${n > 1 ? "s stay" : " stays"}, in no playlist or course.` : ""}`)) return;
      await motionApi.deleteCollection(c.id);
      load();
    });

  /** Moves a video one place up or down in its playlist or course. */
  const move = (c: Collection, id: string, delta: number) =>
    act(async () => {
      const ids = (c.videos ?? []).map((v) => v.id);
      const i = ids.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      setCollections(await motionApi.reorderCollection(c.id, ids));
    });

  async function remove(p: ProjectSummary) {
    if (!window.confirm(`Delete "${p.title}"? Its scenes, uploads and exports are deleted too.`)) return;
    try {
      await motionApi.deleteProject(p.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeKit(k: BrandKit) {
    if (!window.confirm(`Delete the brand kit "${k.name}"?`)) return;
    try {
      await motionApi.deleteKit(k.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mo-library">
      <div className="mo-lib-head">
        <div>
          <h1>Motion</h1>
          <p className="muted">Short animated videos, written as code by Claude. Describe one, pick a look, then point at anything to change it.</p>
        </div>
        <button type="button" className="btn btn-primary mo-new" onClick={() => setNewVideo({})} disabled={busy}>
          + New video
        </button>
      </div>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {/* only the engine new videos use matters here: Claude Code needs a login, the API engine a key */}
      {health && health.defaultEngine === "api" && !health.claude.ready ? (
        <div className="banner banner-warn">
          Claude needs an API key: put <code>ANTHROPIC_API_KEY=...</code> in <code>backend\.env</code> (or set it in your environment), then restart the app.
        </div>
      ) : null}
      {health && health.defaultEngine === "claude-code" && health.claudeCode && health.claudeCode.loggedIn === false ? (
        <div className="banner banner-warn">
          Claude Code isn't logged in on this computer: open a terminal, run <code>claude</code> and log in once.
        </div>
      ) : null}
      {health && !health.ffmpeg ? <div className="banner banner-warn">FFmpeg was not found, so videos can be made and previewed but not exported.</div> : null}

      <section>
        <h2 className="mo-h2">Start from</h2>
        <div className="mo-starters">
          {STARTERS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="mo-starter"
              disabled={busy}
              onClick={() => ("preset" in s ? setNewVideo(s.preset) : void createShort({ aspect: s.aspect, kit: s.kit, text: s.text, title: s.title }))}
            >
              <strong>{s.title}</strong>
              <span className="muted small">{s.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="mo-kits-head">
          <h2 className="mo-h2">Your videos</h2>
          <span className="mo-head-actions">
            <button type="button" className="btn btn-small" onClick={() => void newCollection("youtube")}>
              + YouTube playlist
            </button>
            <button type="button" className="btn btn-small" onClick={() => void newCollection("udemy")}>
              + Udemy course
            </button>
          </span>
        </div>
        {projects === null ? <span className="spinner" /> : null}
        {projects?.length === 0 ? <p className="muted">No videos yet. Press New video or pick a starter above.</p> : null}

        {groups.map(({ c, rows }) => {
          const total = rows.reduce((s, r) => s + r.p.duration, 0);
          const uploaded = rows.filter((r) => r.p.progress?.uploaded).length;
          const open = !folded[c.id];
          let lastSection: string | null | undefined;
          return (
            <div key={c.id} className="mo-coll">
              <div className="mo-coll-head">
                <button type="button" className="mo-coll-fold" aria-expanded={open} onClick={() => setFolded((f) => ({ ...f, [c.id]: open }))} title={open ? "Fold" : "Unfold"}>
                  {open ? "▾" : "▸"}
                </button>
                <span className={`mo-dest mo-dest-${c.kind}`} aria-hidden="true" />
                <span className="mo-coll-title">
                  <strong>{c.title}</strong>
                  <span className="muted small">
                    {c.kind === "udemy" ? "Udemy course" : "YouTube playlist"} · {rows.length} video{rows.length === 1 ? "" : "s"}
                    {total ? ` · ${clock(total)}` : ""}
                    {rows.length ? ` · ${uploaded} uploaded` : ""}
                    {c.meta?.description ? "" : " · no description yet"}
                  </span>
                </span>
                <button type="button" className="btn btn-small" onClick={() => setEditCollection(c)}>
                  {c.kind === "udemy" ? "Course details" : "Playlist details"}
                </button>
                <button type="button" className="btn btn-small" onClick={() => void renameCollection(c)}>
                  Rename
                </button>
                <button type="button" className="btn btn-small" onClick={() => void deleteCollection(c)}>
                  Delete
                </button>
              </div>
              {open ? (
                rows.length ? (
                  <ol className="mo-eps">
                    {rows.map(({ p, episode, section }, i) => {
                      const head = c.kind === "udemy" && section !== lastSection ? section : undefined;
                      lastSection = section;
                      return (
                        <li key={p.id}>
                          {head !== undefined ? <div className="mo-eps-section">{head || "No section"}</div> : null}
                          <div className="mo-ep">
                            <span className="mo-ep-num">{episode}</span>
                            <button type="button" className="mo-ep-open" onClick={() => onOpen(p.id)}>
                              <span className="mo-ep-poster">
                                {p.scenes ? <img src={motionApi.posterUrl(p.id, p.version)} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} /> : null}
                              </span>
                              <span className="mo-ep-text">
                                <span className="mo-card-title" title={p.title}>
                                  {p.title}
                                </span>
                                <span className="muted small">
                                  {p.duration ? lengthLabel(p.duration) : "no scenes yet"} · {TONE_OPTIONS.find((t) => t.id === p.tone)?.label ?? "Normal"} · edited {ago(p.updatedAt)}
                                </span>
                              </span>
                            </button>
                            <StatusTags p={p} />
                            <span className="mo-ep-actions">
                              <button type="button" className="btn btn-small" disabled={i === 0} onClick={() => void move(c, p.id, -1)} aria-label="Move up" title="Move up">
                                ↑
                              </button>
                              <button type="button" className="btn btn-small" disabled={i === rows.length - 1} onClick={() => void move(c, p.id, 1)} aria-label="Move down" title="Move down">
                                ↓
                              </button>
                              <button type="button" className="btn btn-small" onClick={() => setDetails(p)}>
                                Details
                              </button>
                              <button type="button" className="btn btn-small" onClick={() => void remove(p)} aria-label={`Delete ${p.title}`} title="Delete">
                                ×
                              </button>
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="muted small mo-coll-empty">No videos yet: pick it in New video, or move one here from its Details.</p>
                )
              ) : null}
            </div>
          );
        })}

        {loose.length ? (
          <>
            {groups.length ? <h3 className="mo-h3">In no playlist or course</h3> : null}
            <div className="mo-grid">
              {loose.map((p) => (
                <article key={p.id} className="mo-card">
                  <button type="button" className="mo-card-open" onClick={() => onOpen(p.id)}>
                    <span className={`mo-poster ar-${p.aspect.replace(":", "x")}`}>
                      {p.scenes ? <img src={motionApi.posterUrl(p.id, p.version)} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} /> : null}
                    </span>
                    <span className="mo-card-title" title={p.title}>
                      <span className={`mo-dest mo-dest-${p.destination ?? "youtube"}`} aria-hidden="true" /> {p.title}
                    </span>
                    <span className="muted small">
                      {p.aspect} · {p.duration ? lengthLabel(p.duration) : "no scenes yet"} · {p.scenes} scene{p.scenes === 1 ? "" : "s"}
                    </span>
                    <span className="muted small">Edited {ago(p.updatedAt)}</span>
                  </button>
                  <div className="mo-card-foot">
                    <StatusTags p={p} />
                    <button type="button" className="btn btn-small" onClick={() => setDetails(p)}>
                      Details
                    </button>
                  </div>
                  <button type="button" className="mo-card-delete" onClick={() => void remove(p)} aria-label={`Delete ${p.title}`} title="Delete">
                    ×
                  </button>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section>
        <div className="mo-kits-head">
          <h2 className="mo-h2">Brand kits</h2>
          <button type="button" className="btn btn-small" onClick={() => setKitEditor({ kit: null })}>
            + New kit
          </button>
        </div>
        <p className="muted small">Claude uses only these colours and fonts. A kit can be read from a website.</p>
        <div className="mo-kits">
          {kits.map((k) => {
            const logo = motionApi.logoUrl(k);
            return (
              <article key={k.id} className="mo-kit">
                <div className="mo-kit-swatches" style={{ background: k.background ? `${k.background}, ${k.palette.bg}` : k.palette.bg }}>
                  {logo ? <img src={logo} alt="" /> : <span style={{ color: k.palette.ink, fontFamily: `"${k.fonts.display}", system-ui` }}>{k.name}</span>}
                  <span className="mo-kit-dots">
                    {Object.values(k.palette).map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                </div>
                <div className="mo-kit-info">
                  <strong>{k.name}</strong>
                  <span className="muted small">
                    {k.fonts.display}
                    {k.fonts.body !== k.fonts.display ? ` + ${k.fonts.body}` : ""} · {k.motion}
                  </span>
                </div>
                <div className="mo-kit-actions">
                  <button type="button" className="btn btn-small" onClick={() => setKitEditor({ kit: k })}>
                    Edit
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setKitEditor({ kit: null, copyFrom: k })}>
                    Copy
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => void removeKit(k)}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {kitEditor ? (
        <BrandKitEditor
          kit={kitEditor.kit}
          copyFrom={kitEditor.copyFrom}
          onClose={() => setKitEditor(null)}
          onSaved={() => {
            setKitEditor(null);
            load();
          }}
        />
      ) : null}
      {newVideo ? <NewVideoDialog preset={newVideo} onClose={() => setNewVideo(null)} onCreated={onOpen} /> : null}
      {details ? <DetailsModal projectId={details.id} title={details.title} onChanged={load} onClose={() => setDetails(null)} /> : null}
      {editCollection ? (
        <CollectionDetails
          collection={editCollection}
          onClose={() => setEditCollection(null)}
          onSaved={() => {
            setEditCollection(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}
