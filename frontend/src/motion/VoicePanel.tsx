// The Voice menu: which scenes have their narration audio, Generate voice (the only way audio is made:
// the user presses it, Claude can't), its progress, and the pronunciation table (short form -> how the
// voice says it), which only changes what is sent to the voice, never the captions.

import { useEffect, useState } from "react";

import { motionApi } from "./api";
import type { Pronunciation, VoiceJob, VoiceStatus } from "./types";

type Props = { projectId: string; job: VoiceJob | null; disabled: boolean; version: number; onError: (msg: string) => void };

const STATE_LABEL: Record<string, string> = { voiced: "voiced", ready: "ready (no cost)", changed: "words changed", none: "no voice yet" };

export default function VoicePanel({ projectId, job, disabled, version, onError }: Props) {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [rows, setRows] = useState<Pronunciation[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    motionApi
      .voiceStatus(projectId)
      .then((s) => {
        setStatus(s);
        if (!dirty) setRows(s.pronunciations);
      })
      .catch((err) => onError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, version, job?.state, job?.done]);

  const running = job?.state === "queued" || job?.state === "running";
  const todo = status ? status.scenes.filter((s) => s.state !== "voiced") : [];

  async function generate() {
    setBusy(true);
    try {
      await motionApi.generateVoice(projectId);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function savePronunciations() {
    setBusy(true);
    try {
      const s = await motionApi.setPronunciations(projectId, rows.filter((r) => r.written.trim()));
      setStatus(s);
      setRows(s.pronunciations);
      setDirty(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <span className="spinner" />;
  return (
    <div className="mo-voice">
      <div className="mo-voice-head">
        <strong>
          {status.voice.name} · {status.voice.model.replace("eleven_", "Eleven ")}
        </strong>
        <span className="muted small">
          {status.voiced} of {status.total} narrated scenes voiced
        </span>
      </div>
      {!status.keySet && todo.some((s) => s.state !== "ready") ? (
        <p className="error small">
          No ElevenLabs key yet: put <code>ELEVENLABS_API_KEY=...</code> in <code>backend\.env</code>, then restart the app.
        </p>
      ) : null}
      {running && job ? (
        <div className="mo-export-run">
          <div className="status-line">
            <span className="spinner" aria-hidden="true" /> {job.message}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
          </div>
          <button type="button" className="btn btn-small" onClick={() => void motionApi.cancelVoice(projectId)}>
            Stop after this scene
          </button>
        </div>
      ) : (
        <>
          <button type="button" className="btn btn-primary" disabled={disabled || busy || todo.length === 0} onClick={() => void generate()}>
            {todo.length ? `Generate voice for ${todo.length} scene${todo.length > 1 ? "s" : ""}` : "Every scene is voiced"}
          </button>
          {todo.length ? (
            <p className="muted small">
              About {status.charsNeeded.toLocaleString()} characters go to ElevenLabs. Scenes whose words haven't changed reuse their audio for free. After the voice exists every cue
              moves to its spoken word, so the scenes re-time by themselves.
            </p>
          ) : null}
        </>
      )}
      {job?.state === "error" ? <p className="error small">{job.message}</p> : null}
      {job?.state === "done" ? <p className="muted small">{job.message}</p> : null}
      {todo.length ? (
        <details className="mo-voice-list">
          <summary className="small">Scenes without their voice ({todo.length})</summary>
          <ul>
            {todo.map((s) => (
              <li key={s.id} className="small">
                {s.name} <span className="muted">· {s.words} words · {STATE_LABEL[s.state]}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mo-pron">
        <div className="label">How the voice says short forms</div>
        <p className="muted small">The narration and captions keep the written form; only what the voice is sent changes. Scenes that use a changed entry need their voice again.</p>
        <div className="mo-pron-rows">
          {rows.map((r, i) => (
            <div key={i} className="mo-pron-row">
              <input
                type="text"
                value={r.written}
                placeholder="LLM"
                aria-label="Written"
                onChange={(e) => {
                  setRows(rows.map((x, j) => (j === i ? { ...x, written: e.target.value } : x)));
                  setDirty(true);
                }}
              />
              <span aria-hidden="true">→</span>
              <input
                type="text"
                value={r.spoken}
                placeholder="L-L-M"
                aria-label="Spoken"
                onChange={(e) => {
                  setRows(rows.map((x, j) => (j === i ? { ...x, spoken: e.target.value } : x)));
                  setDirty(true);
                }}
              />
              <button
                type="button"
                aria-label={`Remove ${r.written}`}
                onClick={() => {
                  setRows(rows.filter((_, j) => j !== i));
                  setDirty(true);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="mo-pron-actions">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setRows([...rows, { written: "", spoken: "" }]);
              setDirty(true);
            }}
          >
            Add
          </button>
          <button type="button" className="btn btn-primary btn-small" disabled={!dirty || busy || disabled} onClick={() => void savePronunciations()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
