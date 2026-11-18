// One video: chat on the left, the live preview, scene strip and properties on the right, and a top
// bar with the title, aspect, brand kit, the video's settings (YouTube or Udemy, logo, web address,
// promo, end screen, target length), Claude settings, Script, Voice, Undo and Export (the MP4, and
// beside it what the upload needs: the captions and the thumbnail).
//
// The page keeps a copy of the chat log and the project, and long-polls /events for every change
// (streamed text, tool steps, a new project version, export progress), so the preview updates as
// Claude writes each scene.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ago, articleFor, bytesLabel, clock, motionApi, takeDraft } from "./api";
import BrandKitEditor from "./BrandKitEditor";
import Chat, { type Command, type SendInput } from "./Chat";
import Preview from "./Preview";
import PropsPanel from "./PropsPanel";
import PublishPanel, { THUMBNAIL_TEXT } from "./PublishPanel";
import DetailsModal from "./PublishDetails";
import ScriptModal from "./ScriptModal";
import { TONE_OPTIONS, isBuildable, type Aspect, type Asset, type BrandKit, type CommentTarget, type ExportJob, type HubOp, type LogEntry, type MotionHealth, type ProjectView, type Tone, type VoiceJob } from "./types";
import VideoSettings, { closingSummary, destinationOf } from "./VideoSettings";
import VoicePanel from "./VoicePanel";

type Props = { projectId: string; health: MotionHealth | null; onBack: () => void; onOpen: (id: string) => void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sent for the user when they pick a new tone for a script that is already written. */
const toneText = (label: string) =>
  `I changed the script's tone to ${label}. Rewrite the narration in that tone (see Tone), scene by scene, keeping the same ideas, facts, cues and places for my words. Leave the scenes I rewrote in my own words exactly as they are.`;

/** Sent for the user when they approve the script in their own words. */
const BUILD_TEXT =
  "I've put the script in my own words and approved it. Build the scenes now, keeping my wording exactly as it is.";

export default function Editor({ projectId, health, onBack, onOpen }: Props) {
  const [view, setView] = useState<ProjectView | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [voiceJob, setVoiceJob] = useState<VoiceJob | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptTab, setScriptTab] = useState<string | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kitEditor, setKitEditor] = useState<{ kit: BrandKit | null; copyFrom?: BrandKit | null } | null>(null);
  const [menu, setMenu] = useState<"export" | "publish" | "settings" | "voice" | "video" | null>(null);
  const [title, setTitle] = useState("");
  const [loaded, setLoaded] = useState(false);
  const draft = useMemo(() => takeDraft(projectId), [projectId]);
  const seqRef = useRef(0);
  const bootRef = useRef("");
  const refreshTimer = useRef<number | undefined>(undefined);

  const applyView = useCallback((v: ProjectView) => {
    setView(v);
    setRunning(v.running);
    setJob(v.exportJob);
    setVoiceJob(v.voiceJob);
    setTitle((t) => (document.activeElement?.id === "mo-title" ? t : v.project.title));
  }, []);

  const refreshView = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      motionApi.getProject(projectId).then(applyView).catch((err) => setError(err.message));
    }, 120);
  }, [applyView, projectId]);

  const refreshAssets = useCallback(() => motionApi.listAssets(projectId).then(setAssets).catch(() => null), [projectId]);
  const refreshKits = useCallback(() => motionApi.listKits().then(setKits).catch(() => null), []);

  const loadAll = useCallback(async () => {
    const [v, chat] = await Promise.all([motionApi.getProject(projectId), motionApi.getChat(projectId)]);
    applyView(v);
    setLog(chat.log);
    setRunning(chat.running);
    seqRef.current = chat.seq;
    bootRef.current = chat.boot;
  }, [applyView, projectId]);

  useEffect(() => {
    setLoaded(false);
    loadAll()
      .then(() => setLoaded(true))
      .catch((err) => setError(err.message));
    void refreshAssets();
    void refreshKits();
  }, [loadAll, refreshAssets, refreshKits]);

  // live updates
  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const ctrl = new AbortController();
    const apply = (op: HubOp) => {
      switch (op.op) {
        case "add":
          setLog((l) => (l.some((e) => e.id === op.entry.id) ? l : [...l, op.entry]));
          break;
        case "patch":
          setLog((l) => l.map((e) => (e.id === op.id ? ({ ...e, ...op.fields } as LogEntry) : e)));
          break;
        case "append":
          setLog((l) => l.map((e) => (e.id === op.id && "text" in e ? ({ ...e, text: e.text + op.text } as LogEntry) : e)));
          break;
        case "project":
          refreshView();
          break;
        case "running":
          setRunning(op.running);
          if (!op.running) {
            refreshView();
            void refreshAssets();
          }
          break;
        case "export":
          setJob(op.job);
          if (op.job.state === "done") refreshView();
          break;
        case "assets":
          // a b-roll clip finished converting, or Claude imported one
          void refreshAssets();
          break;
        case "kits":
          void refreshKits();
          break;
        case "voice":
          setVoiceJob(op.job);
          if (op.job.state !== "running" && op.job.state !== "queued") refreshView();
          break;
      }
    };
    (async () => {
      while (!stopped) {
        try {
          const res = await motionApi.events(projectId, seqRef.current, bootRef.current, ctrl.signal);
          if (res.events.some((e) => e.op === "reload")) {
            await loadAll();
            continue;
          }
          for (const op of res.events) {
            apply(op);
            seqRef.current = Math.max(seqRef.current, op.seq);
          }
        } catch {
          if (stopped) return;
          await sleep(2000);
        }
      }
    })();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [loaded, loadAll, projectId, refreshAssets, refreshKits, refreshView]);

  // a click outside an open menu, or Escape, closes it
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".mo-menu-wrap")) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // an open menu stays inside the window: on a narrow window the top bar wraps, and a menu that opens
  // towards the left from a button now near the left edge (Export) would run off it
  useLayoutEffect(() => {
    if (!menu) return;
    const fit = () => {
      const el = document.querySelector<HTMLElement>(".mo-top .mo-menu");
      if (!el) return;
      el.style.transform = "";
      const r = el.getBoundingClientRect();
      const room = window.innerWidth - 12;
      const shift = r.left < 12 ? 12 - r.left : r.right > room ? room - r.right : 0;
      if (shift) el.style.transform = `translateX(${Math.round(shift)}px)`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [menu]);

  const bundle = view?.bundle;
  // scenes Claude still has to write (the promo and the end screen come with the app), for Continue building
  const buildable = bundle ? bundle.scenes.filter(isBuildable) : [];
  const unwritten = buildable.filter((s) => !s.source).length;
  useEffect(() => {
    if (!bundle) return;
    if (!selected || !bundle.scenes.some((s) => s.id === selected)) setSelected(bundle.scenes[0]?.id ?? null);
  }, [bundle, selected]);

  const settings = view?.project.settings;
  const model = settings?.model || health?.defaultModel || "claude-opus-5-5";
  const effort = settings?.effort || health?.defaultEffort || "high";
  const engine = settings?.engine || health?.defaultEngine || "claude-code";

  async function send(msg: SendInput & { comment?: CommentTarget }) {
    await motionApi.send(projectId, { ...msg, model, effort, engine });
    setRunning(true);
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const patch = (body: Record<string, unknown>) => act(async () => applyView(await motionApi.patchProject(projectId, body)));

  /** A new tone. With a script already written, Claude rewrites the draft in it when the user says yes (the
   *  tone alone shapes only the next draft, so a written script used to stay as it was). */
  async function changeTone(tone: Tone) {
    await patch({ tone });
    const hasScript = (view?.script?.narrated ?? 0) > 0;
    const label = TONE_OPTIONS.find((t) => t.id === tone)?.label ?? tone;
    if (hasScript && !running && window.confirm(`Ask Claude to rewrite the script in the ${label} tone now? Scenes you put in your own words stay as they are.`)) {
      await act(() => send({ text: toneText(label), attachments: [] }));
    }
  }

  async function command(cmd: Command) {
    if (cmd === "export") await act(async () => setJob(await motionApi.startExport(projectId, 2160)));
    else if (cmd === "undo") await act(async () => applyView(await motionApi.undo(projectId)));
    else if (cmd === "clear") await act(() => motionApi.newChat(projectId));
    else if (cmd === "new") await act(async () => onOpen((await motionApi.createProject({ brandKitId: view?.project.brandKitId })).project.id));
  }

  if (!view || !bundle) {
    return <div className="mo-loading">{error ? <p className="error">{error}</p> : <span className="spinner" />}</div>;
  }

  const sceneIndex = bundle.scenes.findIndex((s) => s.id === selected);
  const scene = sceneIndex >= 0 ? bundle.scenes[sceneIndex] : null;
  const kit = kits.find((k) => k.id === view.project.brandKitId) ?? null;
  const audioAssets = assets.filter((a) => a.kind === "audio");
  const exporting = job?.state === "queued" || job?.state === "running";
  const voicing = voiceJob?.state === "queued" || voiceJob?.state === "running";
  const narrated = bundle.scenes.filter((s) => s.narration && s.kind !== "endscreen");
  const voicedCount = narrated.filter((s) => s.voiced).length;
  const destination = destinationOf(view);
  // places Claude's draft left for the user's own words, while the script waits for them
  const waitingSlots = (view.script?.slots ?? []).reduce((n, x) => n + x.asks.length, 0);

  /** Moves the selection to the scene before or after this one (the preview follows). */
  const stepScene = (delta: number) => {
    const next = bundle.scenes[sceneIndex + delta];
    if (next) setSelected(next.id);
  };

  /** Uploads a music file for the export's music bed and selects it. */
  const uploadMusic = (file: File) =>
    act(async () => {
      const saved = await motionApi.uploadAssets(projectId, [file]);
      await refreshAssets();
      const name = saved.find((a) => a.kind === "audio")?.name ?? saved[0]?.name;
      if (name) applyView(await motionApi.patchProject(projectId, { audio: name }));
    });

  return (
    <div className="mo-editor">
      <header className="mo-top">
        <button type="button" className="btn btn-small" onClick={onBack} title="All videos">
          ← Videos
        </button>
        <input
          id="mo-title"
          className="mo-title"
          value={title}
          aria-label="Video title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== view.project.title && void patch({ title })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <select
          className="mo-select"
          value={view.project.aspect}
          disabled={running}
          aria-label="Aspect ratio"
          onChange={(e) => {
            const aspect = e.target.value as Aspect;
            if (bundle.scenes.some((s) => s.source) && !window.confirm(`The scenes are laid out for ${view.project.aspect}. Switch to ${aspect}? Ask Claude to adapt them afterwards.`)) return;
            void patch({ aspect });
          }}
        >
          {(health?.aspects ?? ["9:16", "16:9", "1:1", "4:5"]).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          className="mo-select"
          value={view.project.brandKitId ?? ""}
          disabled={running}
          aria-label="Brand kit"
          title="The brand kit (pick Edit this kit… to change it; every video that uses it changes)"
          onChange={(e) => {
            if (e.target.value === "__new") setKitEditor({ kit: null });
            else if (e.target.value === "__edit") {
              if (kit) setKitEditor({ kit });
            } else void patch({ brandKitId: e.target.value || null });
          }}
        >
          {kits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
          {/* editing lives in the list (it was a button) so the top bar has room for Publish */}
          {kit ? <option value="__edit">Edit this kit…</option> : null}
          <option value="__new">+ New brand kit…</option>
        </select>
        <div className="mo-menu-wrap">
          <button
            type="button"
            className={`btn btn-small mo-video-btn ${menu === "video" ? "btn-on" : ""}`}
            onClick={() => setMenu(menu === "video" ? null : "video")}
            title="Made for YouTube or Udemy, the logo, web address, promo and end screen, and the target length"
          >
            <span className={`mo-dest mo-dest-${destination}`} aria-hidden="true" />
            {destination === "udemy" ? "For Udemy" : "For YouTube"}
          </button>
          {menu === "video" ? (
            <div className="mo-menu mo-menu-left mo-video-menu">
              <VideoSettings view={view} disabled={running} onPatch={(body) => patch(body)} />
            </div>
          ) : null}
        </div>
        {/* the script's tone, right on the top bar (it was only in the For YouTube menu, easy to miss) */}
        <select
          className="mo-select mo-tone-select"
          value={view.project.tone ?? "normal"}
          disabled={running}
          aria-label="Script tone"
          title={TONE_OPTIONS.find((t) => t.id === (view.project.tone ?? "normal"))?.hint ?? "The script's tone"}
          onChange={(e) => void changeTone(e.target.value as Tone)}
        >
          {TONE_OPTIONS.map((t) => (
            <option key={t.id} value={t.id}>
              Tone: {t.label}
            </option>
          ))}
        </select>
        <span className="mo-spacer" />
        <div className="mo-menu-wrap">
          <button type="button" className={`btn btn-small ${menu === "settings" ? "btn-on" : ""}`} onClick={() => setMenu(menu === "settings" ? null : "settings")}>
            Claude
          </button>
          {menu === "settings" ? (
            <div className="mo-menu">
              <label className="mo-field">
                <span className="label">Engine</span>
                <select value={engine} onChange={(e) => void patch({ settings: { engine: e.target.value } })}>
                  <option value="claude-code" disabled={health ? !health.claudeCode.ready : false}>
                    Claude Code (your Claude plan){health && !health.claudeCode.ready ? " - not installed" : ""}
                  </option>
                  <option value="api">API key (billed per token)</option>
                </select>
              </label>
              {engine === "claude-code" && health && !health.claudeCode.loggedIn ? (
                <p className="error small">Claude Code isn't logged in on this computer: run <code>claude</code> in a terminal once and log in.</p>
              ) : null}
              <label className="mo-field">
                <span className="label">Model</span>
                <select value={model} onChange={(e) => void patch({ settings: { model: e.target.value } })}>
                  {(health?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mo-field">
                <span className="label">Effort</span>
                <select value={effort} onChange={(e) => void patch({ settings: { effort: e.target.value } })}>
                  {(health?.efforts ?? ["low", "medium", "high", "xhigh"]).map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                Higher effort writes better scenes and uses more.{" "}
                {view.totals.cost ? `API spend on this video: about ${view.totals.cost.toFixed(2)}. ` : ""}
                {view.totals.planCost ? `Claude Code usage so far: about ${view.totals.planCost.toFixed(2)} at API prices (counted against your plan, not billed per token).` : ""}
              </p>
              <button type="button" className="btn btn-small" disabled={running} onClick={() => (setMenu(null), void command("clear"))}>
                New chat (keeps the scenes)
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className="btn btn-small" onClick={() => setScriptOpen(true)} title="The narration, chapters and Claude's documents">
          Script
        </button>
        {narrated.length ? (
          <div className="mo-menu-wrap">
            <button type="button" className={`btn btn-small ${menu === "voice" ? "btn-on" : ""}`} onClick={() => setMenu(menu === "voice" ? null : "voice")} title="Generate the narration with your ElevenLabs voice">
              {voicing ? `Voice ${voiceJob?.done ?? 0}/${voiceJob?.total ?? 0}` : `Voice ${voicedCount}/${narrated.length}`}
            </button>
            {menu === "voice" ? (
              <div className="mo-menu mo-voice-menu">
                <VoicePanel projectId={projectId} job={voiceJob} disabled={running} version={view.project.version} onError={setError} />
              </div>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-small"
          disabled={!view.undo || running}
          onClick={() => void command("undo")}
          title={view.undo ? `Undo: ${view.undo.label.replace("Before: ", "")} (${ago(view.undo.at)})` : "Nothing to undo"}
        >
          Undo
        </button>
        {/* Details: where the video sits (playlist or course, episode), downloaded and uploaded, and every
            YouTube and Udemy field with copy buttons */}
        <button
          type="button"
          className={`btn btn-small ${detailsOpen ? "btn-on" : ""}`}
          onClick={() => setDetailsOpen(true)}
          title="The playlist or course, downloaded and uploaded, and the titles, description, tags and quiz for the upload"
        >
          Details
          {view.project.status?.uploadedAt ? " ✓" : ""}
        </button>
        {/* Publish: its own menu with everything the upload needs (the thumbnail, the captions, the
            chapters and DETAILS.md, one by one or in one zip, and the latest MP4) */}
        <div className="mo-menu-wrap">
          <button
            type="button"
            className={`btn btn-small ${menu === "publish" ? "btn-on" : ""}`}
            onClick={() => setMenu(menu === "publish" ? null : "publish")}
            title={`The thumbnail, captions and details for the ${destination === "udemy" ? "Udemy" : "YouTube"} upload`}
          >
            Publish
          </button>
          {menu === "publish" ? (
            <div className="mo-menu mo-publish-menu">
              <PublishPanel
                projectId={projectId}
                view={view}
                running={running}
                onAskThumbnail={() => send({ text: THUMBNAIL_TEXT, attachments: [] })}
                onRefresh={() => motionApi.getProject(projectId).then(applyView, (err) => setError(err.message))}
                onOpen={(m) => setMenu(m)}
              />
            </div>
          ) : null}
        </div>
        <div className="mo-menu-wrap">
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => setMenu(menu === "export" ? null : "export")}
            title="Make the MP4 (1080p, 4K or 720p) with the narration, sounds and music"
          >
            {exporting ? `Exporting ${Math.round(job?.percent ?? 0)}%` : "Export"}
          </button>
          {menu === "export" ? (
            <div className="mo-menu mo-export">
              <ExportPanel
                job={job}
                view={view}
                audioAssets={audioAssets}
                exporting={exporting}
                voiceName={health?.voice?.name ?? null}
                onStart={(res, opts) => act(async () => setJob(await motionApi.startExport(projectId, res, opts)))}
                onCancel={() => act(() => motionApi.cancelExport(projectId))}
                onAudio={(name) => patch({ audio: name || null })}
                onUploadMusic={uploadMusic}
                onOpen={(m) => setMenu(m)}
              />
            </div>
          ) : null}
        </div>
      </header>
      {exporting ? (
        <div className="bar mo-top-bar" aria-hidden="true">
          <div className="bar-fill" style={{ width: `${job?.percent ?? 0}%` }} />
        </div>
      ) : null}
      {error ? (
        <div className="banner banner-error mo-banner" role="alert">
          {error}{" "}
          <button type="button" className="linkish" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {view.script?.waiting && view.script.narrated && !running ? (
        <div className="banner banner-warn mo-banner mo-words-banner" role="status">
          <span>
            Your turn: Claude's draft is ready for your own words
            {waitingSlots ? ` (${waitingSlots} place${waitingSlots === 1 ? "" : "s"} for your story, opinions and numbers)` : ""}. Claude builds the scenes once you
            approve it.
          </span>
          <button type="button" className="btn btn-small" onClick={() => (setScriptTab("words"), setScriptOpen(true))}>
            Open Your words
          </button>
        </div>
      ) : null}
      {health && engine === "api" && !health.claude.ready ? (
        <div className="banner banner-warn mo-banner">
          No Claude API key found. Put <code>ANTHROPIC_API_KEY=...</code> in <code>backend\.env</code> (or set it in your environment) and restart the app.
        </div>
      ) : null}

      <div className="mo-body">
        <section className="mo-left">
          <Chat
            projectId={projectId}
            log={log}
            running={running}
            assets={assets}
            initialDraft={draft}
            onSend={send}
            onStop={() => void motionApi.stop(projectId)}
            onCommand={(c) => void command(c)}
            onAssetsChanged={() => void refreshAssets()}
            blocked={null}
            unwritten={unwritten}
            written={buildable.length - unwritten}
          />
        </section>
        <section className="mo-right">
          <Preview
            bundle={bundle}
            selectedScene={selected}
            onSelectScene={setSelected}
            commentDisabled={running}
            onComment={(target, text) => void act(() => send({ text, attachments: [], comment: target }))}
          />
          {scene ? (
            <PropsPanel
              key={scene.id}
              projectId={projectId}
              scene={scene}
              index={sceneIndex}
              count={bundle.scenes.length}
              onStep={stepScene}
              assets={assets}
              transitions={health?.transitions ?? ["cut", "fade", "slide-up", "slide-left", "zoom", "wipe"]}
              disabled={running}
              paper={bundle.theme === "paper"}
              onSaved={applyView}
            />
          ) : null}
        </section>
      </div>

      {detailsOpen ? (
        <DetailsModal
          projectId={projectId}
          title={view.project.title}
          version={view.project.version}
          onAsk={(text) => send({ text, attachments: [] })}
          onChanged={refreshView}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
      {scriptOpen ? (
        <ScriptModal
          projectId={projectId}
          view={view}
          running={running}
          initialTab={scriptTab}
          onSaved={applyView}
          onBuild={() => void act(() => send({ text: BUILD_TEXT, attachments: [] }))}
          onClose={() => (setScriptOpen(false), setScriptTab(undefined))}
        />
      ) : null}
      {kitEditor ? (
        <BrandKitEditor
          kit={kitEditor.kit}
          copyFrom={kitEditor.copyFrom}
          onClose={() => setKitEditor(null)}
          onSaved={(k) => {
            setKitEditor(null);
            void refreshKits();
            if (!kitEditor.kit) void patch({ brandKitId: k.id });
            else refreshView();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The export menu. The sound is spelled out because "Soundtrack" read as "pick the voice here": the
 * narration (the generated voice) and the paper sounds are mixed in on their own, and the music bed is
 * a separate, optional file the user uploads (Motion has no built-in music). Even loudness (on by
 * default) brings the whole mix to -14 LUFS, the level YouTube plays at, so a video isn't turned down
 * or sounds quiet next to others. A finished export links its caption files next to the MP4.
 */
function ExportPanel({
  job,
  view,
  audioAssets,
  exporting,
  voiceName,
  onStart,
  onCancel,
  onAudio,
  onUploadMusic,
  onOpen,
}: {
  job: ExportJob | null;
  view: ProjectView;
  audioAssets: Asset[];
  exporting: boolean;
  voiceName: string | null;
  onStart: (res: number, opts: { narration: boolean; sfx: boolean; loudness: boolean }) => void;
  onCancel: () => void;
  onAudio: (name: string) => void;
  onUploadMusic: (file: File) => Promise<void>;
  onOpen: (menu: "voice" | "video") => void;
}) {
  const res = 2160; // every export is 4K
  const [withVoice, setWithVoice] = useState(true);
  const [withSfx, setWithSfx] = useState(true);
  const [evenLoudness, setEvenLoudness] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const b = view.bundle;
  const unfinished = b.scenes.filter((s) => isBuildable(s) && !s.source).length;
  const narrated = b.scenes.filter((s) => s.narration && s.kind !== "endscreen");
  const voiced = narrated.filter((s) => s.voiced).length;
  const paper = b.theme === "paper";
  const minutes = Math.round(b.duration / 60);
  // a first 4K export takes about twice the video's length on this laptop (measured 2026-11-18 with the GPU
  // encoder: 19.5 min of video about 35 min); unchanged scenes are reused after that
  const estimate = Math.max(1, Math.round((b.duration * 2) / 60));

  return (
    <>
      {exporting && job ? (
        <div className="mo-export-run">
          <div className="status-line">
            <span className="spinner" aria-hidden="true" /> {job.message}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${job.percent}%` }} />
          </div>
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Cancel export
          </button>
        </div>
      ) : (
        <>
          <div className="mo-field">
            <span className="label">Resolution</span>
            <p className="muted small">
              4K ({b.width >= b.height ? "3840 x 2160" : "2160 x 3840"}), the size every video is made in. Scenes that haven't changed since the last export are
              reused.
            </p>
          </div>
          <div className="mo-field">
            <span className="label">Sound</span>
            {narrated.length ? (
              <label className="mo-check-row">
                <input type="checkbox" checked={withVoice} onChange={(e) => setWithVoice(e.target.checked)} />
                <span>
                  <span className="mo-check-title">Narration{voiceName ? ` (${voiceName})` : ""}</span>
                  {voiced === narrated.length ? (
                    <span className="muted small">
                      Included: {voiced} of {narrated.length} scenes voiced.
                    </span>
                  ) : (
                    <span className="mo-warn-text small">
                      {voiced} of {narrated.length} scenes voiced; the rest would be silent.{" "}
                      <button type="button" className="linkish" onClick={() => onOpen("voice")}>
                        Open Voice
                      </button>
                    </span>
                  )}
                </span>
              </label>
            ) : (
              <p className="muted small">No narration in this video.</p>
            )}
            {paper ? (
              <label className="mo-check-row">
                <input type="checkbox" checked={withSfx} onChange={(e) => setWithSfx(e.target.checked)} />
                <span>
                  <span className="mo-check-title">Paper sounds</span>
                  <span className="muted small">Rips, page turns, pops, stamps and pencil.</span>
                </span>
              </label>
            ) : null}
            <label className="mo-check-row">
              <input type="checkbox" checked={evenLoudness} onChange={(e) => setEvenLoudness(e.target.checked)} />
              <span>
                <span className="mo-check-title">Even loudness</span>
                <span className="muted small">-14 LUFS, YouTube's level.</span>
              </span>
            </label>
          </div>
          <div className="mo-field">
            <label className="label" htmlFor="mo-music">
              Music under the voice (optional)
            </label>
            <div className="mo-music-row">
              <select id="mo-music" value={view.project.audio ?? ""} onChange={(e) => onAudio(e.target.value)}>
                <option value="">No music</option>
                {audioAssets.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-small" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <span className="spinner" /> : "Upload…"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  setUploading(true);
                  void onUploadMusic(f).finally(() => setUploading(false));
                }}
              />
            </div>
            <span className="muted small">Motion has no built-in music. Upload an MP3 or WAV you have the rights to; it plays quietly under the voice.</span>
          </div>
          <p className="mo-closing-line small">
            {closingSummary(view)}{" "}
            <button type="button" className="linkish" onClick={() => onOpen("video")}>
              Change
            </button>
          </p>
          {unfinished ? (
            <p className="error small">
              {unfinished} scene{unfinished > 1 ? "s are" : " is"} not written yet.
            </p>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={!!unfinished || !b.scenes.length} onClick={() => onStart(res, { narration: withVoice, sfx: withSfx, loudness: evenLoudness })}>
            Export MP4
          </button>
          <p className="muted small">
            H.264 at 30 fps, {clock(b.duration)} long. Unchanged scenes are reused from the last export, so re-exports after small edits are quick.
            {b.duration > 300 ? ` ${articleFor(minutes) === "an" ? "An" : "A"} ${minutes} minute video takes a while the first time (about ${estimate} min at this resolution).` : ""}
          </p>
        </>
      )}
      {job?.state === "done" && job.result ? (
        <div className="mo-export-done">
          <div className="mo-export-links">
            {/* ?download=1 marks the video downloaded (Details shows it, the library tags it) */}
            <a className="btn btn-primary btn-small" href={motionApi.downloadMp4Url(job.result.url)} download>
              Download MP4
            </a>
            {/* the captions written with this export (older exports, and older servers, have none) */}
            {job.result.captions?.srt || job.result.captions?.vtt ? (
              <>
                <span className="muted small">Captions</span>
                {job.result.captions.srt ? (
                  <a className="btn btn-small" href={job.result.captions.srt} download title="The captions as SRT">
                    SRT
                  </a>
                ) : null}
                {job.result.captions.vtt ? (
                  <a className="btn btn-small" href={job.result.captions.vtt} download title="The captions as WebVTT">
                    VTT
                  </a>
                ) : null}
              </>
            ) : null}
          </div>
          <span className="muted small">
            {job.result.width}x{job.result.height}, {job.result.seconds} s, {bytesLabel(job.result.bytes)}, made in {job.result.took} s ({job.result.renderedScenes} rendered,{" "}
            {job.result.cachedScenes} reused)
          </span>
        </div>
      ) : null}
      {job?.state === "error" ? <p className="error small">{job.message}</p> : null}
      {view.renders.length ? (
        <div className="mo-renders">
          <span className="label">Earlier exports</span>
          {view.renders.map((r) => (
            <a key={r.file} href={motionApi.downloadMp4Url(r.url)} download>
              {r.file} <span className="muted">({bytesLabel(r.bytes)}, {ago(r.at)})</span>
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}
