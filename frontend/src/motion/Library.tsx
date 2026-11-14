// Motion's home: a "New video" button, starter templates, every saved video (reopen, delete) and the
// brand kits.

import { useCallback, useEffect, useState } from "react";

import { ago, lengthLabel, motionApi, saveDraft } from "./api";
import BrandKitEditor from "./BrandKitEditor";
import type { Aspect, BrandKit, MotionHealth, ProjectSummary } from "./types";

type Props = { health: MotionHealth | null; onOpen: (id: string) => void };

const STARTERS: { title: string; aspect: Aspect; kit: string; text: string; hint: string }[] = [
  {
    title: "AlgoInsight daily (narrated)",
    aspect: "16:9",
    kit: "algoinsight-paper",
    hint: "16:9 paper look · 10-30 min · Pooja's voice",
    text: "A narrated explainer in the AlgoInsight daily paper look about [TOPIC]. Attach the competitor transcript: teach every point it covers, but build our own version with our own running story, examples and sentences, in simple English, every fact checked in FACTS.md, the script before the scenes, and the YouTube details at the end.",
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

export default function Library({ health, onOpen }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kitEditor, setKitEditor] = useState<{ kit: BrandKit | null; copyFrom?: BrandKit | null } | null>(null);

  const load = useCallback(() => {
    motionApi.listProjects().then(setProjects).catch((err) => setError(err.message));
    motionApi.listKits().then(setKits).catch(() => null);
  }, []);
  useEffect(load, [load]);

  async function create(opts: { aspect?: Aspect; kit?: string; text?: string; title?: string } = {}) {
    setBusy(true);
    setError(null);
    try {
      const kitId = opts.kit && kits.some((k) => k.id === opts.kit) ? opts.kit : undefined;
      const { project } = await motionApi.createProject({ aspect: opts.aspect, brandKitId: kitId, title: opts.title });
      if (opts.text) saveDraft(project.id, { text: opts.text, attachments: [] });
      onOpen(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

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
        <button type="button" className="btn btn-primary mo-new" onClick={() => void create()} disabled={busy}>
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
            <button key={s.title} type="button" className="mo-starter" disabled={busy} onClick={() => void create({ aspect: s.aspect, kit: s.kit, text: s.text, title: s.title })}>
              <strong>{s.title}</strong>
              <span className="muted small">{s.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mo-h2">Your videos</h2>
        {projects === null ? <span className="spinner" /> : null}
        {projects?.length === 0 ? <p className="muted">No videos yet. Press New video or pick a starter above.</p> : null}
        <div className="mo-grid">
          {projects?.map((p) => (
            <article key={p.id} className="mo-card">
              <button type="button" className="mo-card-open" onClick={() => onOpen(p.id)}>
                <span className={`mo-poster ar-${p.aspect.replace(":", "x")}`}>
                  {p.scenes ? <img src={motionApi.posterUrl(p.id, p.version)} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} /> : null}
                </span>
                <span className="mo-card-title" title={p.title}>
                  {p.title}
                </span>
                <span className="muted small">
                  {p.aspect} · {p.duration ? lengthLabel(p.duration) : "no scenes yet"} · {p.scenes} scene{p.scenes === 1 ? "" : "s"}
                </span>
                <span className="muted small">Edited {ago(p.updatedAt)}</span>
              </button>
              <button type="button" className="mo-card-delete" onClick={() => void remove(p)} aria-label={`Delete ${p.title}`} title="Delete">
                ×
              </button>
            </article>
          ))}
        </div>
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
    </div>
  );
}
