// Code walkthroughs: a <pre class="p-code" data-lang="java"> turned into numbered, highlighted lines.
//
// A scene writes the code as a prop, so it arrives HTML-escaped and the <pre> holds plain text:
//   <pre class="p-code" data-id="code-1" data-lang="java">{{code}}</pre>
// When the scene is built (before its script runs) the text is cut into one span per line, and the tokens
// inside each line into highlight spans (keywords, types, strings, comments, numbers, function calls).
// Not one character of the code changes: line numbers are drawn by CSS counters, each newline stays in the
// text (in a hidden span at the end of its line), and the block's textContent is checked against the
// original afterwards (on any mismatch the plain text goes back). fx.code types the lines on, fx.line moves
// a marker band behind the lines being talked about (see paper.ts).

type Cls = "" | "kw" | "ty" | "str" | "com" | "num" | "fn";

type Spec = {
  /** line comment openers */
  line: string[];
  /** block comment [open, close] pairs */
  block: [string, string][];
  /** string delimiters, longest first (a triple quote before a single one) */
  quotes: string[];
  kw: Set<string>;
  ty: Set<string>;
  /** SQL: keywords in any case */
  caseless?: boolean;
  /** a Capitalised identifier is a type (String, HashMap, Promise) */
  capTypes?: boolean;
  /** bash: $VAR and ${...} are variables, and # starts a comment only after a space */
  shell?: boolean;
  /** C and C++: #include and the other preprocessor lines */
  directives?: boolean;
  /** Java annotations and Python decorators (@Override, @dataclass) */
  at?: boolean;
  /** backslash escapes inside strings */
  escapes?: boolean;
};

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_KW = "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while true false NULL";
const CPP_KW = "class namespace template typename public private protected virtual override final new delete this using try catch throw nullptr operator friend explicit constexpr noexcept static_cast dynamic_cast reinterpret_cast const_cast mutable co_await co_return";
const C_TY = "int char float double void long short unsigned signed bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t FILE";

const JAVA: Spec = {
  line: ["//"],
  block: [["/*", "*/"]],
  quotes: ['"""', '"', "'"],
  kw: words("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record yield sealed permits true false null"),
  ty: words("boolean byte char short int long float double void"),
  capTypes: true,
  at: true,
  escapes: true,
};

const PYTHON: Spec = {
  line: ["#"],
  block: [],
  quotes: ['"""', "'''", '"', "'"],
  kw: words("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
  ty: words("int float str bool list dict set tuple bytes bytearray object complex frozenset"),
  capTypes: true,
  at: true,
  escapes: true,
};

const JS: Spec = {
  line: ["//"],
  block: [["/*", "*/"]],
  quotes: ["`", '"', "'"],
  kw: words("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set true false null undefined interface type enum implements private public protected readonly abstract declare namespace keyof as is infer satisfies from"),
  ty: words("any number string boolean unknown never object symbol bigint"),
  capTypes: true,
  at: true,
  escapes: true,
};

const SQL: Spec = {
  line: ["--"],
  block: [["/*", "*/"]],
  quotes: ["'", '"'],
  kw: words("select from where and or not insert into values update set delete create table index view drop alter add column primary key foreign references join inner left right full outer cross on as group by order having limit offset distinct union all exists in is null like ilike between case when then else end asc desc default unique check constraint with returning begin commit rollback transaction if replace true false over partition window rows range using natural cascade trigger explain analyze fetch first next only top"),
  ty: words("int integer bigint smallint tinyint serial bigserial decimal numeric real float double precision varchar char character text boolean bool date time timestamp timestamptz interval uuid json jsonb blob bytea"),
  caseless: true,
};

const BASH: Spec = {
  line: ["#"],
  block: [],
  quotes: ['"', "'"],
  kw: words("if then else elif fi for while until do done case esac in function return break continue local export readonly declare unset shift exit source alias select time trap"),
  ty: new Set(),
  shell: true,
  escapes: true,
};

const GO: Spec = {
  line: ["//"],
  block: [["/*", "*/"]],
  quotes: ["`", '"', "'"],
  kw: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota"),
  ty: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
  capTypes: true,
  escapes: true,
};

const C: Spec = { line: ["//"], block: [["/*", "*/"]], quotes: ['"', "'"], kw: words(C_KW), ty: words(C_TY), directives: true, escapes: true };
const CPP: Spec = { ...C, kw: words(C_KW + " " + CPP_KW), ty: words(C_TY + " string vector map set unordered_map unordered_set pair array deque queue stack"), capTypes: true };

/** data-lang values the highlighter knows (anything else is shown as plain text, numbered). */
const LANGS: Record<string, Spec> = {
  java: JAVA,
  python: PYTHON, py: PYTHON,
  javascript: JS, js: JS, jsx: JS, typescript: JS, ts: JS, tsx: JS, node: JS,
  sql: SQL, postgres: SQL, postgresql: SQL, mysql: SQL, sqlite: SQL,
  bash: BASH, sh: BASH, shell: BASH, zsh: BASH,
  go: GO, golang: GO,
  c: C, h: C,
  cpp: CPP, "c++": CPP, cc: CPP, hpp: CPP, cxx: CPP,
};

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]+)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[lLfFdDuUnj]*/;
const WORD = /^[A-Za-z_$][\w$]*/;
const SHELL_VAR = /^\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@#?*!$-])/;

/** The end of a string that starts at i with delimiter q (unterminated: the end of its line, or of the text
 *  for triple quotes and backticks, which may span lines). */
function stringEnd(src: string, i: number, q: string, escapes: boolean): number {
  const multi = q.length === 3 || q === "`";
  let j = i + q.length;
  while (j < src.length) {
    const c = src[j];
    if (escapes && c === "\\") {
      j += 2;
      continue;
    }
    if (src.startsWith(q, j)) return j + q.length;
    if (c === "\n" && !multi) return j;
    j++;
  }
  return src.length;
}

/** The code as [text, class] runs; joined together they are exactly the source. */
export function tokenize(src: string, lang: string): [string, Cls][] {
  const spec = LANGS[lang.trim().toLowerCase()];
  if (!spec) return [[src, ""]];
  const out: [string, Cls][] = [];
  const push = (t: string, c: Cls) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last[1] === c) last[0] += t;
    else out.push([t, c]);
  };
  let prevWord = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const before = i > 0 ? src[i - 1] : "\n";
    // block comments
    const block = spec.block.find(([open]) => src.startsWith(open, i));
    if (block) {
      const end = src.indexOf(block[1], i + block[0].length);
      const j = end < 0 ? n : end + block[1].length;
      push(src.slice(i, j), "com");
      i = j;
      continue;
    }
    // line comments (a shell # only where a word can start, so $# and ${#x} stay code)
    const line = spec.line.find((open) => src.startsWith(open, i) && (!spec.shell || /\s/.test(before)));
    if (line) {
      const end = src.indexOf("\n", i);
      const j = end < 0 ? n : end;
      push(src.slice(i, j), "com");
      i = j;
      continue;
    }
    // C preprocessor lines: #include <stdio.h>
    if (spec.directives && ch === "#" && /^[ \t]*$/.test(src.slice(src.lastIndexOf("\n", i - 1) + 1, i))) {
      const m = /^#[ \t]*\w+/.exec(src.slice(i, i + 40));
      if (m) {
        push(m[0], "kw");
        i += m[0].length;
        const inc = /^[ \t]*<[^>\n]*>/.exec(src.slice(i, i + 200));
        if (inc) {
          push(inc[0], "str");
          i += inc[0].length;
        }
        continue;
      }
    }
    // strings
    const q = spec.quotes.find((open) => src.startsWith(open, i));
    if (q) {
      const j = stringEnd(src, i, q, !!spec.escapes);
      push(src.slice(i, j), "str");
      i = j;
      continue;
    }
    // shell variables
    if (spec.shell && ch === "$") {
      const m = SHELL_VAR.exec(src.slice(i, i + 120));
      if (m) {
        push(m[0], "ty");
        i += m[0].length;
        continue;
      }
    }
    // numbers (not the digits at the end of a name like node2)
    if ((/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) && !/[\w$.]/.test(before)) {
      const m = NUMBER.exec(src.slice(i, i + 64));
      if (m) {
        push(m[0], "num");
        i += m[0].length;
        continue;
      }
    }
    // annotations and decorators
    if (spec.at && ch === "@" && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
      const m = /^@[\w.]+/.exec(src.slice(i, i + 80))!;
      push(m[0], "kw");
      i += m[0].length;
      continue;
    }
    // names: keywords, types, calls
    if (/[A-Za-z_$]/.test(ch) && !(spec.shell && ch === "$")) {
      const w = WORD.exec(src.slice(i, i + 200))![0];
      const key = spec.caseless ? w.toLowerCase() : w;
      let c: Cls = "";
      if (spec.kw.has(key)) c = "kw";
      else if (spec.ty.has(key)) c = "ty";
      else if (src[i + w.length] === "(") c = prevWord === "new" ? "ty" : "fn";
      else if (spec.capTypes && /^[A-Z]/.test(w) && /[a-z]/.test(w)) c = "ty";
      push(w, c);
      prevWord = w;
      i += w.length;
      continue;
    }
    if (!/\s/.test(ch)) prevWord = "";
    push(ch, "");
    i++;
  }
  return out;
}

/** Highlights every .p-code block under root (once each). */
export function buildCode(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>(".p-code"))) {
    if (pre.dataset.coded || pre.children.length) continue; // done already, or hand-made markup inside
    pre.dataset.coded = "1";
    const text = pre.textContent || "";
    const lines: [string, Cls][][] = [[]];
    for (const [t, c] of tokenize(text, pre.dataset.lang || "")) {
      t.split("\n").forEach((part, k) => {
        if (k > 0) lines.push([]);
        if (part) lines[lines.length - 1].push([part, c]);
      });
    }
    // a final newline closes the last line; it doesn't start a new, empty numbered one
    const count = text.endsWith("\n") && lines.length > 1 ? lines.length - 1 : lines.length;
    pre.textContent = "";
    for (let k = 0; k < count; k++) {
      const ln = document.createElement("span");
      ln.className = "p-code-line";
      for (const [t, c] of lines[k]) {
        if (!c) ln.appendChild(document.createTextNode(t));
        else {
          const s = document.createElement("span");
          s.className = "t-" + c;
          s.textContent = t;
          ln.appendChild(s);
        }
      }
      if (k < lines.length - 1) {
        // the newline itself, kept in the text (each line is its own block, so it is not drawn)
        const nl = document.createElement("span");
        nl.className = "p-code-nl";
        nl.textContent = "\n";
        ln.appendChild(nl);
      }
      pre.appendChild(ln);
    }
    if (pre.textContent !== text) {
      pre.textContent = text; // never show code that differs from what was written
      continue;
    }
    const start = Math.max(0, Math.floor(Number(pre.dataset.start) || 1));
    pre.style.setProperty("--p-code-start", String(start - 1));
    pre.style.setProperty("--p-code-gutter", `${String(start + count - 1).length}ch`);
    // a diff (data-lang="diff", or data-diff on a block in its own language): each added line green, each
    // removed one red, each hunk header (@@) quiet; the + and - stay in the text as they were written
    if ((pre.dataset.lang || "").toLowerCase() === "diff" || pre.hasAttribute("data-diff")) {
      pre.classList.add("p-code-diff");
      for (const ln of Array.from(pre.querySelectorAll<HTMLElement>(":scope > .p-code-line"))) {
        const s = ln.textContent || "";
        if (s.startsWith("@@")) ln.classList.add("p-code-hunk");
        else if (s.startsWith("+")) ln.classList.add("p-code-add");
        else if (s.startsWith("-")) ln.classList.add("p-code-del");
      }
    }
  }
  buildTerms(root);
}

// ── terminals ──
//
// A terminal window: <pre class="p-term" data-id="term-1" data-title="bash  ~/shop">{{session}}</pre>, the
// session written as a prop (so it arrives escaped), verbatim from a real run: a line that starts with the
// prompt ("$ " by default; data-prompt="PS>" or "#" for another) is a command, every other line its output.
// When the scene is built the pre becomes a window: a title bar with the three lights, then one line per
// line of the session (the prompt green, the command bright, the output grey). The text stays exactly what
// was written (checked, like a code block). fx.term(el, at) plays it: each command typed on, then its output.

export function buildTerms(root: ParentNode) {
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>(".p-term"))) {
    if (pre.dataset.termed || pre.children.length) continue;
    pre.dataset.termed = "1";
    const text = (pre.textContent || "").replace(/\n$/, "");
    const prompt = pre.dataset.prompt ?? "$";
    pre.textContent = "";
    const bar = document.createElement("span");
    bar.className = "p-term-bar";
    bar.innerHTML = '<span class="p-term-lights"><i></i><i></i><i></i></span><span class="p-term-title"></span>';
    (bar.lastChild as HTMLElement).textContent = pre.dataset.title || "terminal";
    const body = document.createElement("span");
    body.className = "p-term-body";
    const lines = text.split("\n");
    lines.forEach((line, k) => {
      const ln = document.createElement("span");
      ln.className = "p-term-line";
      if (line === prompt || line.startsWith(prompt + " ")) {
        ln.classList.add("p-term-cmd");
        const ps = document.createElement("span");
        ps.className = "p-term-ps";
        ps.textContent = line.slice(0, prompt.length);
        ln.appendChild(ps);
        ln.appendChild(document.createTextNode(line.slice(prompt.length)));
      } else {
        ln.classList.add("p-term-out");
        ln.textContent = line;
      }
      if (k < lines.length - 1) {
        const nl = document.createElement("span");
        nl.className = "p-code-nl";
        nl.textContent = "\n";
        ln.appendChild(nl);
      }
      body.appendChild(ln);
    });
    pre.append(bar, body);
    if (body.textContent !== text) {
      pre.textContent = text; // never show output that differs from what was written
      delete pre.dataset.termed;
    }
  }
}

export type TermOpts = {
  /** seconds per character of a command typed on (0.035), at most maxType seconds for one command (1.6) */
  perChar?: number;
  maxType?: number;
  /** the pause between a command and its output (0.3 s) */
  pause?: number;
  /** seconds between two lines of output (0.06) */
  perLine?: number;
};

/** Plays a terminal window's session from `at` (or the k-th command at at[k]): each command typed on, then its
 *  output line by line. Returns when it ends, and the lines, for pinning what comes next. */
export function playTerm(
  ctx: { tl: gsap.core.Timeline; sound: (name: string, at: number, gain?: number) => void; mark: (kind: string, els: Element[], at: number) => void },
  el: Element,
  at: number | number[],
  opts: TermOpts = {},
): { end: number; lines: HTMLElement[] } {
  const lines = Array.from(el.querySelectorAll<HTMLElement>(":scope > .p-term-body > .p-term-line"));
  if (!lines.length) throw new Error('fx.term needs a terminal window: <pre class="p-term" data-id="term-1">{{session}}</pre>');
  const times = (Array.isArray(at) ? at : [at]).map(Number);
  if (!times.length || !times.every(Number.isFinite)) throw new Error("fx.term needs a time, like cue(1), or one per command");
  const perChar = Math.max(0.01, opts.perChar ?? 0.035);
  const maxType = Math.max(0.2, opts.maxType ?? 1.6);
  const pause = Math.max(0, opts.pause ?? 0.3);
  const perLine = Math.max(0, opts.perLine ?? 0.06);
  let t = Math.max(0, times[0]);
  let cmd = 0;
  ctx.mark("term", [el], t);
  for (const ln of lines) {
    if (ln.classList.contains("p-term-cmd")) {
      if (cmd > 0 && times[cmd] != null) t = Math.max(t, times[cmd]);
      cmd++;
      const chars = (ln.textContent || "").replace(/\n$/, "").length;
      const dur = Math.min(maxType, Math.max(0.15, chars * perChar));
      ctx.tl.fromTo(ln, { clipPath: "inset(-6px 100% -6px 0px)" }, { clipPath: "inset(-6px 0% -6px 0px)", duration: dur, ease: `steps(${Math.max(1, Math.min(chars + 1, 80))})` }, t);
      ctx.tl.set(ln, { clipPath: "none" }, t + dur);
      ctx.sound("type", t, 0.6);
      t += dur + pause;
    } else {
      ctx.tl.fromTo(ln, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, t);
      t += perLine;
    }
  }
  return { end: t, lines };
}

/** The highlighted block's lines (empty for a block that isn't highlighted). */
export const codeLines = (pre: Element): HTMLElement[] => Array.from(pre.querySelectorAll<HTMLElement>(":scope > .p-code-line"));

/** The number the first line shows (data-start, 1 by default). */
export const codeStart = (pre: HTMLElement) => Math.max(0, Math.floor(Number(pre.dataset.start) || 1));

/**
 * The code card: white, a 4 px ink edge, radius 18 and a hard ink shadow 10 px down-right (like p-card),
 * monospace at 22 px, slate line numbers and muted syntax colours that read on white. The marker band
 * (fx.line) sits behind the lines. In every scene, whatever the theme. No ligatures: JetBrains Mono would
 * draw <= as one sign and == as one long bar, which a learner can't type.
 */
export const CODE_CSS = `
.p-code { position: relative; display: block; margin: 0; padding: 20px 30px 20px 18px; background: #fff; border: 4px solid var(--ink); border-radius: 18px; box-shadow: 10px 10px 0 var(--ink);
  font: 500 22px/1.55 var(--font-mono); color: var(--ink); white-space: pre; tab-size: 4; text-align: left; overflow: hidden; counter-reset: p-line var(--p-code-start, 0);
  font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }
.p-code-line { position: relative; z-index: 1; display: block; width: max-content; }
.p-code-line::before { counter-increment: p-line; content: counter(p-line); display: inline-block; width: var(--p-code-gutter, 2ch); margin-right: 1.4ch; text-align: right; color: #94a3b8; }
.p-code-nl { display: none; }
.p-code-band { position: absolute; left: 8px; right: 8px; top: 0; height: 0; border-radius: 8px; background: var(--c-marker, var(--accent)); z-index: 0; opacity: 0; visibility: hidden; pointer-events: none; }
.p-code .t-kw { color: #8e3a9e; } .p-code .t-ty { color: #0e6f7c; } .p-code .t-str { color: #2d7a3a; }
.p-code .t-com { color: #7b8798; } .p-code .t-num { color: #b0560f; } .p-code .t-fn { color: #2a5bb8; }
.p-code-diff .p-code-line { width: auto; padding: 0 10px 0 14px; border-radius: 4px; }
.p-code-diff .p-code-line::before { display: none; }
.p-code-add { background: #dcfce7; box-shadow: inset 5px 0 0 #16a34a; }
.p-code-del { background: #fee2e2; box-shadow: inset 5px 0 0 #dc2626; }
.p-code-hunk { color: #6366f1; }
.p-term { position: relative; display: flex; flex-direction: column; margin: 0; padding: 0; background: #0f172a; border: 4px solid var(--ink); border-radius: 18px; box-shadow: 10px 10px 0 var(--ink); overflow: hidden;
  white-space: pre; text-align: left; font: 500 22px/1.5 var(--font-mono); color: #e2e8f0; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; }
.p-term-bar { flex: none; display: flex; align-items: center; gap: 14px; height: 46px; padding: 0 16px; background: #1e293b; border-bottom: 3px solid var(--ink); font: 700 22px/1 var(--font-mono); color: #94a3b8; }
.p-term-lights { display: inline-flex; gap: 8px; }
.p-term-lights i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #0f172a; background: #f87171; }
.p-term-lights i:nth-child(2) { background: #fbbf24; } .p-term-lights i:nth-child(3) { background: #4ade80; }
.p-term-body { display: block; padding: 16px 22px 18px; }
.p-term-line { display: block; width: max-content; min-height: 1.5em; }
.p-term-cmd { color: #f8fafc; font-weight: 700; }
.p-term-ps { color: #4ade80; }
.p-term-out { color: #cbd5e1; }
`;
