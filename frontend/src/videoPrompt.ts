/**
 * The prompt that asks Claude to build an AlgoInsight daily-series video from a competitor's video: the founder's
 * standing prompt (the same every time), filled in with this video's details, its short forms and how each one is
 * said, and the transcript itself, so one paste starts the job.
 */
import type { Transcript } from "./api";
import { clock, plainText, SOURCE_LABEL } from "./format";
import type { ShortForm } from "./shortForms";

export type PromptOptions = {
  topic: string;
  language: "english" | "hinglish";
  length: string;
  episode: string;
  stopForOk: boolean;
  special: string;
  includeTranscript: boolean;
  timestamps: boolean;
};

export const LANGUAGES: Record<PromptOptions["language"], string> = {
  english: "English only, the same female voice on Eleven v4",
  hinglish: "Hinglish, with an English edition, the female voice on Eleven v4",
};

/** The options a new transcript starts with. */
export function defaultOptions(t: Transcript): PromptOptions {
  return {
    topic: t.title,
    language: "english",
    length: "15-20",
    episode: "the next EP in the daily playlist",
    stopForOk: false,
    special: "",
    includeTranscript: true,
    timestamps: true,
  };
}

/** One short form as a line of the prompt: "- CI/CD: say C-I C-D (seen 12 times)". */
function shortFormLine(f: ShortForm): string {
  const seen = f.from === "added" ? "added by me" : `${f.count} time${f.count === 1 ? "" : "s"} in the transcript${f.from === "hindi" ? ", written in Hindi letters" : ""}`;
  return `- ${f.form}: say "${f.say}" (${seen})${f.check ? " - check this one" : ""}`;
}

export function buildPrompt(t: Transcript, o: PromptOptions, forms: ShortForm[]): string {
  const used = forms.filter((f) => f.include && f.form.trim() && f.say.trim());
  const source = [t.url, t.duration ? clock(t.duration) : null, t.language ? `language ${t.language}` : null, SOURCE_LABEL[t.source].toLowerCase()]
    .filter(Boolean).join(", ");

  const lines: string[] = [
    "NEW DAILY VIDEO - AlgoInsight daily series",
    "",
    `Topic: ${o.topic.trim() || t.title}`,
    `Competitor video: ${t.title} (${source})`,
    `Competitor transcript: ${o.includeTranscript ? "at the end of this prompt" : "attached"} (an outline only)`,
    `Language: ${LANGUAGES[o.language]}`,
    `Length: about ${o.length.trim() || "15-20"} minutes`,
    `Episode: ${o.episode.trim() || "the next EP in the daily playlist"}`,
    `Stop for my OK after the script, before the screens: ${o.stopForOk ? "yes" : "no"}`,
    `Anything special: ${o.special.trim() || "nothing"}`,
    "",
    "Before you start, read your daily video checklist and follow every point.",
    "",
    "1. FACTS",
    "- Use the transcript only to see what viewers expect. Don't copy its examples, order or lines. Build it our own way.",
    "- Check every fact, date, number and tool claim against primary sources and write them to FACTS.md. Tell me which of the competitor's claims are wrong or outdated. Nothing goes into the narration that is not in FACTS.md.",
    "",
    "2. STORY AND DEMOS",
    "- One running story or character carries the whole video. Use simple Indian everyday analogies, one per idea.",
    "- Show it for real wherever possible: really run it on this laptop and record the real screens. No fake output.",
    "- Code and data on screen are verbatim from the real files and runs. A long real run is shown as a labelled time-lapse.",
    "- Anything public (a GitHub repo, a push, a new account): ask me first.",
    "- Never use my name in the narration, on screen or in a run. Use a test name.",
    "",
    "3. SCRIPT, THREE PASSES ALWAYS",
    "- Pass 1: you write the draft from FACTS.md.",
    "- Pass 2: you humanise it yourself.",
    "- Pass 3: an independent agent on a different model makes it proper and humanised. Check its notes against the facts.",
    "- A woman talking to one viewer in natural spoken English. Simple words, contractions, the idea before the jargon. No AI habits: \"here's the thing\", \"let's dive in\", lists of three everywhere, a punchline at the end of every paragraph.",
    "- Voice rules: no digits, dashes, parentheses, semicolons, slashes (except in a short form the lexicon speaks, like CI/CD), \"vs\", %, &, quotation marks, audio tags or SSML. At most three breaks a scene. qa:narration and qa:spoken must pass.",
    "",
    "4. SHORT FORMS AND PRONUNCIATION",
    "- Every short form (an acronym, a product or file name, a code word) must be said properly by the voice. The ones in the competitor's video, and how she says each one:",
    ...(used.length ? used.map(shortFormLine) : ["- (none found in the transcript)"]),
    "- Treat that list as my decisions. Before writing, list every other short form your script will use, decide how it's said (letter by letter like C-I C-D, as a word like YAML said yammel, or a name as written like GitHub), and show me the new ones.",
    "- Write each short form in the narration the way the captions should show it (CI/CD, YAML), and the first time it appears, say in plain words what it stands for.",
    "- Check each one against the speech lexicon (server/src/utils/spokenText.ts): run the build with --terms to hear what the voice will get, and qa:spoken. A vowel-less short form must be spelled out.",
    "- If the lexicon says one wrong or doesn't know it, don't quietly respell the caption text. Tell me: a lexicon change is a deploy.",
    "- In the hand-off, give me a pronunciation table: each short form, how it's spoken, its first scene, and which ones to listen for.",
    "",
    "5. SCREENS",
    "- The daily series look: paper and ink on pale blue graph paper, our paper logo card, page turns.",
    "- Studio canvas scenes, every layer pinned to a cue, one-line labels, layouts measured.",
    "- Presenter off (the corner avatar is male).",
    "- Real recordings checked on a contact sheet, cut in tv range, tested in desktop Chrome.",
    "",
    "6. BUILD AND CHECKS",
    "- Register it in index.ts and in yt/series.ts (daily playlist, next EP). Voice 'female', performance 'v4', presenter 'off'.",
    "- Every gate green: build 0 problems, widths measured, visual audit 0 issues, qa:narration, qa:spoken, server and client typecheck, no stale DB draft.",
    "",
    "7. HANDS OFF",
    "- Never generate ElevenLabs audio, never render, never commit or push. I do those.",
    "- At most 2-3 writer agents at a time.",
    "- Hyphens, never em dashes, in everything you write.",
    "",
    "8. WHEN DONE, GIVE ME",
    "- The slug, the scene list with minutes, and the script file to read.",
    "- How to generate the first scene's audio, and the export command with --no-presenter.",
    "- The pronunciation table from section 4.",
    "- YouTube title options, description, tags, chapters and a thumbnail idea.",
    "- Anything you could not verify or had to guess.",
  ];
  if (o.includeTranscript) {
    lines.push("", "COMPETITOR TRANSCRIPT (an outline only: don't copy its examples, order or lines)", "", plainText(t, o.timestamps));
  }
  return lines.join("\n");
}

/** A file name for the prompt: "video-prompt-what-is-cicd-pipeline.md". */
export function promptFileName(o: PromptOptions, t: Transcript): string {
  const slug = (o.topic.trim() || t.title).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `video-prompt-${slug || "video"}.md`;
}
