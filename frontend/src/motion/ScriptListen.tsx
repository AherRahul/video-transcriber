// Listen to the script: the Script dialog reads the narration aloud with the browser's own text-to-speech
// (freeVoice.ts), scene after scene, from any scene, at any speed, before any voice is made with ElevenLabs.
// Free: nothing is billed. Pause stops the speech and Resume starts again at the sentence it was on (the
// browsers' own pause and resume are unreliable). The speed and the voice are the preview's too.

import { useCallback, useEffect, useRef, useState } from "react";

import { loadSpeed, loadVoiceName, pickVoice, saveSpeed, saveVoiceName, sentences, Speaker, speakable, SPEEDS, supported, useVoices, voiceLabel } from "./freeVoice";
import type { BundleScene } from "./types";

type State = "idle" | "reading" | "paused";

export default function ScriptListen({ scenes }: { scenes: BundleScene[] }) {
  // the scenes that say something (the end screen is silent)
  const narrated = scenes.map((s, i) => ({ s, n: i + 1 })).filter(({ s }) => s.narration && s.kind !== "endscreen");
  const voices = useVoices();
  const [voiceName, setVoiceName] = useState(loadVoiceName);
  const voice = pickVoice(voices, voiceName);
  const [speed, setSpeed] = useState(loadSpeed);
  const [state, setState] = useState<State>("idle");
  const [from, setFrom] = useState(0); // index into narrated: where Listen starts
  const [at, setAt] = useState(0); // the scene being read (index into narrated)
  const atRef = useRef(0);
  const sentenceRef = useRef(0); // the sentence being read in that scene
  const speaker = useRef<Speaker | null>(null);
  if (!speaker.current) speaker.current = new Speaker();
  const settings = useRef({ speed, voice });
  settings.current = { speed, voice };

  /** Reads scene k from sentence `sentence`, then the scenes after it, to the end. */
  const readFrom = useCallback(
    (k: number, sentence = 0) => {
      if (k >= narrated.length) {
        setState("idle");
        return;
      }
      atRef.current = k;
      setAt(k);
      setState("reading");
      const parts = sentences(speakable(narrated[k].s.narration));
      sentenceRef.current = sentence;
      speaker.current!.speak(parts.slice(sentence).join(" "), {
        rate: settings.current.speed,
        voice: settings.current.voice,
        onSentence: (i) => (sentenceRef.current = sentence + i),
        onDone: () => readFrom(k + 1),
      });
    },
    // narrated is rebuilt from `scenes` on every render, so `scenes` is the real dependency
    [scenes],
  );

  // closing the dialog (or another tab) stops the reading
  useEffect(() => () => speaker.current?.stop(), []);

  // a new speed or voice while reading: the sentence on now starts again with it
  const restartHere = (nextSpeed: number, nextVoiceName: string) => {
    settings.current = { speed: nextSpeed, voice: pickVoice(voices, nextVoiceName) };
    if (state === "reading") readFrom(atRef.current, sentenceRef.current);
  };

  if (!supported()) {
    return <p className="muted small mo-listen">This browser has no text-to-speech, so the script can't be read aloud here. Edge or Chrome can.</p>;
  }
  if (!narrated.length) return null;

  const now = narrated[Math.min(at, narrated.length - 1)];
  return (
    <div className="mo-listen" role="group" aria-label="Listen to the script">
      <button
        type="button"
        className="btn btn-primary btn-small"
        onClick={() => {
          if (state === "reading") {
            speaker.current!.stop();
            setState("paused");
          } else if (state === "paused") readFrom(atRef.current, sentenceRef.current);
          else readFrom(from);
        }}
        title="Read the narration aloud with your browser's free text-to-speech"
      >
        {state === "reading" ? "Pause" : state === "paused" ? "Resume" : "Listen"}
      </button>
      <button
        type="button"
        className="btn btn-small"
        disabled={state === "idle"}
        onClick={() => {
          speaker.current!.stop();
          setState("idle");
        }}
      >
        Stop
      </button>
      <label className="mo-listen-field">
        <span>From</span>
        <select
          value={from}
          onChange={(e) => {
            const k = Number(e.target.value);
            setFrom(k);
            if (state !== "idle") readFrom(k); // reading: jump there now
          }}
        >
          {narrated.map(({ s, n }, k) => (
            <option key={s.id} value={k}>
              {n}. {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mo-listen-field">
        <span>Speed</span>
        <select
          value={speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            setSpeed(v);
            saveSpeed(v);
            restartHere(v, voice?.name ?? voiceName);
          }}
        >
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v}x
            </option>
          ))}
        </select>
      </label>
      {voices.length ? (
        <label className="mo-listen-field mo-listen-voice">
          <span>Voice</span>
          <select
            value={voice?.name ?? ""}
            onChange={(e) => {
              setVoiceName(e.target.value);
              saveVoiceName(e.target.value);
              restartHere(speed, e.target.value);
            }}
          >
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {voiceLabel(v)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <span className="mo-listen-now muted small" aria-live="polite">
        {state === "idle" ? `${narrated.length} narrated scenes · free browser voice, nothing billed` : `${state === "paused" ? "Paused at" : "Reading"} ${now.n}. ${now.s.name}`}
      </span>
    </div>
  );
}
