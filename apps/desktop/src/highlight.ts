/**
 * A tokenizer for the handful of languages a coding transcript actually
 * contains, plus an SGR reader for the ANSI a shell command writes.
 *
 * Like the markdown parser next door, this emits tokens rather than HTML —
 * the renderer maps a token kind to a class, so highlighting untrusted output
 * never involves building markup out of it.
 *
 * Each grammar is an ordered rule list, matched at the cursor with sticky
 * regexes. Order is the grammar: comments and strings must win before
 * operators, or a `#` inside a string starts a comment. Anything that matches
 * no rule is consumed as one plain character, so a tokenizer can never fail —
 * the worst case is unhighlighted text.
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "command"
  | "builtin"
  | "variable"
  | "flag"
  | "operator"
  | "property"
  | "insert"
  | "delete"
  | "meta";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export type Language = "shell" | "js" | "json" | "python" | "diff" | "yaml" | "text";

interface Rule {
  readonly kind: TokenKind;
  /** Sticky, so it can only match at the cursor. */
  readonly re: RegExp;
}

const ALIASES: Record<string, Language> = {
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  shellsession: "shell",
  command: "shell",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  javascript: "js",
  typescript: "js",
  json: "json",
  jsonc: "json",
  py: "python",
  python: "python",
  diff: "diff",
  patch: "diff",
  yml: "yaml",
  yaml: "yaml",
};

export function normalizeLang(lang: string | null | undefined): Language {
  if (lang === null || lang === undefined) return "text";
  return ALIASES[lang.trim().toLowerCase()] ?? "text";
}

/** Guess a language from a file path, for tool calls that name one. */
export function langOfPath(path: string): Language {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1];
  return normalizeLang(ext);
}

const SHELL_KEYWORDS =
  /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|time|return|break|continue)\b/;

/**
 * Shell, with one piece of state: whether the cursor sits where a command name
 * would go. That is what makes `git status` read as a verb plus its arguments
 * instead of two identical words, and it is the whole reason this file exists
 * rather than a flat keyword list.
 */
function shellTokens(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let atCommand = true;

  while (i < source.length) {
    const rest = source.slice(i);

    // A `$` prompt at the start of a line is transcript chrome, not argv.
    const prompt = /^(\s*)([$#>])(\s)/.exec(rest);
    if (prompt !== null && (i === 0 || source[i - 1] === "\n")) {
      if (prompt[1]!.length > 0) out.push({ kind: "plain", text: prompt[1]! });
      out.push({ kind: "operator", text: prompt[2]! });
      out.push({ kind: "plain", text: prompt[3]! });
      i += prompt[0].length;
      atCommand = true;
      continue;
    }

    const comment = /^#[^\n]*/.exec(rest);
    if (comment !== null && (i === 0 || /[\s;|&(]/.test(source[i - 1]!))) {
      out.push({ kind: "comment", text: comment[0] });
      i += comment[0].length;
      continue;
    }

    const heredoc = /^<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(rest);
    if (heredoc !== null) {
      const end = new RegExp(`\\n\\s*${heredoc[1]!}\\s*(\\n|$)`).exec(source.slice(i));
      const stop = end === null ? source.length : i + end.index + end[0].length;
      out.push({ kind: "operator", text: heredoc[0] });
      out.push({ kind: "string", text: source.slice(i + heredoc[0].length, stop) });
      i = stop;
      atCommand = true;
      continue;
    }

    const string = /^(?:'[^']*'?|"(?:\\.|[^"\\])*"?)/.exec(rest);
    if (string !== null && string[0].length > 0) {
      out.push({ kind: "string", text: string[0] });
      i += string[0].length;
      continue;
    }

    const variable = /^\$(?:\{[^}]*\}?|[A-Za-z_]\w*|[0-9?@#*!$-])/.exec(rest);
    if (variable !== null) {
      out.push({ kind: "variable", text: variable[0] });
      i += variable[0].length;
      atCommand = false;
      continue;
    }

    const flag = /^--?[A-Za-z0-9][\w-]*/.exec(rest);
    if (flag !== null && (i === 0 || /[\s(]/.test(source[i - 1]!)) && !atCommand) {
      out.push({ kind: "flag", text: flag[0] });
      i += flag[0].length;
      continue;
    }

    const operator = /^(?:\|\||&&|>>|2>&1|[|&;<>()={}]|\$\()/.exec(rest);
    if (operator !== null) {
      out.push({ kind: "operator", text: operator[0] });
      i += operator[0].length;
      // Everything that ends a command starts the next one.
      atCommand = !/^[)}=]/.test(operator[0]);
      continue;
    }

    const word = /^[^\s|&;<>()'"`$#]+/.exec(rest);
    if (word !== null) {
      const text = word[0];
      // A builtin list would split command position into two colours — `echo`
      // one hue, `git` another — for words that play the identical role. The
      // position is the signal, so it is the only thing that decides.
      const kind: TokenKind = SHELL_KEYWORDS.test(text)
        ? "keyword"
        : atCommand
          ? "command"
          : /^-?\d+(?:\.\d+)?$/.test(text)
            ? "number"
            : "plain";
      out.push({ kind, text });
      i += text.length;
      // `sudo git push` and `VAR=1 make` keep the next word in command
      // position; anything else has consumed it.
      atCommand = SHELL_KEYWORDS.test(text) || /^\w+=/.test(text) || text === "sudo";
      continue;
    }

    const space = /^[ \t]+/.exec(rest);
    if (space !== null) {
      out.push({ kind: "plain", text: space[0] });
      i += space[0].length;
      continue;
    }
    if (rest.startsWith("\n")) {
      out.push({ kind: "plain", text: "\n" });
      i += 1;
      atCommand = true;
      continue;
    }

    out.push({ kind: "plain", text: source[i]! });
    i += 1;
  }

  return out;
}

const JS_RULES: Rule[] = [
  { kind: "comment", re: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
  { kind: "string", re: /`(?:\\.|[^`\\])*`?|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y },
  {
    kind: "keyword",
    re: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|yield|delete|void|interface|type|enum|implements|readonly|as|satisfies|declare|namespace|public|private|protected|static|abstract)\b/y,
  },
  { kind: "builtin", re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/y },
  { kind: "number", re: /\b0[xXbBoO][\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?n?\b/y },
  { kind: "property", re: /(?<=\.)[A-Za-z_$][\w$]*/y },
  { kind: "command", re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
  { kind: "operator", re: /=>|[+\-*/%=<>!&|?:~^]+/y },
  { kind: "plain", re: /[A-Za-z_$][\w$]*|\s+/y },
];

const JSON_RULES: Rule[] = [
  { kind: "property", re: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
  { kind: "string", re: /"(?:\\.|[^"\\])*"?/y },
  { kind: "builtin", re: /\b(?:true|false|null)\b/y },
  { kind: "number", re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/y },
  { kind: "operator", re: /[{}[\],:]/y },
  { kind: "plain", re: /\s+/y },
];

const PYTHON_RULES: Rule[] = [
  { kind: "comment", re: /#[^\n]*/y },
  {
    kind: "string",
    re: /[rbf]?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y,
  },
  { kind: "meta", re: /@[A-Za-z_][\w.]*/y },
  {
    kind: "keyword",
    re: /\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|raise|yield|lambda|pass|break|continue|global|nonlocal|assert|async|await|del|in|is|not|and|or)\b/y,
  },
  { kind: "builtin", re: /\b(?:True|False|None|self|cls|print|len|range|dict|list|set|str|int|float|bool)\b/y },
  { kind: "number", re: /\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b/y },
  { kind: "command", re: /[A-Za-z_]\w*(?=\s*\()/y },
  { kind: "operator", re: /[+\-*/%=<>!&|^~]+|[:,.[\]{}()]/y },
  { kind: "plain", re: /[A-Za-z_]\w*|\s+/y },
];

const YAML_RULES: Rule[] = [
  { kind: "comment", re: /#[^\n]*/y },
  { kind: "property", re: /(?<=^|\n)[ \t]*-?[ \t]*[\w.$-]+(?=:(?:\s|$))/y },
  { kind: "string", re: /"(?:\\.|[^"\\])*"?|'[^']*'?/y },
  { kind: "builtin", re: /\b(?:true|false|null|yes|no|on|off|~)\b/y },
  { kind: "number", re: /\b\d+(?:\.\d+)?\b/y },
  { kind: "operator", re: /[:|>&*-]/y },
  { kind: "plain", re: /[^\s#"':|>&*-]+|\s+/y },
];

/** Diff is line-oriented, so it skips the rule engine entirely. */
function diffTokens(source: string): Token[] {
  return source.split(/(?<=\n)/).map((line): Token => {
    if (/^(?:\+\+\+|---|diff |index |@@)/.test(line)) return { kind: "meta", text: line };
    if (line.startsWith("+")) return { kind: "insert", text: line };
    if (line.startsWith("-")) return { kind: "delete", text: line };
    return { kind: "plain", text: line };
  });
}

function runRules(source: string, rules: Rule[]): Token[] {
  const out: Token[] = [];
  let i = 0;

  outer: while (i < source.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const match = rule.re.exec(source);
      if (match === null || match[0].length === 0) continue;
      out.push({ kind: rule.kind, text: match[0] });
      i += match[0].length;
      continue outer;
    }
    out.push({ kind: "plain", text: source[i]! });
    i += 1;
  }

  return out;
}

/** Adjacent same-kind tokens collapse, so the renderer emits fewer spans. */
function merge(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === token.kind) {
      out[out.length - 1] = { kind: last.kind, text: last.text + token.text };
    } else out.push(token);
  }
  return out;
}

export function highlight(source: string, lang: Language): Token[] {
  if (source.length === 0) return [];
  switch (lang) {
    case "shell":
      return merge(shellTokens(source));
    case "js":
      return merge(runRules(source, JS_RULES));
    case "json":
      return merge(runRules(source, JSON_RULES));
    case "python":
      return merge(runRules(source, PYTHON_RULES));
    case "yaml":
      return merge(runRules(source, YAML_RULES));
    case "diff":
      return merge(diffTokens(source));
    case "text":
      return [{ kind: "plain", text: source }];
    default: {
      const exhaustive: never = lang;
      return [{ kind: "plain", text: exhaustive }];
    }
  }
}

/* ==========================================================================
   ANSI
   ========================================================================== */

/** 16 terminal colours plus bold/dim; the renderer maps each to a CSS var. */
export interface AnsiSpan {
  readonly text: string;
  readonly color: number | null;
  readonly bold: boolean;
  readonly dim: boolean;
}

const SGR = /\u001B\[([0-9;]*)m/g;
// Everything else a program can emit: cursor moves, clears, OSC titles,
// bracketed paste. None of it means anything in a transcript.
const NOISE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]|\u001B\[[0-9;?]*[ -/]*[@-l n-~]|[\u000E\u000F]|\r(?!\n)/g;

export function hasAnsi(text: string): boolean {
  return text.includes("\u001B") || text.includes("\r");
}

export function stripAnsi(text: string): string {
  return text.replace(SGR, "").replace(NOISE, "");
}

/**
 * Read SGR into spans. Unsupported codes reset nothing and colour nothing,
 * which is the failure mode you want: plain text, never stray escape bytes.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let color: number | null = null;
  let bold = false;
  let dim = false;
  let at = 0;

  const push = (chunk: string): void => {
    const clean = chunk.replace(NOISE, "");
    if (clean.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.color === color && last.bold === bold && last.dim === dim) {
      out[out.length - 1] = { text: last.text + clean, color, bold, dim };
    } else out.push({ text: clean, color, bold, dim });
  };

  SGR.lastIndex = 0;
  for (let match = SGR.exec(text); match !== null; match = SGR.exec(text)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;
    const codes = match[1]!.length === 0 ? [0] : match[1]!.split(";").map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]!;
      if (code === 0) {
        color = null;
        bold = false;
        dim = false;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) color = null;
      // 38 sets the foreground, 48 the background, and both take the same
      // extended parameters — so both must consume them. A `48;2;30;40;50`
      // whose bytes land in the 30-37 range would otherwise repaint the text.
      else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
        // 256-colour: fold the 16 ANSI slots, ignore the rest of the cube.
        const index = codes[i + 2];
        if (code === 38) color = index !== undefined && index < 16 ? index : null;
        i += 2;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2) i += 4;
      else if (code >= 30 && code <= 37) color = code - 30;
      else if (code >= 90 && code <= 97) color = code - 90 + 8;
    }
  }
  push(text.slice(at));
  return out;
}

/**
 * The same tokens, grouped per source line.
 *
 * A line-numbered view has to emit one row per line, but tokenizing line by
 * line would break every construct that spans one — a block comment, a
 * template literal, a heredoc. So the file is tokenized whole and the tokens
 * are cut afterwards, which is the only order that gets both right.
 */
export function highlightLines(source: string, lang: Language): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of highlight(source, lang)) {
    const parts = token.text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([]);
      const text = parts[i]!;
      if (text.length > 0) lines[lines.length - 1]!.push({ kind: token.kind, text });
    }
  }
  return lines;
}
