// "Your words": Claude's draft of the narration, scene by scene, for the user to put in their own words
// before any scene code is written. Each [[you: ...]] place shows what it asks for (a story of their own,
// an opinion, a real number from their runs). Text saves as it is typed (the scene's narration, as in the
// properties panel), and a scene the user rewrote is marked as theirs, so Claude won't change it unless
// asked. The Script dialog's footer approves the script and sends the build on.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { clock, motionApi } from "./api";
import { SLOT_RE, isBuildable, type ProjectView } from "./types";

type Props = {
  projectId: string;
  view: ProjectView;
  running: boolean;
  onSaved: (view: ProjectView) => void;
};

const WORDS_PER_SECOND = 2.9; // the server's speech estimate (voice.WORDS_PER_SECOND)
const CUE_RE = /<\s*cue\s*\/?\s*>/gi;

/** What each place left for the user's words asks for, in order. */
export const asksOf = (text: string) => Array.from(text.matchAll(SLOT_RE), (m) => m[1].trim());

/** Spoken words: the places for the user's words and the cue marks don't count. */
const spokenWords = (text: string) =>
  text
    .replace(SLOT_RE, " ")
    .replace(CUE_RE, " ")
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;

/** Enough rows to show a scene's narration without scrolling inside the box. */
const rowsFor = (text: string) => Math.min(14, Math.max(3, Math.ceil(text.length / 95) + 1));

export default function ScriptWords({ projectId, view, running, onSaved }: Props) {
  const scenes = useMemo(() => view.bundle.scenes.filter((s) => isBuildable(s) && (s.narration || "").trim()), [view.bundle.scenes]);
  const mine = useMemo(() => new Set((view.project.scenes ?? []).filter((s) => s.byUser).map((s) => s.id)), [view.project.scenes]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, "saving" | "saved" | "">>({});
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(new Set<string>());
  const revs = useRef<Record<string, number>>({});
  const timers = useRef<Record<string, number>>({});

  // what is saved (Claude's edits, Undo) shows here, except in a scene that is being typed in
  useEffect(() => {
    for (const s of scenes) revs.current[s.id] = s.rev;
    setTexts((cur) => {
      const next = { ...cur };
      for (const s of scenes) if (!dirty.current.has(s.id)) next[s.id] = s.narration;
      return next;
    });
  }, [scenes]);

  useEffect(() => {
    const pending = timers.current;
    return () => Object.values(pending).forEach((t) => window.clearTimeout(t));
  }, []);

  async function save(sid: string, text: string) {
    setStatus((m) => ({ ...m, [sid]: "saving" }));
    try {
      const v = await motionApi.editScene(projectId, sid, { narration: text, baseRev: revs.current[sid] });
      dirty.current.delete(sid);
      onSaved(v);
      setStatus((m) => ({ ...m, [sid]: "saved" }));
    } catch (err) {
      dirty.current.delete(sid);
      setStatus((m) => ({ ...m, [sid]: "" }));
      setError(err instanceof Error ? err.message : String(err));
      // reload, so the box shows what is really saved now
      motionApi.getProject(projectId).then(onSaved).catch(() => null);
    }
  }

  /** Saves a scene's text after a short pause in typing. */
  function edit(sid: string, text: string) {
    dirty.current.add(sid);
    setError(null);
    setTexts((m) => ({ ...m, [sid]: text }));
    setStatus((m) => ({ ...m, [sid]: "" }));
    window.clearTimeout(timers.current[sid]);
    timers.current[sid] = window.setTimeout(() => void save(sid, text), 700);
  }

  const slotsLeft = scenes.reduce((n, s) => n + asksOf(texts[s.id] ?? s.narration).length, 0);
  const rewritten = scenes.filter((s) => mine.has(s.id)).length;
  const index = (id: string) => view.bundle.scenes.findIndex((s) => s.id === id) + 1;

  if (!scenes.length) return <p className="muted">No script yet: Claude writes the draft first, then it shows here for your own words.</p>;

  return (
    <div className="mo-words">
      <div className="mo-words-head">
        <p>
          Claude's draft, scene by scene. Make it yours: say each scene the way you would, with your own stories, opinions and real numbers. Write over
          every <code>[[you: ...]]</code> place, and keep the <code>&lt;cue/&gt;</code> marks where the picture should change.
        </p>
        <div className="mo-words-stats" aria-live="polite">
          <span className={rewritten === scenes.length ? "ok" : ""}>
            {rewritten} of {scenes.length} scene{scenes.length === 1 ? "" : "s"} in your words
          </span>
          <span className={slotsLeft ? "warn" : "ok"}>{slotsLeft ? `${slotsLeft} place${slotsLeft === 1 ? "" : "s"} left for your words` : "No places left"}</span>
          {view.script?.approved ? <span className="ok">Approved</span> : null}
        </div>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {scenes.map((s, i) => {
        const text = texts[s.id] ?? s.narration;
        const asks = asksOf(text);
        const words = spokenWords(text);
        const newPart = s.part && s.part !== scenes[i - 1]?.part;
        return (
          <Fragment key={s.id}>
            {newPart ? <h3 className="mo-words-part">{s.part}</h3> : null}
            <section className={`mo-words-scene${asks.length ? " has-slots" : ""}`}>
              <header>
                <span className="mo-words-name">
                  {index(s.id)}. {s.name}
                  {s.label ? <span className="muted"> · {s.label}</span> : null}
                </span>
                <span className={`mo-words-tag${mine.has(s.id) ? " mine" : ""}`}>{mine.has(s.id) ? "Your words" : "Claude's draft"}</span>
                <span className="muted small">
                  {words} words, about {clock(words / WORDS_PER_SECOND)}
                  {status[s.id] === "saving" ? " · saving" : status[s.id] === "saved" ? " · saved" : ""}
                </span>
              </header>
              {asks.length ? (
                <ul className="mo-words-asks">
                  {asks.map((a, k) => (
                    <li key={k}>
                      <b>Your words:</b> {a}
                    </li>
                  ))}
                </ul>
              ) : null}
              <textarea
                value={text}
                rows={rowsFor(text)}
                disabled={running}
                spellCheck
                aria-label={`Narration of scene ${index(s.id)}, ${s.name}`}
                onChange={(e) => edit(s.id, e.target.value)}
              />
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
