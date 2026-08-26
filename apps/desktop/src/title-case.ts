/** Initialisms and product names that ordinary word capitalization mangles. */
const SPECIAL_WORDS: Readonly<Record<string, string>> = {
  api: "API",
  cli: "CLI",
  cpu: "CPU",
  gpu: "GPU",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  json: "JSON",
  mcp: "MCP",
  sdk: "SDK",
  sql: "SQL",
  sqlite: "SQLite",
  ui: "UI",
  url: "URL",
};

/**
 * Present a schema-authored setting label using native settings-title casing.
 * Existing internal capitals are preserved so names such as macOS stay intact.
 */
export function titleCaseSettingName(label: string): string {
  return label.replace(/[\p{L}\p{N}]+/gu, (word) => {
    const special = SPECIAL_WORDS[word.toLocaleLowerCase()];
    if (special !== undefined) return special;
    if (/\p{Lu}/u.test(word.slice(1))) return word;
    return `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`;
  });
}
