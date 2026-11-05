/**
 * Short forms in a transcript (CI/CD, API, YAML, GitHub, K8s...) and how a narrator should say each one, for the
 * video prompt. Auto-captions of Hindi videos often spell English short forms in Hindi letters ("सीआईसीडी" is
 * CI CD), so those are found too and turned back into Latin letters.
 */
import type { Transcript } from "./api";

export type ShortForm = {
  /** As it should be written in the script and the captions: "CI/CD". */
  form: string;
  /** How the narrator says it: "C-I C-D", "yammel", "GitHub". */
  say: string;
  /** How many times the transcript uses it. */
  count: number;
  include: boolean;
  /** Where it came from: found in Latin letters, found in Hindi letters, or added by hand. */
  from: "latin" | "hindi" | "added";
  /** The suggestion is a guess worth a second look (a long all-capitals word may be said as a word). */
  check?: boolean;
};

/**
 * How common short forms are said, in the style of AlgoInsight's speech lexicon (server/src/utils/spokenText.ts):
 * letters joined by hyphens when spelled out, the usual word when it is said as one.
 */
const KNOWN: Record<string, string> = {
  "CI/CD": "C-I C-D", CI: "C-I", CD: "C-D", API: "A-P-I", APIs: "A-P-Is", UI: "U-I", UX: "U-X", URL: "U-R-L",
  HTTP: "H-T-T-P", HTTPS: "H-T-T-P-S", HTML: "H-T-M-L", CSS: "C-S-S", JS: "J-S", SQL: "S-Q-L", NoSQL: "no S-Q-L",
  JSON: "jay-son", YAML: "yammel", XML: "X-M-L", AWS: "A-W-S", GCP: "G-C-P", AI: "A-I", ML: "M-L", LLM: "L-L-M",
  LLMs: "L-L-Ms", GPU: "G-P-U", CPU: "C-P-U", RAM: "ram", SSD: "S-S-D", DNS: "D-N-S", IP: "I-P", TCP: "T-C-P",
  UDP: "U-D-P", VPN: "V-P-N", SDK: "S-D-K", CLI: "C-L-I", IDE: "I-D-E", OS: "O-S", PR: "P-R", PRs: "P-Rs", QA: "Q-A",
  DevOps: "dev ops", GitHub: "GitHub", GitLab: "GitLab", npm: "N-P-M", SaaS: "sass", K8s: "Kubernetes", EC2: "E-C-two",
  S3: "S-three", JWT: "J-W-T", OAuth: "oh-auth", SEO: "S-E-O", PDF: "P-D-F", RAG: "rag", MCP: "M-C-P", LAN: "lan",
  APK: "A-P-K", MVP: "M-V-P", SLA: "S-L-A", CTO: "C-T-O", CEO: "C-E-O", HR: "H-R", ID: "I-D", IDs: "I-Ds", OK: "okay",
  SMS: "S-M-S", OTP: "O-T-P", UPI: "U-P-I", KYC: "K-Y-C", GST: "G-S-T", EMI: "E-M-I", IT: "I-T", AR: "A-R", VR: "V-R",
  IoT: "I-O-T", USB: "U-S-B", PHP: "P-H-P", REST: "rest", CRUD: "crud", ORM: "O-R-M", MVC: "M-V-C", OOP: "O-O-P",
  DSA: "D-S-A", NLP: "N-L-P", GPT: "G-P-T", ChatGPT: "Chat G-P-T", iOS: "eye O-S", macOS: "mac O-S", IMVU: "I-M-V-U",
  CircleCI: "Circle C-I", DORA: "dora", NASA: "nasa", PaaS: "pass", IaaS: "eye-ass", B2B: "B-to-B", B2C: "B-to-C",
};

/** English letter names as Hindi captions write them, longest first so "डब्ल्यू" wins over shorter pieces. */
const HINDI_LETTERS: Array<[string, string]> = ([
  ["डब्ल्यू", "W"], ["डबल्यू", "W"], ["क्यू", "Q"], ["एक्स", "X"], ["ज़ेड", "Z"], ["जेड", "Z"], ["वाई", "Y"], ["एफ़", "F"],
  ["एफ", "F"], ["एच", "H"], ["एल", "L"], ["एम", "M"], ["एन", "N"], ["एस", "S"], ["आर", "R"], ["आई", "I"], ["बी", "B"],
  ["सी", "C"], ["डी", "D"], ["जी", "G"], ["जे", "J"], ["के", "K"], ["पी", "P"], ["टी", "T"], ["वी", "V"], ["यू", "U"],
  ["ए", "A"], ["ई", "E"], ["ओ", "O"],
] as Array<[string, string]>).sort((a, b) => b[0].length - a[0].length);

/** Hindi words that happen to be made of letter names but are ordinary words. */
const HINDI_WORDS = new Set(["आईए", "आई", "के", "की", "जी", "सी", "ए", "ई", "ओ", "एक"]);

/** A Hindi-letter spelling of English letters ("सीआईसीडी") as those letters ("CICD"), or null. */
function hindiLetters(word: string): string | null {
  if (HINDI_WORDS.has(word)) return null;
  let rest = word, out = "";
  while (rest) {
    const hit = HINDI_LETTERS.find(([h]) => rest.startsWith(h));
    if (!hit) return null;
    out += hit[1];
    rest = rest.slice(hit[0].length);
  }
  return out.length >= 2 ? out : null;
}

/** "CICD" from Hindi letters is written CI/CD; others stay as the letters. */
const HINDI_WRITTEN: Record<string, string> = { CICD: "CI/CD", APIS: "APIs", PRS: "PRs", IDS: "IDs" };

const DIGIT: Record<string, string> = { "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine" };

/** A guess at how to say a short form nobody has listed yet. */
export function suggestSay(form: string): { say: string; check: boolean } {
  if (KNOWN[form]) return { say: KNOWN[form], check: false };
  // a brand or name with small letters in it (GitHub, JavaScript): as written
  if (/[a-z]/.test(form) && !/^[A-Z0-9/]+s$/.test(form)) return { say: form, check: false };
  // all capitals: spell it out, letter by letter, slashes as a pause between groups, digits as words (the
  // narration never has a digit in it)
  const spelled = form.split("/").map((g) => g.replace(/s$/, "").split("").map((ch) => DIGIT[ch] ?? ch).join("-") + (/s$/.test(g) && g.length > 2 ? "s" : "")).join(" ");
  // a long one with vowels may be said as a word (NASA): a guess, worth a look
  const wordy = form.length >= 5 && /[AEIOU]/.test(form) && !form.includes("/");
  return { say: spelled, check: wordy };
}

/** Every short form in the transcript, the most used first. */
export function findShortForms(t: Transcript): ShortForm[] {
  const text = t.segments.map((s) => s.text).join(" ");
  const found = new Map<string, { count: number; from: ShortForm["from"] }>();
  const add = (form: string, from: ShortForm["from"]) => {
    const f = found.get(form);
    if (f) f.count++;
    else found.set(form, { count: 1, from });
  };

  // Latin letters: CI/CD, API, APIs, K8s, EC2, and names with capitals inside (GitHub, CircleCI, DevOps)
  const latin = /\b(?:[A-Z][A-Z0-9]+(?:\/[A-Z][A-Z0-9]*)*s?|[A-Za-z]*[a-z][A-Z][A-Za-z0-9]*|[A-Z][a-z]*\d+[A-Za-z0-9]*)\b/g;
  for (const m of text.match(latin) ?? []) {
    if (m.length < 2 || /^\d+$/.test(m)) continue;
    add(m, "latin");
  }
  // Hindi letters: सीआईसीडी, एपीआई, डीएनएस
  for (const w of text.match(/[ऀ-ॿ]+/g) ?? []) {
    const letters = hindiLetters(w);
    if (letters) add(HINDI_WRITTEN[letters] ?? letters, "hindi");
  }

  return [...found.entries()]
    .map(([form, f]) => ({ form, ...suggestSay(form), count: f.count, include: true, from: f.from }))
    .sort((a, b) => b.count - a.count || a.form.localeCompare(b.form));
}
