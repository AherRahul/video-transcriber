// Direct editing of the selected scene without asking Claude: its name, length and transition, the
// props Claude declared as levers (text, colours, numbers, images...), and the scene's code itself.
// Changes save on their own after a short pause; a change made while the scene changed elsewhere
// (Claude, Undo) is refused by the server, and the panel shows the new state.

import { useEffect, useMemo, useRef, useState } from "react";

import { motionApi } from "./api";
import type { Asset, BundleScene, Lever, ProjectView, PropValue } from "./types";

type Props = {
  projectId: string;
  scene: BundleScene;
  index: number;
  /** how many scenes the video has, and a step to the scene before (-1) or after (+1) */
  count: number;
  onStep: (delta: number) => void;
  assets: Asset[];
  transitions: string[];
  disabled: boolean;
  paper: boolean;
  onSaved: (view: ProjectView) => void;
};

function inferLever(key: string, value: PropValue): Lever {
  if (typeof value === "number") return { key, label: key, type: "number" };
  if (typeof value === "boolean") return { key, label: key, type: "toggle" };
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return { key, label: key, type: "color" };
  if (typeof value === "string" && value.startsWith("asset://")) return { key, label: key, type: "image" };
  if (typeof value === "string" && value.length > 60) return { key, label: key, type: "textarea" };
  return { key, label: key, type: "text" };
}

export default function PropsPanel({ projectId, scene, index, count, onStep, assets, transitions, disabled, paper, onSaved }: Props) {
  const [tab, setTab] = useState<"props" | "code">("props");
  const [props, setProps] = useState<Record<string, PropValue>>(scene.props);
  const [meta, setMeta] = useState({ name: scene.name, duration: String(scene.duration), transition: scene.transition as string });
  const [text, setText] = useState({ narration: scene.narration || "", label: scene.label || "", part: scene.part || "", hold: String(scene.hold || 0) });
  const [code, setCode] = useState(scene.source ?? "");
  const [status, setStatus] = useState<"" | "saving" | "saved">("");
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Record<string, unknown>>({});
  const codeDirty = code !== (scene.source ?? "");

  // the scene changed on the server (Claude, Undo, another save): show it unless the user is mid-edit
  useEffect(() => {
    if (dirty.current) return;
    setProps(scene.props);
    setMeta({ name: scene.name, duration: String(scene.duration), transition: scene.transition });
    setText({ narration: scene.narration || "", label: scene.label || "", part: scene.part || "", hold: String(scene.hold || 0) });
  }, [scene.id, scene.rev, scene.props, scene.name, scene.duration, scene.transition, scene.narration, scene.label, scene.part, scene.hold]);
  useEffect(() => {
    setCode(scene.source ?? "");
  }, [scene.id, scene.rev, scene.source]);
  useEffect(() => {
    dirty.current = false;
    setError(null);
    setStatus("");
  }, [scene.id]);

  const levers = useMemo(() => {
    const declared = scene.levers ?? [];
    const keys = new Set(declared.map((l) => l.key));
    const rest = Object.entries(scene.props)
      .filter(([k]) => !keys.has(k))
      .map(([k, v]) => inferLever(k, v));
    return { declared, rest };
  }, [scene.levers, scene.props]);

  async function save(fields: Record<string, unknown>) {
    setStatus("saving");
    setError(null);
    try {
      const view = await motionApi.editScene(projectId, scene.id, { ...fields, baseRev: scene.rev });
      dirty.current = false;
      onSaved(view);
      setStatus("saved");
    } catch (err) {
      dirty.current = false;
      setStatus("");
      setError(err instanceof Error ? err.message : String(err));
      // reload so the panel shows what is really there now
      motionApi.getProject(projectId).then(onSaved).catch(() => null);
    }
  }

  /** Collects quick edits (several fields typed in a row) into one save after a short pause. */
  function schedule(fields: Record<string, unknown>) {
    dirty.current = true;
    pending.current = { ...pending.current, ...fields };
    setStatus("");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const all = pending.current;
      pending.current = {};
      void save(all);
    }, 600);
  }

  const setProp = (key: string, value: PropValue) => {
    const next = { ...props, [key]: value };
    setProps(next);
    schedule({ props: next });
  };

  const images = assets.filter((a) => a.kind === "image");

  const field = (lv: Lever) => {
    const value = props[lv.key];
    const id = `lever-${scene.id}-${lv.key}`;
    let input;
    switch (lv.type) {
      case "textarea":
        input = <textarea id={id} rows={3} value={String(value ?? "")} disabled={disabled} onChange={(e) => setProp(lv.key, e.target.value)} />;
        break;
      case "number":
        input = (
          <input
            id={id}
            type="number"
            value={value === null || value === undefined ? "" : String(value)}
            min={lv.min}
            max={lv.max}
            step={lv.step ?? "any"}
            disabled={disabled}
            onChange={(e) => setProp(lv.key, e.target.value === "" ? null : Number(e.target.value))}
          />
        );
        break;
      case "color":
        input = (
          <span className="mo-color">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : "#000000"} disabled={disabled} onChange={(e) => setProp(lv.key, e.target.value)} aria-label={lv.label} />
            <input id={id} type="text" value={String(value ?? "")} disabled={disabled} onChange={(e) => setProp(lv.key, e.target.value)} />
          </span>
        );
        break;
      case "toggle":
        input = <input id={id} type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => setProp(lv.key, e.target.checked)} />;
        break;
      case "select":
        input = (
          <select id={id} value={String(value ?? "")} disabled={disabled} onChange={(e) => setProp(lv.key, e.target.value)}>
            {(lv.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
        break;
      case "image":
        input = (
          <select id={id} value={String(value ?? "")} disabled={disabled} onChange={(e) => setProp(lv.key, e.target.value)}>
            <option value="">(none)</option>
            {String(value ?? "") && !images.some((a) => `asset://${a.name}` === value) ? <option value={String(value)}>{String(value)}</option> : null}
            {images.map((a) => (
              <option key={a.name} value={`asset://${a.name}`}>
                {a.name}
                {a.width ? ` (${a.width}x${a.height})` : ""}
              </option>
            ))}
          </select>
        );
        break;
      default:
        input = <input id={id} type="text" value={Array.isArray(value) ? value.join(", ") : String(value ?? "")} disabled={disabled || Array.isArray(value)} onChange={(e) => setProp(lv.key, e.target.value)} />;
    }
    return (
      <label key={lv.key} className={`mo-field ${lv.type === "toggle" ? "check" : ""}`} htmlFor={id}>
        <span className="label">{lv.label}</span>
        {input}
      </label>
    );
  };

  return (
    <div className="mo-props">
      <div className="mo-props-head">
        <div className="mo-step" role="group" aria-label="Scenes">
          <button type="button" className="btn btn-small" disabled={index <= 0} onClick={() => onStep(-1)} aria-label="Previous scene" title="Previous scene (Up arrow)">
            ‹
          </button>
          <button type="button" className="btn btn-small" disabled={index >= count - 1} onClick={() => onStep(1)} aria-label="Next scene" title="Next scene (Down arrow)">
            ›
          </button>
        </div>
        <h3 title={scene.name}>
          <span className="muted">
            Scene {index + 1} of {count}
            {scene.kind === "promo" ? " · promo" : scene.kind === "endscreen" ? " · end screen" : ""}:
          </span>{" "}
          {scene.name}
        </h3>
        <div className="mo-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "props"} className={tab === "props" ? "on" : ""} onClick={() => setTab("props")}>
            Properties
          </button>
          <button type="button" role="tab" aria-selected={tab === "code"} className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>
            Code
          </button>
        </div>
        <span className="muted small mo-save-state">{status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}</span>
      </div>
      {disabled ? <p className="muted small">Claude is editing; the fields unlock when it finishes.</p> : null}
      {error ? <p className="error small">{error}</p> : null}
      {scene.kind === "promo" ? (
        <p className="mo-props-note small">Part of the AlgoInsight promo, switched on in the video settings (For YouTube in the top bar). Changes here apply to this video only.</p>
      ) : scene.kind === "endscreen" ? (
        <p className="mo-props-note small">The end screen is drawn from the brand kit; switch it on or off in the video settings (For YouTube in the top bar).</p>
      ) : null}

      {tab === "props" ? (
        <div className="mo-props-grid">
          <label className="mo-field" htmlFor={`name-${scene.id}`}>
            <span className="label">Name</span>
            <input
              id={`name-${scene.id}`}
              type="text"
              value={meta.name}
              disabled={disabled}
              onChange={(e) => {
                setMeta({ ...meta, name: e.target.value });
                schedule({ name: e.target.value });
              }}
            />
          </label>
          {scene.kind !== "endscreen" ? (
            <label className="mo-field" htmlFor={`narr-${scene.id}`}>
              <span className="label">
                Narration{" "}
                <span className="muted">
                  · {scene.narration ? (scene.voiced ? "voiced" : scene.stale ? "words changed, voice again" : "no voice yet") : "silent scene"}
                </span>
              </span>
              <textarea
                id={`narr-${scene.id}`}
                rows={5}
                value={text.narration}
                disabled={disabled}
                placeholder="What the voice says. Put <cue/> where the picture should react."
                onChange={(e) => {
                  setText({ ...text, narration: e.target.value });
                  schedule({ narration: e.target.value });
                }}
              />
              {scene.narration ? (
                <span className="muted small">
                  Voice starts at {scene.lead.toFixed(2)} s, speaks {scene.speech.toFixed(1)} s{scene.voiced ? "" : " (estimated)"}; cues at{" "}
                  {scene.cues
                    .slice(1)
                    .map((c) => c.toFixed(1))
                    .join(", ") || "none"}{" "}
                  s.
                </span>
              ) : null}
            </label>
          ) : null}
          {paper && scene.kind !== "endscreen" ? (
            <div className="mo-field-row">
              <label className="mo-field" htmlFor={`label-${scene.id}`}>
                <span className="label">Torn label</span>
                <input
                  id={`label-${scene.id}`}
                  type="text"
                  value={text.label}
                  disabled={disabled}
                  maxLength={80}
                  onChange={(e) => {
                    setText({ ...text, label: e.target.value });
                    schedule({ label: e.target.value });
                  }}
                />
              </label>
              <label className="mo-field" htmlFor={`part-${scene.id}`}>
                <span className="label">Part</span>
                <input
                  id={`part-${scene.id}`}
                  type="text"
                  value={text.part}
                  disabled={disabled}
                  maxLength={60}
                  placeholder="Part 1 · The evening"
                  onChange={(e) => {
                    setText({ ...text, part: e.target.value });
                    schedule({ part: e.target.value });
                  }}
                />
              </label>
            </div>
          ) : null}
          <div className="mo-field-row">
            {scene.narration ? (
              <label className="mo-field" htmlFor={`hold-${scene.id}`}>
                <span className="label">Hold after the words (s) · length {scene.duration.toFixed(1)} s</span>
                <input
                  id={`hold-${scene.id}`}
                  type="number"
                  min={0}
                  max={30}
                  step={0.1}
                  value={text.hold}
                  disabled={disabled}
                  onChange={(e) => {
                    setText({ ...text, hold: e.target.value });
                    const n = Number(e.target.value);
                    if (n >= 0 && n <= 30) schedule({ hold: n });
                  }}
                />
              </label>
            ) : (
              <label className="mo-field" htmlFor={`dur-${scene.id}`}>
                <span className="label">Length (s)</span>
                <input
                  id={`dur-${scene.id}`}
                  type="number"
                  min={0.5}
                  max={60}
                  step={0.1}
                  value={meta.duration}
                  disabled={disabled}
                  onChange={(e) => {
                    setMeta({ ...meta, duration: e.target.value });
                    const n = Number(e.target.value);
                    if (n >= 0.5 && n <= 60) schedule({ duration: n });
                  }}
                />
              </label>
            )}
            <label className="mo-field" htmlFor={`tr-${scene.id}`}>
              <span className="label">Transition in</span>
              <select
                id={`tr-${scene.id}`}
                value={meta.transition}
                disabled={disabled}
                onChange={(e) => {
                  setMeta({ ...meta, transition: e.target.value });
                  void save({ transition: e.target.value });
                }}
              >
                {transitions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {scene.status === "planned" ? <p className="muted small">Claude hasn't written this scene yet.</p> : null}
          {levers.declared.map(field)}
          {levers.rest.length ? (
            <details className="mo-more" open={!levers.declared.length}>
              <summary>Other props</summary>
              {levers.rest.map(field)}
            </details>
          ) : null}
          {scene.idea ? <p className="muted small mo-idea">Idea: {scene.idea}</p> : null}
        </div>
      ) : (
        <div className="mo-code">
          <textarea value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} disabled={disabled || scene.source === null} aria-label="Scene code" />
          <div className="mo-code-actions">
            <span className="muted small">Saved as written. Claude sees your version next time.</span>
            <button type="button" className="btn btn-small" disabled={!codeDirty || disabled} onClick={() => setCode(scene.source ?? "")}>
              Revert
            </button>
            <button type="button" className="btn btn-primary btn-small" disabled={!codeDirty || disabled} onClick={() => void save({ source: code })}>
              Save code
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
