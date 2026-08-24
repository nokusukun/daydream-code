/**
 * A CommonMark subset, parsed to an AST.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *   1. It parses to nodes, not to an HTML string. Everything rendered in the
 *      transcript is model output or tool output — untrusted text. An AST that
 *      the renderer turns into React elements means `dangerouslySetInnerHTML`
 *      never appears, so there is no escaping bug to get wrong later.
 *   2. It is not a dependency. The rest of this repo runs on the standard
 *      library, and the grammar a coding transcript actually uses — fences,
 *      lists, headings, tables, inline code, links — fits in one file that can
 *      be unit tested without a DOM.
 *
 * What it deliberately does not do: reference links, HTML blocks, setext
 * headings, footnotes. Unsupported syntax degrades to the literal text rather
 * than disappearing.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "fence"; lang: string | null; text: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)][ \t]+)(.*)$/;
const DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** True when `line` would open a block, i.e. a paragraph must stop before it. */
function opensBlock(line: string): boolean {
  return (
    line.trim().length === 0 ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

/**
 * Quotes and list items recurse, and `"> ".repeat(4000)` is 8k of legal text
 * that a model could plausibly emit. Past this depth the remainder renders as
 * one paragraph — degraded, but the alternative is a stack overflow that takes
 * the whole transcript down, since nothing here sits behind an error boundary.
 */
const MAX_NEST = 16;

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"));
}

function parseBlocks(lines: string[], depth = 0): Block[] {
  if (depth > MAX_NEST) {
    return [{ kind: "paragraph", children: parseInline(lines.join("\n")) }];
  }

  const out: Block[] = [];
  let i = 0;
  let last = -1;

  while (i < lines.length) {
    // Backstop. Every branch below must consume at least one line; twice now a
    // change has made one of them able to return without doing so, and the
    // symptom is not a wrong parse, it is a frozen renderer and a dead app.
    // If it happens again, the offending line renders as text instead.
    if (i === last) {
      out.push({ kind: "paragraph", children: parseInline(lines[i]!) });
      i += 1;
      continue;
    }
    last = i;

    const line = lines[i]!;

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      // An unterminated fence runs to the end of the input rather than
      // swallowing the rest as a paragraph: streaming output opens a fence
      // long before it closes one, and half a code block still reads as code.
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]!);
        if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i += 1;
          break;
        }
        body.push(lines[i]!);
        i += 1;
      }
      const lang = fence[2]!.length > 0 ? fence[2]! : null;
      out.push({ kind: "fence", lang, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      out.push({
        kind: "heading",
        level: heading[1]!.length,
        children: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]!) || lines[i]!.trim().length > 0)) {
        if (!QUOTE.test(lines[i]!) && opensBlock(lines[i]!)) break;
        body.push(lines[i]!.replace(QUOTE, ""));
        i += 1;
      }
      out.push({ kind: "quote", children: parseBlocks(body, depth + 1) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i, depth);
      out.push(list);
      i = next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && DELIMITER.test(lines[i + 1]!)) {
      const [table, next] = parseTable(lines, i);
      if (table !== null) {
        out.push(table);
        i = next;
        continue;
      }
    }

    const paragraph: string[] = [];
    while (i < lines.length && !opensBlock(lines[i]!)) {
      // "Results:" followed straight by a table is the shape models write, so
      // a delimiter row on the next line ends the paragraph here. Never on the
      // first line, or a table the branch above declined as malformed would
      // leave this loop having consumed nothing.
      if (
        paragraph.length > 0 &&
        lines[i]!.includes("|") &&
        DELIMITER.test(lines[i + 1] ?? "")
      ) {
        break;
      }
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    out.push({ kind: "paragraph", children: parseInline(paragraph.join("\n")) });
  }

  return out;
}

/**
 * A list runs until a line that is neither an item marker nor indented
 * continuation. Item bodies are parsed recursively, so a fenced block or a
 * nested list inside an item works without a second code path.
 */
function parseList(lines: string[], from: number, depth: number): [Block, number] {
  const first = BULLET.exec(lines[from]!) ?? ORDERED.exec(lines[from]!);
  const ordered = BULLET.exec(lines[from]!) === null;
  const start = ordered ? Number.parseInt(first![2]!, 10) : 1;
  const items: Block[][] = [];
  let body: string[] | null = null;
  let indent = 0;
  let i = from;

  const commit = (): void => {
    if (body !== null) items.push(parseBlocks(body, depth + 1));
    body = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const marker = ordered ? ORDERED.exec(line) : BULLET.exec(line);

    // A marker indented to at least the parent item's content column opens a
    // nested list *inside* the current item, so it is left for the recursive
    // parse; only a shallower one starts a sibling.
    if (marker !== null && (body === null || marker[1]!.length < indent)) {
      commit();
      indent = marker[1]!.length + marker[2]!.length + marker[3]!.length;
      body = [marker[4]!];
      i += 1;
      continue;
    }
    if (body === null) break;

    if (line.trim().length === 0) {
      // A blank line ends the list unless the next line continues an item.
      const next = lines[i + 1];
      if (next === undefined) break;
      const continues =
        next.startsWith(" ".repeat(indent)) ||
        (ordered ? ORDERED.test(next) : BULLET.test(next));
      if (!continues) break;
      body.push("");
      i += 1;
      continue;
    }
    // Indented continuation, or a lazy one: prose wrapped under an item.
    if (line.startsWith(" ".repeat(indent))) body.push(line.slice(indent));
    else if (!opensBlock(line)) body.push(line.trim());
    else break;
    i += 1;
  }

  commit();
  return [{ kind: "list", ordered, start, items }, i];
}

function parseTable(lines: string[], from: number): [Block | null, number] {
  const head = splitRow(lines[from]!);
  const align = splitRow(lines[from + 1]!).map((cell): Align => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  if (head.length === 0 || align.length !== head.length) return [null, from];

  const rows: Inline[][][] = [];
  let i = from + 2;
  while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim().length > 0) {
    const cells = splitRow(lines[i]!);
    // Ragged rows are padded to the header width rather than dropped: a short
    // last row is the normal shape of a table still streaming in. Cells past
    // the header width are dropped, which is what GFM does too.
    rows.push(
      Array.from({ length: head.length }, (_, c) => parseInline(cells[c] ?? "")),
    );
    i += 1;
  }
  return [
    { kind: "table", align, head: head.map(parseInline), rows },
    i,
  ];
}

/** Split on unescaped pipes, dropping the leading and trailing empty cell. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === "\\" && line[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (char === "|") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  if (cells[0]!.trim().length === 0) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim().length === 0) cells.pop();
  return cells.map((c) => c.trim());
}

/* ==========================================================================
   Inline
   ========================================================================== */

const PUNCTUATION = /[\\`*_{}[\]()#+\-.!|~<>]/;
const BARE_URL = /^https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/;
/**
 * Anything else — `javascript:`, `data:`, `file:` — renders as plain text.
 * The renderer hands hrefs to a real browser navigation, so the allowlist is
 * the whole defence.
 */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#)/i;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = (): void => {
    if (text.length > 0) out.push({ kind: "text", text });
    text = "";
  };
  const push = (node: Inline, end: number): void => {
    flush();
    out.push(node);
    i = end;
  };

  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];

    if (char === "\\" && next !== undefined && PUNCTUATION.test(next)) {
      text += next;
      i += 2;
      continue;
    }

    if (char === "`") {
      const code = matchCode(source, i);
      if (code !== null) {
        push({ kind: "code", text: code.text }, code.end);
        continue;
      }
      const run = runOf(source, i, char);
      text += run;
      i += run.length;
      continue;
    }

    // An image renders as its link: the transcript has no room for remote
    // images, and the alt text is the part worth reading anyway.
    if (char === "!" && next === "[") {
      const link = matchLink(source, i + 1);
      if (link !== null) {
        push(link.node, link.end);
        continue;
      }
    }

    if (char === "[") {
      const link = matchLink(source, i);
      if (link !== null) {
        push(link.node, link.end);
        continue;
      }
      // No closing bracket anywhere ahead means no later `[` can close either,
      // so the rest is text and there is nothing left to rescan.
      if (!source.includes("]", i)) {
        text += source.slice(i);
        i = source.length;
        continue;
      }
    }

    if (char === "<") {
      const close = source.indexOf(">", i);
      const inner = close === -1 ? "" : source.slice(i + 1, close);
      if (close !== -1 && /^(?:https?:\/\/|mailto:)\S+$/.test(inner)) {
        push({ kind: "link", href: inner, children: [{ kind: "text", text: inner }] }, close + 1);
        continue;
      }
    }

    if (char === "h" && (i === 0 || /[\s(]/.test(source[i - 1]!))) {
      const url = BARE_URL.exec(source.slice(i));
      if (url !== null) {
        const href = url[0];
        push({ kind: "link", href, children: [{ kind: "text", text: href }] }, i + href.length);
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const emphasis = matchEmphasis(source, i);
      if (emphasis !== null) {
        push(emphasis.node, emphasis.end);
        continue;
      }
      const run = runOf(source, i, char);
      text += run;
      i += run.length;
      continue;
    }

    text += char;
    i += 1;
  }

  flush();
  return out;
}

/** The run of `char` starting at `at`. */
function runOf(source: string, at: number, char: string): string {
  let run = 0;
  while (source[at + run] === char) run += 1;
  return char.repeat(run);
}

/** A code span closes on a backtick run of exactly its own length. */
function matchCode(source: string, at: number): { text: string; end: number } | null {
  let open = 0;
  while (source[at + open] === "`") open += 1;
  const fence = "`".repeat(open);
  let from = at + open;
  for (;;) {
    const close = source.indexOf(fence, from);
    if (close === -1) return null;
    if (source[close + open] === "`") {
      from = close + open;
      while (source[from] === "`") from += 1;
      continue;
    }
    const text = source.slice(at + open, close);
    // CommonMark strips one space on each side so `` ` `` can hold a backtick.
    const stripped =
      text.length > 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim().length > 0
        ? text.slice(1, -1)
        : text;
    return { text: stripped, end: close + open };
  }
}

const LABEL_MAX = 1024;

function matchLink(source: string, at: number): { node: Inline; end: number } | null {
  let depth = 0;
  let close = -1;
  const limit = Math.min(source.length, at + LABEL_MAX);
  for (let i = at; i < limit; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "[") depth += 1;
    if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || source[close + 1] !== "(") return null;

  const end = source.indexOf(")", close + 2);
  if (end === -1) return null;
  const target = source.slice(close + 2, end).trim();
  const href = /^([^\s]+)(?:\s+["'(].*)?$/.exec(target)?.[1] ?? target;
  const label = source.slice(at + 1, close);
  if (!SAFE_HREF.test(href)) {
    // Not a link we will follow, but the label is still prose worth reading.
    return { node: { kind: "text", text: `${label} (${href})` }, end: end + 1 };
  }
  return { node: { kind: "link", href, children: parseInline(label) }, end: end + 1 };
}

/**
 * Emphasis, with the two guards that matter for a coding transcript:
 * `snake_case_identifiers` must not italicise, and an opener followed by
 * whitespace is not an opener (`a * b * c` is arithmetic, not emphasis).
 */
function matchEmphasis(source: string, at: number): { node: Inline; end: number } | null {
  const char = source[at]!;
  let run = 0;
  while (source[at + run] === char) run += 1;

  const width = char === "~" ? 2 : Math.min(run, 2);
  if (char === "~" && run < 2) return null;
  if (char === "_" && at > 0 && /[\w`]/.test(source[at - 1]!)) return null;

  const marker = char.repeat(width);
  const start = at + width;
  if (start >= source.length || /\s/.test(source[start]!)) return null;

  let from = start;
  for (;;) {
    const close = source.indexOf(marker, from);
    if (close === -1 || close === start) return null;
    const before = source[close - 1]!;
    const after = source[close + width];
    const wordInternal = char === "_" && after !== undefined && /\w/.test(after);
    if (/\s/.test(before) || wordInternal) {
      from = close + width;
      continue;
    }
    const children = parseInline(source.slice(start, close));
    const kind = char === "~" ? "strike" : width === 2 ? "strong" : "em";
    return { node: { kind, children }, end: close + width };
  }
}

/** Does this text want a markdown pass at all? Used to skip plain prose. */
export function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s|```)|`[^`\n]+`|\*\*|\[[^\]\n]+\]\(|\|.*\|/.test(
    text,
  );
}
