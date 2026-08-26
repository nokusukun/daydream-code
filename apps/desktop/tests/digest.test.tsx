import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DIGEST_CHUNK_CHARS, digestChunks } from "../src/master.js";
import { Markdown } from "../src/prose.js";
import { Digest } from "../src/views/MasterThread.js";

const line = (n: number, len = 100): string => `${n}. ${"x".repeat(len)}`;

describe("digestChunks", () => {
  it("returns nothing for an empty digest", () => {
    expect(digestChunks("")).toEqual([]);
  });

  it("leaves a digest that already fits as one chunk", () => {
    const text = [line(1), line(2), line(3)].join("\n");
    expect(digestChunks(text)).toEqual([text]);
  });

  it("bounds every chunk, which is the whole point", () => {
    // The measured worst case on this project's own thread was ~80k chars.
    const text = Array.from({ length: 800 }, (_, i) => line(i)).join("\n");
    const chunks = digestChunks(text);
    expect(chunks.length).toBeGreaterThan(10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DIGEST_CHUNK_CHARS + 200);
    }
  });

  it("loses no line", () => {
    const lines = Array.from({ length: 300 }, (_, i) => line(i));
    const rejoined = digestChunks(lines.join("\n")).join("\n").split("\n");
    expect(rejoined).toEqual(lines);
  });

  it("never splits a line, even one longer than a chunk", () => {
    const huge = "y".repeat(DIGEST_CHUNK_CHARS * 2);
    const chunks = digestChunks([line(1), huge, line(2)].join("\n"));
    expect(chunks.some((c) => c.includes(huge))).toBe(true);
  });

  it("closes a fence a chunk ends inside of, and reopens it in the next", () => {
    // Session summaries carry fenced blocks, so a digest split mid-fence is
    // the ordinary case: without this the rest of the chunk renders as code
    // and a stray closer leaks into the one after it.
    const body = Array.from({ length: 200 }, (_, i) => line(i, 60)).join("\n");
    const chunks = digestChunks(`intro\n\`\`\`ts\n${body}\n\`\`\`\ntail`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.split("\n").filter((l) => l.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith("```ts")).toBe(true);
  });

  it("balances fences across a digest of several fenced summaries", () => {
    const summary = (i: number): string =>
      [`session ${i} ended.`, "```bash", "pnpm test", "```", line(i, 400)].join("\n");
    const chunks = digestChunks(
      Array.from({ length: 60 }, (_, i) => summary(i)).join("\n"),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.split("\n").filter((l) => l.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
  });
});

describe("Digest", () => {
  const digest = [
    "[memory compaction] The following replaces all earlier master-thread entries:",
    ...Array.from({ length: 400 }, (_, i) => `session ${i} ended. ${line(i, 200)}`),
  ].join("\n");

  it("renders one chunk, not the whole digest", () => {
    // The point of the component: an expanded digest must not put every fact
    // it carries into the document at once. Measured on this project's own
    // thread, the whole of one renders to ~230 kB of markup in a row inside a
    // scrolling timeline.
    const chunks = digestChunks(digest);
    const whole = renderToStaticMarkup(<Markdown text={digest} />);
    const paged = renderToStaticMarkup(<Digest text={digest} />);

    expect(chunks.length).toBeGreaterThan(5);
    expect(paged.length).toBeLessThan(whole.length / 4);
    expect(paged).toContain(`continue reading the digest (1 of ${chunks.length})`);
    expect(paged).toContain("session 0 ended.");
    expect(paged).not.toContain("session 399 ended.");
  });

  it("says where the superseded entries went", () => {
    // The digest is a working set; the rows it replaced are all still served.
    expect(renderToStaticMarkup(<Digest text={digest} />)).toContain("full history");
  });

  it("offers no paging when the digest already fits", () => {
    const html = renderToStaticMarkup(<Digest text="[memory compaction] one fact" />);
    expect(html).not.toContain("continue reading");
  });
});
