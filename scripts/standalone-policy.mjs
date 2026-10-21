import path from "node:path";

const FORBIDDEN_BASENAMES = new Set([
  ".git",
  ".runtime",
  "node_modules",
  "__pycache__",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
]);

export function isPublicCopyEntry(entry) {
  const basename = path.basename(entry);
  if (FORBIDDEN_BASENAMES.has(basename)) return false;
  if (/^\.env(?:\..+)?$/u.test(basename) && basename !== ".env.example") return false;
  return true;
}

export function createIsolatedEnvironment(temporaryHome) {
  return Object.freeze({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: temporaryHome,
    TMPDIR: temporaryHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    npm_config_userconfig: path.join(temporaryHome, ".npmrc"),
    npm_config_cache: path.join(temporaryHome, ".npm-cache"),
  });
}
