import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_FILES = Object.freeze([
  "README.md",
  "LICENSE",
  ".env.example",
  "package.json",
  "package-lock.json",
  "demo/index.html",
  "public/index.html",
  "src/config.mjs",
  "src/config-normalization.mjs",
  "src/encrypted-store.mjs",
  "src/http-server.mjs",
  "src/local-runtime.mjs",
  "src/wps-oauth.mjs",
  "src/wps-message-client.mjs",
  "src/openai-compatible.mjs",
  "src/public-workbench.mjs",
  "src/public-workbench-manifest.mjs",
  "scripts/setup-local.mjs",
  "scripts/start-local.mjs",
  "scripts/check-public-git.mjs",
  "docs/INSTALL.md",
  "docs/WPS-PERMISSIONS.md",
  "docs/MODEL-CONFIG.md",
  "docs/PRIVACY.md",
  "docs/ARCHITECTURE.md",
  "docs/PREVIEW-LIMITS.md",
]);

const TEXT_EXTENSIONS = new Set([".md", ".html", ".css", ".js", ".mjs", ".jsx", ".json", ".example", ".gitignore", ".txt"]);
const PYTHON_SOURCES = new Set(['src/context_refresh.py','scripts/refresh-context.py','test/context_refresh_test.py']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 10_000_000;
const PLACEHOLDER = /^(?:<[^>]+>|(?:your|replace|example|shared|independent|synthetic|test|fake)[_-]|\$\{|\*{3}|\/(?:kso_|gh\(\?:|authorization\[)|\/[^\r\n]+\/[a-z]*;?$)/iu;

const DOC_IMAGE_PATH = /^docs\/(?:assets|product\/assets\/screenshots|architecture\/assets)\/[^/]+\.(?:png|jpe?g)$/iu;
export function isPublicDocImage(relative, bytes) {
  if (!DOC_IMAGE_PATH.test(relative)) return false;
  if (/\.png$/iu.test(relative)) {
    if (bytes.length < 45 || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') return false;
    let offset=8, data=false, header=false;
    while (offset + 12 <= bytes.length) {
      const size=bytes.readUInt32BE(offset), type=bytes.subarray(offset+4,offset+8).toString('ascii');
      if (size > bytes.length-offset-12) return false;
      if (!header) {
        if (type !== 'IHDR' || size !== 13) return false;
        const width=bytes.readUInt32BE(offset+8),height=bytes.readUInt32BE(offset+12);
        if (!width || !height || width*height > 50000000) return false;
        header=true;
      }
      if (type === 'IDAT') data=true;
      offset+=12+size;
      if (type === 'IEND') return data && size === 0 && offset === bytes.length;
    }
    return false;
  }
  return bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
}

async function listFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === '__pycache__') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else files.push(child);
  }
  return files;
}

function addPatternFindings(findings, relative, content, extension) {
  const patterns = [
    ["private_absolute_path", /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/u],
    ["private_cloud_link", /https?:\/\/[^\s)"']*(?:feishu\.cn|kdocs\.cn)\/(?:docx|wiki|base|l)\/[^\s)"']+/iu],
    ["wps_access_token", /kso_(?:ac|rt)_[A-Za-z0-9._-]{12,}/u],
    ["github_token", /gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}/u],
    ["private_key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u],
    ["cookie_header", /(?:^|\n)\s*(?:cookie|set-cookie)\s*:\s*[^\n]+/iu],
  ];
  for (const [code, expression] of patterns) {
    if (expression.test(content)) findings.push({ code, file: relative });
  }

  const quotedAssignment = /(?:WPS_APP_ID|WPS_APP_KEY|WPS_ACCESS_TOKEN|WPS_REFRESH_TOKEN|WPS_SID|LLM_API_KEY|OAUTH_CODE|[A-Z0-9_]+_(?:TOKEN|SECRET|API_KEY|APP_KEY|OAUTH_CODE))[ \t]*[:=][ \t]*(["'`])([^"'`\r\n]{8,})\1/gu;
  for (const match of content.matchAll(quotedAssignment)) {
    const value = match[2];
    if (!PLACEHOLDER.test(value)) {
      findings.push({ code: "credential_assignment", file: relative });
      break;
    }
  }

  const bareAssignment = /(?:WPS_APP_ID|WPS_APP_KEY|WPS_ACCESS_TOKEN|WPS_REFRESH_TOKEN|WPS_SID|LLM_API_KEY|DEEPSEEK_API_KEY|OAUTH_CODE|[A-Z0-9_]+_(?:TOKEN|SECRET|API_KEY|APP_KEY|OAUTH_CODE))[ \t]*=[ \t]*([^\s"'`]+)/giu;
  for (const match of content.matchAll(bareAssignment)) {
    const value = match[1];
    if (!PLACEHOLDER.test(value)) {
      findings.push({ code: "credential_assignment", file: relative });
      break;
    }
  }

  const bearer = /authorization[ \t]*:[ \t]*bearer[ \t]+([A-Za-z0-9._~-]{12,})/giu;
  for (const match of content.matchAll(bearer)) {
    if (!/^(?:your|example|replace)/iu.test(match[1])) {
      findings.push({ code: "bearer_token_literal", file: relative });
      break;
    }
  }
}

export function scanReleaseText(relative, content, extension = ".txt") {
  const findings = [];
  addPatternFindings(findings, relative, content, extension);
  return findings;
}

export async function checkPublicRelease(root, options = {}) {
  const findings = [];
  let files;
  try {
    files = await listFiles(root);
  } catch (error) {
    return { ok: false, findings: [{ code: "unreadable_release_root", file: ".", detail: error.message }] };
  }

  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) findings.push({ code: "missing_required_file", file: required });
  }

  let totalBytes = 0;
  const denylist = Array.isArray(options.denylist)
    ? options.denylist.map((item) => String(item).trim()).filter((item) => item.length >= 2)
    : [];

  for (const relative of files) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      findings.push({ code: "symlink_not_allowed", file: relative });
      continue;
    }
    totalBytes += metadata.size;


    const basename = path.basename(relative);
    const extension = basename === ".gitignore"
      ? ".gitignore"
      : basename === "LICENSE"
        ? ".txt"
        : path.extname(relative).toLowerCase();
    if (/^\.env(?:\..+)?$/u.test(basename) && basename !== ".env.example") {
      findings.push({ code: "private_environment_file", file: relative });
    }
    if ([".npmrc", ".yarnrc", ".pypirc", ".netrc"].includes(basename)) {
      findings.push({ code: "package_manager_credential_file", file: relative });
    }
    if (/\.(?:csv|tsv|jsonl|sqlite|sqlite3|db)$/iu.test(relative)
      || (extension === ".json" && !["package.json", "package-lock.json"].includes(basename))) {
      findings.push({ code: "forbidden_data_file", file: relative });
    }
    const imageCandidate = DOC_IMAGE_PATH.test(relative);
    const maxBytes = imageCandidate ? 3_000_000 : MAX_FILE_BYTES;
    if (metadata.size > maxBytes) findings.push({ code: "file_too_large", file: relative });
    const bytes = imageCandidate ? await readFile(absolute) : null;
    if (!TEXT_EXTENSIONS.has(extension) && !PYTHON_SOURCES.has(relative) && !(bytes && isPublicDocImage(relative, bytes))) {
      findings.push({ code: "unsupported_binary_or_file_type", file: relative });
      continue;
    }

    const content = bytes ? bytes.toString("utf8") : await readFile(absolute, "utf8");
    addPatternFindings(findings, relative, content, extension);
    for (const literal of denylist) {
      if (content.includes(literal)) findings.push({ code: "private_denylist_match", file: relative });
    }
  }

  if (totalBytes > MAX_TOTAL_BYTES) findings.push({ code: "release_too_large", file: "." });
  const deduped = [...new Map(findings.map((item) => [`${item.code}\0${item.file}`, item])).values()];
  return { ok: deduped.length === 0, findings: deduped, fileCount: files.length, totalBytes };
}

export { REQUIRED_FILES };
