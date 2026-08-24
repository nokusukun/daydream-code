/**
 * The renderers for the two parsers next door: markdown to React elements,
 * tokens to spans.
 *
 * Nothing here builds a string of HTML. Model output and command output are
 * untrusted, so they only ever reach the DOM as text nodes React escapes.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  highlight,
  normalizeLang,
  parseAnsi,
  hasAnsi,
  type Language,
  type Token,
} from "./highlight.js";
import {
  parseMarkdown,
  parseInline,
  looksLikeMarkdown,
  type Block,
  type Inline,
} from "./markdown.js";

/* ==========================================================================
   Code
   ========================================================================== */

/** Highlighted tokens as spans, for a caller that owns its own container. */
export function Tokens(props: { tokens: readonly Token[] }): ReactNode {
  return <>{tokenSpans(props.tokens as Token[])}</>;
}

function tokenSpans(tokens: Token[]): ReactNode[] {
  return tokens.map((token, i) =>
    token.kind === "plain" ? (
      token.text
    ) : (
      <span key={i} className={`t-${token.kind}`}>
        {token.text}
      </span>
    ),
  );
}

/** Highlighted code. `wrap` is for a shell command, which should never scroll. */
export function Code(props: {
  code: string;
  lang: Language;
  wrap?: boolean;
}): ReactNode {
  const tokens = useMemo(() => highlight(props.code, props.lang), [props.code, props.lang]);
  return (
    <pre className={`code${props.wrap === true ? " code-wrap" : ""}`}>
      <code>{tokenSpans(tokens)}</code>
    </pre>
  );
}

const COPY_LABEL = { idle: "copy", copied: "copied", failed: "can't copy" } as const;

function CopyButton(props: { text: string }): ReactNode {
  const [state, setState] = useState<keyof typeof COPY_LABEL>("idle");
  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = setTimeout(() => setState("idle"), 1400);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={`copy${state === "failed" ? " copy-failed" : ""}`}
      title="Copy to the clipboard"
      onClick={() => {
        // Clipboard access can be denied by policy or a lost focus. A button
        // that says nothing on failure reads as a broken button.
        void navigator.clipboard.writeText(props.text).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
    >
      {COPY_LABEL[state]}
    </button>
  );
}

/** A fenced block: the language it claims, the code, and a way to take it. */
export function Fence(props: { lang: string | null; text: string }): ReactNode {
  const language = normalizeLang(props.lang);
  return (
    <div className={`fence fence-${language}`}>
      <div className="fence-bar">
        {props.lang !== null && <span className="fence-lang">{props.lang}</span>}
        <CopyButton text={props.text} />
      </div>
      <Code code={props.text} lang={language} />
    </div>
  );
}

/**
 * Command output. A shell writes colour, and a transcript that shows the raw
 * escape bytes is worse than one that drops them — so the SGR is rendered and
 * everything else (cursor moves, clears) is thrown away.
 */
export function Output(props: { text: string; className?: string }): ReactNode {
  const spans = useMemo(
    () => (hasAnsi(props.text) ? parseAnsi(props.text) : null),
    [props.text],
  );
  const className = `output${props.className === undefined ? "" : ` ${props.className}`}`;

  if (spans === null) return <pre className={className}>{props.text}</pre>;
  return (
    <pre className={className}>
      {spans.map((span, i) =>
        span.color === null && !span.bold && !span.dim ? (
          span.text
        ) : (
          <span
            key={i}
            className={[
              span.color === null ? null : `a-${span.color}`,
              span.bold ? "a-bold" : null,
              span.dim ? "a-dim" : null,
            ]
              .filter((c) => c !== null)
              .join(" ")}
          >
            {span.text}
          </span>
        ),
      )}
    </pre>
  );
}

/* ==========================================================================
   Markdown
   ========================================================================== */

function inlines(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={i} className="md-code">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={i}>{inlines(node.children)}</strong>;
      case "em":
        return <em key={i}>{inlines(node.children)}</em>;
      case "strike":
        return <s key={i}>{inlines(node.children)}</s>;
      case "link":
        // The renderer has no navigation of its own: the main process sends
        // window-open requests to the real browser, which is where a link out
        // of a transcript belongs.
        return (
          <a key={i} href={node.href} target="_blank" rel="noreferrer noopener">
            {inlines(node.children)}
          </a>
        );
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  });
}

function blocks(list: Block[]): ReactNode[] {
  return list.map((block, i) => {
    switch (block.kind) {
      case "paragraph":
        return <p key={i}>{inlines(block.children)}</p>;
      case "heading": {
        // Transcript headings are section markers inside a bubble, not page
        // titles, so they start two levels down: an `h1` in model output must
        // not outrank the panel's own heading.
        const children = inlines(block.children);
        const style = `md-h md-h${block.level}`;
        if (block.level <= 1) return <h3 key={i} className={style}>{children}</h3>;
        if (block.level === 2) return <h4 key={i} className={style}>{children}</h4>;
        if (block.level === 3) return <h5 key={i} className={style}>{children}</h5>;
        return <h6 key={i} className={style}>{children}</h6>;
      }
      case "fence":
        return <Fence key={i} lang={block.lang} text={block.text} />;
      case "quote":
        return (
          <blockquote key={i} className="md-quote">
            {blocks(block.children)}
          </blockquote>
        );
      case "list":
        return block.ordered ? (
          <ol key={i} start={block.start} className="md-list">
            {block.items.map((item, j) => (
              <li key={j}>{item.length === 1 ? tight(item[0]!) : blocks(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="md-list">
            {block.items.map((item, j) => (
              <li key={j}>{item.length === 1 ? tight(item[0]!) : blocks(item)}</li>
            ))}
          </ul>
        );
      case "table":
        return (
          <div key={i} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {block.head.map((cell, j) => (
                    <th key={j} style={align(block.align[j])}>
                      {inlines(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      <td key={k} style={align(block.align[k])}>
                        {inlines(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "rule":
        return <hr key={i} className="md-rule" />;
      default: {
        const exhaustive: never = block;
        return exhaustive;
      }
    }
  });
}

function align(value: "left" | "center" | "right" | null | undefined): {
  textAlign?: "left" | "center" | "right";
} {
  return value === null || value === undefined ? {} : { textAlign: value };
}

/** A one-paragraph list item renders without the `<p>`, so lists stay tight. */
function tight(block: Block): ReactNode {
  return block.kind === "paragraph" ? inlines(block.children) : blocks([block]);
}

/**
 * Render markdown. Prose that contains no markdown at all skips the parse and
 * renders as preserved-whitespace text — most turns are a sentence, and a
 * paragraph pass would only cost their line breaks.
 */
/**
 * Inline markdown only — emphasis, code spans, links — with no block wrapper.
 *
 * For a one-line summary that has to stay one line: `Markdown` would wrap the
 * text in a paragraph and defeat the caller's line clamp, and a collapsed lede
 * is a sentence fragment anyway, so block syntax in it would be a truncated
 * half of something rather than a list or a heading.
 */
export function InlineMarkdown(props: { text: string }): ReactNode {
  const nodes = useMemo(() => parseInline(props.text), [props.text]);
  return <>{inlines(nodes)}</>;
}

export function Markdown(props: { text: string; className?: string }): ReactNode {
  const parsed = useMemo(
    () => (looksLikeMarkdown(props.text) ? parseMarkdown(props.text) : null),
    [props.text],
  );
  const className = `md${props.className === undefined ? "" : ` ${props.className}`}`;

  if (parsed === null) return <div className={`${className} md-plain`}>{props.text}</div>;
  return <div className={className}>{blocks(parsed)}</div>;
}
