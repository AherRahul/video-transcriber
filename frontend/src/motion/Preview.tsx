// The live preview: the player page in a sandboxed iframe (Claude's scene code can't reach the app),
// with play/pause, a scrubber, the scene strip, safe-area guides and click-to-comment.
//
// The editor owns the clock: while playing it sends `seek(t)` to the player every animation frame, and
// with a soundtrack the audio element is the clock.
//
// The scene strip scrolls sideways: every scene keeps a readable chip (number, name, length, voice
// state), grouped under its part, and the playing scene stays in view.
//
// Keys (when not typing): Space play/pause, Left/Right a frame (Shift: a second), Up/Down the scene
// before/after, Home/End the start/end, Escape leaves comment mode.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { clockTenths, lengthLabel } from "./api";
import type { Bundle, BundleScene, CommentTarget, FromPlayer, ToPlayer } from "./types";

type Props = {
  bundle: Bundle;
  selectedScene: string | null;
  onSelectScene: (id: string) => void;
  onComment: (target: CommentTarget, text: string) => void;
  commentDisabled: boolean;
};

type Pick = { sceneId: string; elementId: string | null; label: string; x: number; y: number; at: number };

// how loud each paper sound plays in the preview (the export mixes them the same way)
const SFX_GAIN: Record<string, number> = { rip: 0.55, page: 0.5, stamp: 0.6, crumple: 0.5, pop: 0.35, pencil: 0.22, whoosh: 0.35, ding: 0.4, thump: 0.45, type: 0.25, sting: 0.45, slap: 0.45, popper: 0.4 };

/** A run of scenes that share a part (the promo and the end screen are their own groups). */
type Group = { key: string; title: string; kind: BundleScene["kind"]; start: number; scenes: { s: BundleScene; i: number }[] };

function groupTitle(s: BundleScene): string {
  if (s.kind === "promo") return "AlgoInsight promo";
  if (s.kind === "endscreen") return "End screen";
  return s.part || "";
}

/** The voice state a chip's dot shows. */
function voiceState(s: BundleScene): { cls: string; label: string } {
  if (s.kind === "endscreen" || !s.narration) return { cls: "silent", label: "silent" };
  if (s.voiced) return { cls: "voiced", label: "voiced" };
  if (s.stale) return { cls: "changed", label: "words changed: voice again" };
  return { cls: "none", label: "no voice yet" };
}

/** Where a scene's chip click lands: just after its first cue, so the page has finished changing (page
 * changes take 0.65 s) and its first content is on screen; never past the middle of a short scene. */
const landing = (s: BundleScene) => {
  const first = s.cues?.[1] ?? s.lead ?? 0.6;
  return s.start + Math.min(s.duration / 2, Math.max(1, first + 0.5));
};

export default function Preview({ bundle, selectedScene, onSelectScene, onComment, commentDisabled }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null); // the clock when there is sound: the narration, else the music
  const musicRef = useRef<HTMLAudioElement>(null); // music under the narration
  const sfxRef = useRef<{ t: number; name: string; gain: number }[]>([]);
  const sfxPool = useRef<Record<string, HTMLAudioElement>>({});
  const [muted, setMuted] = useState(false);
  const readyRef = useRef(false);
  const openedRef = useRef(false);
  const bundleRef = useRef(bundle);
  const tRef = useRef(0);
  const playingRef = useRef(false);
  const startRef = useRef(0);
  const rafRef = useRef(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [guides, setGuides] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pick, setPick] = useState<Pick | null>(null);
  const [note, setNote] = useState("");
  const [size, setSize] = useState({ w: 0, h: 0 });
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const duration = bundle.duration;
  bundleRef.current = bundle;
  const selectRef = useRef(onSelectScene);
  selectRef.current = onSelectScene;
  const chipsRef = useRef<HTMLDivElement>(null);

  const post = useCallback((msg: ToPlayer) => frameRef.current?.contentWindow?.postMessage(msg, "*"), []);

  const seek = useCallback(
    (time: number, fromAudio = false) => {
      const d = bundleRef.current.duration;
      const clamped = Math.max(0, Math.min(time, d));
      tRef.current = clamped;
      post({ type: "seek", t: clamped });
      setT(clamped);
      const a = audioRef.current;
      if (a && !fromAudio && Math.abs(a.currentTime - clamped) > 0.05) a.currentTime = clamped;
      const m = musicRef.current;
      if (m && Math.abs(m.currentTime - clamped) > 0.3) m.currentTime = clamped;
    },
    [post],
  );

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    musicRef.current?.pause();
  }, []);

  const play = useCallback(() => {
    const d = bundleRef.current.duration;
    if (d <= 0) return;
    if (tRef.current >= d - 0.01) seek(0);
    playingRef.current = true;
    setPlaying(true);
    setPick(null);
    startRef.current = performance.now() - tRef.current * 1000;
    const a = audioRef.current;
    if (a) {
      a.currentTime = tRef.current;
      a.play().catch(() => null);
    }
    const m = musicRef.current;
    if (m) {
      m.currentTime = tRef.current;
      m.volume = 0.15;
      m.play().catch(() => null);
    }
    let last = tRef.current;
    const loop = () => {
      if (!playingRef.current) return;
      const audio = audioRef.current;
      const now = audio && !audio.paused && audio.currentTime < (audio.duration || Infinity) ? audio.currentTime : (performance.now() - startRef.current) / 1000;
      if (now >= bundleRef.current.duration) {
        seek(bundleRef.current.duration, true);
        pause();
        return;
      }
      // the paper sounds whose moment the playhead just passed
      if (!mutedRef.current && now > last && now - last < 0.5) {
        for (const e of sfxRef.current) {
          if (e.t > last && e.t <= now) {
            const base = sfxPool.current[e.name] ?? (sfxPool.current[e.name] = new Audio(`${bundleRef.current.themeBase}sfx/${e.name}.mp3`));
            const one = base.cloneNode(true) as HTMLAudioElement;
            one.volume = Math.min(1, (SFX_GAIN[e.name] ?? 0.4) * e.gain);
            one.play().catch(() => null);
          }
        }
      }
      last = now;
      seek(now, true);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [pause, seek]);

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play]);

  const step = useCallback(
    (key: string, shift = false) => {
      const frame = 1 / (bundleRef.current.fps || 30);
      if (key === " ") {
        toggle();
        return;
      }
      let to: number | null = null;
      if (key === "ArrowLeft" || key === ",") to = tRef.current - (shift ? 1 : frame);
      else if (key === "ArrowRight" || key === ".") to = tRef.current + (shift ? 1 : frame);
      else if (key === "Home") to = 0;
      else if (key === "End") to = bundleRef.current.duration;
      else if (key === "ArrowUp" || key === "ArrowDown") {
        // the scene before or after the one under the playhead
        const scenes = bundleRef.current.scenes;
        const at = scenes.findIndex((s) => tRef.current < s.start + s.duration - 1e-3);
        const here = at < 0 ? scenes.length - 1 : at;
        const target = scenes[here + (key === "ArrowUp" ? -1 : 1)];
        if (target) {
          pause();
          seek(landing(target));
          selectRef.current(target.id);
        }
        return;
      }
      if (to !== null) {
        pause();
        seek(to);
      }
    },
    [pause, seek, toggle],
  );

  // messages from the player
  useEffect(() => {
    const onMessage = (e: MessageEvent<FromPlayer>) => {
      if (e.source !== frameRef.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const msg = e.data;
      if (msg.type === "ready") {
        readyRef.current = true;
        post({ type: "load", bundle: bundleRef.current });
      } else if (msg.type === "loaded") {
        setErrors(msg.errors);
        const starts = new Map(bundleRef.current.scenes.map((s) => [s.id, s.start]));
        sfxRef.current = (msg.sfx || []).filter((e) => starts.has(e.sceneId)).map((e) => ({ t: starts.get(e.sceneId)! + e.t, name: e.name, gain: e.gain })).sort((x, y) => x.t - y.t);
        // frame 0 is usually empty (the first scene fades in), so open on a moment that shows it
        const first = bundleRef.current.scenes.find((s) => s.source);
        if (!openedRef.current && first && tRef.current === 0 && !playingRef.current) {
          openedRef.current = true;
          seek(first.start + Math.min(1.5, first.duration * 0.6));
        } else post({ type: "seek", t: tRef.current });
      } else if (msg.type === "pick") {
        const b = bundleRef.current;
        const scene = b.scenes.find((s) => s.id === msg.sceneId);
        pause();
        setPick({ ...msg, at: Math.max(0, tRef.current - (scene?.start ?? 0)) });
        setNote("");
        post({ type: "highlight", sceneId: msg.sceneId, elementId: msg.elementId });
      } else if (msg.type === "key") {
        step(msg.key);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pause, post, seek, step]);

  // a new version of the video: reload the player, keep the playhead
  useEffect(() => {
    if (readyRef.current) post({ type: "load", bundle });
    if (tRef.current > bundle.duration) seek(bundle.duration);
  }, [bundle, post, seek]);

  useEffect(() => post({ type: "comment", on: commentMode }), [commentMode, post]);
  useEffect(() => post({ type: "guides", on: guides }), [guides, post]);
  useEffect(() => {
    if (commentDisabled) setCommentMode(false);
  }, [commentDisabled]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // keyboard: space, arrows, Home/End when not typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if ([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        step(e.key, e.shiftKey);
      } else if (e.key === "Escape") {
        setPick(null);
        setCommentMode(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  // fit the frame into the space available, keeping the video's aspect ratio
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const fit = () => {
      const maxW = wrap.clientWidth;
      const maxH = Math.max(260, window.innerHeight - 330);
      let w = maxW;
      let h = (w * bundle.height) / bundle.width;
      if (h > maxH) {
        h = maxH;
        w = (h * bundle.width) / bundle.height;
      }
      setSize({ w: Math.floor(w), h: Math.floor(h) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [bundle.width, bundle.height]);

  // scrubbing on the thin bar
  const barRef = useRef<HTMLDivElement>(null);
  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    const bar = barRef.current;
    if (!bar || duration <= 0) return;
    pause();
    setPick(null);
    const at = (clientX: number) => {
      const r = bar.getBoundingClientRect();
      return ((clientX - r.left) / r.width) * duration;
    };
    seek(at(e.clientX));
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => seek(at(ev.clientX));
    const up = (ev: PointerEvent) => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      const time = at(ev.clientX);
      const s = bundleRef.current.scenes.find((x) => time < x.start + x.duration) ?? bundleRef.current.scenes.at(-1);
      if (s) onSelectScene(s.id);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  };

  const sendComment = () => {
    if (!pick || !note.trim()) return;
    onComment({ sceneId: pick.sceneId, elementId: pick.elementId, at: Math.round(pick.at * 100) / 100, label: pick.label }, note.trim());
    setPick(null);
    setNote("");
    setCommentMode(false);
    post({ type: "highlight", sceneId: "", elementId: null });
  };

  const current = bundle.scenes.find((s) => t < s.start + s.duration) ?? bundle.scenes.at(-1);
  const currentId = current?.id;

  // the scene strip, grouped by part
  const groups = useMemo(() => {
    const out: Group[] = [];
    bundle.scenes.forEach((s, i) => {
      const title = groupTitle(s);
      const last = out.at(-1);
      if (last && last.title === title && last.kind === s.kind) last.scenes.push({ s, i });
      else out.push({ key: `${i}-${s.id}`, title, kind: s.kind, start: s.start, scenes: [{ s, i }] });
    });
    return out;
  }, [bundle.scenes]);

  // a scene chosen elsewhere (the properties panel's arrows): show it, unless the playhead is already in it
  useEffect(() => {
    if (!selectedScene || playingRef.current || !openedRef.current) return;
    const s = bundleRef.current.scenes.find((x) => x.id === selectedScene);
    if (s && !(tRef.current >= s.start && tRef.current < s.start + s.duration)) seek(landing(s));
  }, [selectedScene, seek]);

  // keep the playing (or selected) scene's chip in view
  useEffect(() => {
    const strip = chipsRef.current;
    const id = playing ? currentId : (selectedScene ?? currentId);
    if (!strip || !id) return;
    const el = strip.querySelector<HTMLElement>(`[data-scene="${CSS.escape(id)}"]`);
    if (!el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft + 8 || right > strip.scrollLeft + strip.clientWidth - 8) {
      strip.scrollTo({ left: Math.max(0, left - strip.clientWidth * 0.3), behavior: "smooth" });
    }
  }, [currentId, selectedScene, playing]);

  // a mouse wheel over the strip scrolls it sideways (until it reaches an end)
  useEffect(() => {
    const strip = chipsRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
      const atStart = strip.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1 && e.deltaY > 0;
      if (atStart || atEnd) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  const clockSrc = bundle.narration?.url ?? bundle.audio;
  const musicSrc = bundle.narration && bundle.audio ? bundle.audio : null;
  const pickScene = pick ? bundle.scenes.find((s) => s.id === pick.sceneId) : null;

  return (
    <div className="mo-preview">
      <div className="mo-frame-wrap" ref={wrapRef}>
        <div className="mo-frame" style={{ width: size.w, height: size.h }}>
          <iframe
            ref={frameRef}
            title="Video preview"
            src="/motion-player.html?mode=preview"
            sandbox="allow-scripts"
          />
          {bundle.scenes.length === 0 ? (
            <div className="mo-frame-empty">
              <strong>Your video appears here</strong>
              <span>Describe it in the chat. Scenes show up as soon as Claude plans them.</span>
            </div>
          ) : null}
          {errors.length ? (
            <div className="mo-frame-errors" title={errors.join("\n")}>
              {errors.length} scene error{errors.length > 1 ? "s" : ""}
            </div>
          ) : null}
          {pick ? (
            <div
              className="mo-pin-pop"
              style={{ left: Math.min(Math.max(8, pick.x - 140), size.w - 288), top: Math.min(pick.y + 14, size.h - 150) }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className="mo-pin-title">
                {pick.elementId ? <code>{pick.elementId}</code> : "This spot"} in {pickScene?.name ?? pick.sceneId} at {clockTenths(pick.at)}
              </div>
              <textarea
                autoFocus
                rows={2}
                placeholder="What should change here?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendComment();
                  } else if (e.key === "Escape") setPick(null);
                }}
              />
              <div className="mo-pin-actions">
                <button type="button" className="btn btn-small" onClick={() => setPick(null)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-small" disabled={!note.trim()} onClick={sendComment}>
                  Send to Claude
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mo-transport">
        <button type="button" className="btn mo-play" onClick={toggle} disabled={duration <= 0} aria-label={playing ? "Pause" : "Play"} title="Play / pause (Space)">
          {playing ? (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <span className="mo-time">
          {clockTenths(t)} / {clockTenths(duration)}
        </span>
        <span className="mo-scene-now muted">{current ? current.name : ""}</span>
        <span className="mo-spacer" />
        <button
          type="button"
          className={`btn btn-small ${commentMode ? "btn-on" : ""}`}
          onClick={() => {
            pause();
            setPick(null);
            setCommentMode((v) => !v);
          }}
          disabled={commentDisabled || bundle.scenes.length === 0}
          title={commentDisabled ? "Claude is working; comment when it finishes" : "Click an element in the preview to comment on it"}
        >
          {commentMode ? "Click an element…" : "Comment"}
        </button>
        <button type="button" className={`btn btn-small ${guides ? "btn-on" : ""}`} onClick={() => setGuides((v) => !v)} title="Show the safe area">
          Guides
        </button>
        <button
          type="button"
          className={`btn btn-small ${muted ? "btn-on" : ""}`}
          onClick={() => setMuted((v) => !v)}
          title={bundle.narration ? "Mute the narration and sounds in the preview" : "Mute the sounds in the preview"}
        >
          {muted ? "Muted" : "Sound"}
        </button>
      </div>

      <div className="mo-timeline">
        <div className="mo-scrub" ref={barRef} onPointerDown={scrub} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={t}>
          <div className="mo-scrub-fill" style={{ width: `${duration ? (t / duration) * 100 : 0}%` }} />
          {/* where each part starts */}
          {duration
            ? groups.slice(1).map((g) => <span key={g.key} className="mo-scrub-tick" style={{ left: `${(g.start / duration) * 100}%` }} title={g.title || undefined} />)
            : null}
          <span className="mo-scrub-knob" style={{ left: `${duration ? (t / duration) * 100 : 0}%` }} aria-hidden="true" />
        </div>
        <div className="mo-chips" ref={chipsRef}>
          {groups.map((g) => (
            <div key={g.key} className={`mo-group kind-${g.kind}`}>
              <div className="mo-group-title" title={g.title || undefined}>
                {g.title || " "}
              </div>
              <div className="mo-group-chips">
                {g.scenes.map(({ s, i }) => {
                  const v = voiceState(s);
                  const isCurrent = s.id === currentId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      data-scene={s.id}
                      aria-current={isCurrent ? "true" : undefined}
                      className={`mo-chip kind-${s.kind} ${s.id === selectedScene ? "selected" : ""} ${isCurrent ? "current" : ""} ${s.status === "planned" ? "planned" : ""}`}
                      onClick={() => {
                        pause();
                        seek(landing(s));
                        onSelectScene(s.id);
                      }}
                      title={`${i + 1}. ${s.name} · ${lengthLabel(s.duration)} · ${s.transition} · ${v.label}${s.status === "planned" ? " · not written yet" : ""}`}
                    >
                      <span className="mo-chip-top">
                        <span className="mo-chip-num">{i + 1}</span>
                        <span className="mo-chip-name">{s.name}</span>
                      </span>
                      <span className="mo-chip-meta">
                        <i className={`mo-vdot ${v.cls}`} aria-hidden="true" />
                        {lengthLabel(s.duration)}
                        {s.status === "planned" ? " · to write" : ""}
                      </span>
                      {isCurrent && s.duration > 0 ? (
                        <span className="mo-chip-progress" style={{ width: `${Math.min(100, Math.max(0, ((t - s.start) / s.duration) * 100))}%` }} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {bundle.scenes.length ? (
          <div className="mo-timeline-foot muted">
            <span>
              <i className="mo-vdot voiced" aria-hidden="true" /> voiced <i className="mo-vdot changed" aria-hidden="true" /> words changed <i className="mo-vdot none" aria-hidden="true" /> no voice
            </span>
            <span>Space play · ←/→ frame (Shift 1 s) · ↑/↓ scene</span>
          </div>
        ) : null}
      </div>
      {clockSrc ? <audio ref={audioRef} src={clockSrc} preload="auto" muted={muted} /> : null}
      {musicSrc ? <audio ref={musicRef} src={musicSrc} preload="auto" muted={muted} /> : null}
    </div>
  );
}
