// Lightweight extension -> Monaco language id mapping. Monaco can also infer
// from contents, but seeding by extension gives correct highlighting on first
// paint without a worker round-trip.
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  dockerfile: "dockerfile",
};

export function languageFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  if (base.toLowerCase() === "dockerfile") {
    return "dockerfile";
  }
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    return "plaintext";
  }
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}
