// Free voice: the browser's own text-to-speech (the Web Speech API), for hearing a script before the real voice
// is made with ElevenLabs. Nothing is billed. Edge has Microsoft's natural "Online" voices (they send the text to
// Microsoft's speech service), Chrome its Google voices, and every browser the computer's own voices (which stay
// on this computer). The preview reads the scenes that have no voice yet as they play; the Script dialog reads
// the whole narration from any scene.
//
// Two browser quirks shape this file:
// - Chrome's Google voices stop after about 15 seconds of one utterance, so text is spoken a sentence at a time.
// - pause()/resume() are unreliable (Chrome resumes in silence), so pausing stops the speech, and resuming
//   starts again from the sentence that was playing.

import { useEffect, useState } from "react";

/** The speeds offered in the preview and the Script dialog. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const SPEED_KEY = "motion.speed";
const VOICE_KEY = "motion.freeVoiceName";

export function supported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

// The speed and the chosen voice are remembered per browser (a viewer's convenience: wrapped, since storage can
// be off or throw in a private window, and the page works the same without it).
export function loadSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveSpeed(v: number): void {
  try {
    localStorage.setItem(SPEED_KEY, String(v));
  } catch {
    /* storage off: the speed just isn't remembered */
  }
}

export function loadVoiceName(): string {
  try {
    return localStorage.getItem(VOICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveVoiceName(name: string): void {
  try {
    localStorage.setItem(VOICE_KEY, name);
  } catch {
    /* storage off */
  }
}

/** The words as a person reads them: the <cue/> marks, SSML-style breaks and any other tags out, a [[...]] place
 *  for the user's own words dropped, white space tidied. */
export function speakable(narration: string): string {
  return narration
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences of at most about 220 characters (a long one is split after a comma). */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text]) {
    let s = raw.trim();
    while (s.length > 220) {
      const cut = s.lastIndexOf(", ", 200);
      if (cut < 60) break;
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 2).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/** The text from a share of the way through: what the voice would be saying that far into it (by words). */
export function fromFraction(text: string, fraction: number): string {
  if (fraction <= 0.03) return text;
  const words = text.split(" ");
  return words.slice(Math.min(words.length, Math.round(words.length * Math.min(1, fraction)))).join(" ");
}

/** English voices first (then the rest), each once, the natural online ones before the plain ones. */
function sortVoices(all: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const rank = (v: SpeechSynthesisVoice) => (v.lang.toLowerCase().startsWith("en") ? 0 : 2) + (/natural|online|neural/i.test(v.name) ? 0 : 1);
  const seen = new Set<string>();
  return all
    .filter((v) => (seen.has(v.name) ? false : (seen.add(v.name), true)))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The browser's voices, kept up to date (they arrive a moment after the page loads). */
export function useVoices(): SpeechSynthesisVoice[] {
  const [list, setList] = useState<SpeechSynthesisVoice[]>(() => (supported() ? sortVoices(speechSynthesis.getVoices()) : []));
  useEffect(() => {
    if (!supported()) return;
    const update = () => setList(sortVoices(speechSynthesis.getVoices()));
    update();
    speechSynthesis.addEventListener("voiceschanged", update);
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return list;
}

/** The voice to use: the one chosen before when it still exists, else a natural English female voice when there
 *  is one (closest to the video's narrator), else the first English voice. */
export function pickVoice(list: SpeechSynthesisVoice[], wanted: string): SpeechSynthesisVoice | null {
  if (!list.length) return null;
  return (
    list.find((v) => v.name === wanted) ??
    list.find((v) => /^en/i.test(v.lang) && /natural|online/i.test(v.name) && /aria|jenny|emma|ava|sonia|libby|neerja|female/i.test(v.name)) ??
    list.find((v) => /^en/i.test(v.lang) && /natural|online/i.test(v.name)) ??
    list.find((v) => /^en/i.test(v.lang)) ??
    list[0]
  );
}

/** A voice's label in a menu: its name without the vendor clutter, and where it runs. */
export function voiceLabel(v: SpeechSynthesisVoice): string {
  // "Microsoft Aria Online (Natural) - English (United States)" -> "Aria (en-US) · online"
  const name = v.name.split(" - ")[0].replace(/^Microsoft\s+/i, "").replace(/\s*\(Natural\)\s*/i, " ").replace(/\s+Online\b/i, "").trim();
  return `${name} (${v.lang})${v.localService ? "" : " · online"}`;
}

/** Speaks text a sentence at a time; stop() ends it at once (a newer speak() also ends the older one). */
export class Speaker {
  private token = 0;

  speak(text: string, opts: { rate: number; voice: SpeechSynthesisVoice | null; onSentence?: (i: number) => void; onDone?: () => void }): void {
    this.stop();
    if (!supported() || !text.trim()) {
      opts.onDone?.();
      return;
    }
    const mine = ++this.token;
    const parts = sentences(text);
    let i = 0;
    const next = () => {
      if (mine !== this.token) return; // stopped, or replaced by a newer speak()
      if (i >= parts.length) {
        opts.onDone?.();
        return;
      }
      const u = new SpeechSynthesisUtterance(parts[i]);
      opts.onSentence?.(i);
      i += 1;
      u.rate = Math.max(0.1, Math.min(4, opts.rate));
      u.lang = opts.voice?.lang || "en-US";
      if (opts.voice) {
        try {
          u.voice = opts.voice;
        } catch {
          // a voice the browser no longer accepts (the list changed under it): its default voice reads instead
        }
      }
      u.onend = next;
      // a cancel ends the current sentence with "interrupted" or "canceled": only a real failure moves on
      u.onerror = (e) => {
        if (e.error !== "interrupted" && e.error !== "canceled") next();
      };
      speechSynthesis.speak(u);
    };
    next();
  }

  stop(): void {
    this.token += 1;
    if (supported()) speechSynthesis.cancel();
  }
}
