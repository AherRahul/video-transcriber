// A small, safe Markdown renderer for Claude's chat messages and the Script dialog's documents. It builds
// React elements (never HTML strings), so nothing in a message can inject markup.
//
// Blocks: headings, paragraphs, bullet and numbered lists (an indented item is a sub-item), tables,
// fenced code. Inline: **bold**, *italic*, `code`, [links](https://...) and bare https:// addresses,
// which open in a new tab. With `cues`, <cue/> marks in a script become small pins.

import { Fragment, type ReactNode } from "react";

// one inline token: bold, code, a Markdown link (one level of parentheses allowed inside its address,
// as in Wikipedia links), a bare address, italic, or a cue mark
const INLINE =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+\)|https?:\/\/[^\s<>]+|(?<![*\w])\*[^*\s][^*\n]*?\*(?![*\w])|<cue\s*\/>)/g;

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Splits a bare address from punctuation that follows it in a sentence ("see https://x.io/a." or "(https://x.io)"). */
function trimUrl(url: string): [string, string] {
  let end = url.length;
  while (end > 0 && /[.,;:!?'"]/.test(url[end - 1])) end--;
  // a closing bracket that has no opening one in the address belongs to the sentence
  while (end > 0 && url[end - 1] === ")" && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end--;
  return [url.slice(0, end), url.slice(end)];
}

function inline(text: string, cues: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const tok = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + tok.length;
    if (tok.startsWith("**")) out.push(<strong key={k++}>{inline(tok.slice(2, -2), cues)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      out.push(
        <Link key={k++} href={tok.slice(close + 2, -1)}>
          {inline(tok.slice(1, close), cues)}
        </Link>,
      );
    } else if (tok.startsWith("http")) {
      const [url, rest] = trimUrl(tok);
      out.push(
        <Link key={k++} href={url}>
          {url}
        </Link>,
      );
      if (rest) out.push(rest);
    } else if (/^<cue/.test(tok)) {
      out.push(
        cues ? (
          <span key={k++} className="mo-cue" title="A cue: the picture reacts here">
            ▸
          </span>
        ) : (
          tok
        ),
      );
    } else out.push(<em key={k++}>{inline(tok.slice(1, -1), cues)}</em>);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export default function Markdown({ text, cues = false, className }: { text: string; cues?: boolean; className?: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let i = 0;
  const flushPara = () => {
    if (!para.length) return;
    const p = para;
    blocks.push(
      <p key={`p${blocks.length}`}>
        {p.map((l, j) => (
          <Fragment key={j}>
            {j > 0 ? <br /> : null}
            {inline(l, cues)}
          </Fragment>
        ))}
      </p>,
    );
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    if (/^\s*```/.test(line)) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={`c${blocks.length}`} className="mo-md-pre">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      const content = inline(h[2].replace(/\s#+\s*$/, ""), cues);
      blocks.push(level === 1 ? <h2 key={`h${blocks.length}`}>{content}</h2> : level === 2 ? <h3 key={`h${blocks.length}`}>{content}</h3> : <h4 key={`h${blocks.length}`}>{content}</h4>);
      i++;
      continue;
    }
    // table: a header row, a rule, then rows
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flushPara();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={`t${blocks.length}`} className="mo-md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, cues)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, n) => (
                    <td key={n}>{inline(c, cues)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // list: consecutive items (an indented item is a sub-item; a line under an item continues it)
    const li = LIST_ITEM.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          items.push({ depth: m[1].replace(/\t/g, "  ").length >= 2 ? 1 : 0, text: m[3] });
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1].text += " " + lines[i].trim();
          i++;
        } else break;
      }
      const list = items.map((it, j) => (
        <li key={j} className={it.depth ? "sub" : undefined}>
          {inline(it.text, cues)}
        </li>
      ));
      blocks.push(ordered ? <ol key={`l${blocks.length}`}>{list}</ol> : <ul key={`l${blocks.length}`}>{list}</ul>);
      continue;
    }
    if (!line.trim()) flushPara();
    else para.push(line);
    i++;
  }
  flushPara();
  return <div className={className}>{blocks}</div>;
}
