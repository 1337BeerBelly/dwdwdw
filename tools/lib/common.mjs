/**
 * Общие правила и утилиты для arena-pack / arena-unpack.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const TOOL_VERSION = "1.2";

export const SKIP_DIRS = new Set([
  ".git", ".svn", ".hg", ".bzr", "__MACOSX",
  "node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".tox", ".nox", ".eggs", ".ipynb_checkpoints",
  "dist", "build", "out", "target", "bin", "obj", "coverage", ".nyc_output",
  ".cache", ".parcel-cache", ".turbo", ".vite", ".svelte-kit", ".next", ".nuxt",
  ".angular", ".expo", ".dart_tool", ".gradle", ".idea", ".vs", "DerivedData",
  "Pods", ".terraform", ".serverless", ".stack-work", "Debug", "Release",
]);

export const SKIP_EXT = new Set([
  ".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".pdb", ".o", ".a", ".lib",
  ".class", ".jar", ".war", ".pyc", ".pyo", ".sqlite", ".sqlite3", ".db",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac", ".iso", ".dmg", ".msi",
]);

export const OS_JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "ehthumbs.db", ".localized"]);

/** Секреты: вырезаются, пока не указан --with-secrets. */
export const SECRET_FILES = [
  /^\.env$/i, /^\.env\.[a-z0-9._-]+$/i, /^\.envrc$/i,
  /\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i, /\.jks$/i, /\.keystore$/i, /\.ppk$/i,
  /^id_rsa/i, /^id_dsa/i, /^id_ecdsa/i, /^id_ed25519/i,
  /^\.npmrc$/i, /^\.netrc$/i, /^_netrc$/i, /^\.pgpass$/i, /^\.htpasswd$/i,
  /^credentials\.json$/i, /^secrets\.json$/i, /^secret\.json$/i,
  /^service[-_]account.*\.json$/i, /^\.git-credentials$/i, /^\.docker\/config\.json$/i,
];

/** Файлы, которые НЕ считаются секретами, даже если подходят под шаблон. */
const SECRET_ALLOW = [/^\.env\.(example|sample|template|dist)$/i];

export function isSecretName(name) {
  if (SECRET_ALLOW.some((re) => re.test(name))) return false;
  return SECRET_FILES.some((re) => re.test(name));
}

export function humanSize(bytes) {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

/** Простой glob: * (в пределах сегмента), ** (любая глубина), ? (один символ). */
export function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

export function matchesAny(patterns, relPath, baseName) {
  if (!patterns || patterns.length === 0) return false;
  const rel = String(relPath).replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const re = pattern instanceof RegExp ? pattern : globToRegExp(pattern);
    return re.test(rel) || re.test(baseName);
  });
}

export function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("-") && token.length > 1) {
      const eq = token.indexOf("=");
      let name = (eq > 0 ? token.slice(0, eq) : token).replace(/^-+/, "").toLowerCase();
      const inlineValue = eq > 0 ? token.slice(eq + 1) : null;
      const takesValue = ["path", "p", "include", "only", "exclude", "max", "max-file-mb", "out", "o",
        "into", "target", "t", "request", "zip", "z", "pack", "src", "changes", "name",
        "login-provider"].includes(name);
      if (inlineValue !== null) {
        flags.set(name, inlineValue);
      } else if (takesValue) {
        const next = argv[i + 1];
        if (next !== undefined && !(next.startsWith("-") && next.length > 1)) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, "");
        }
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

export function flagValue(flags, names, fallback = undefined) {
  for (const name of names) if (flags.has(name)) return flags.get(name);
  return fallback;
}

export function flagOn(flags, names) {
  for (const name of names) if (flags.get(name) === true) return true;
  return false;
}

export function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------ ввод-вывод ---------------------------- */

export const hasTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question) {
  if (!hasTTY) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await new Promise((resolve) => rl.question(question, resolve))).trim();
  } finally {
    rl.close();
  }
}

export function stripQuotes(value) {
  let v = String(value ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

export function copyToClipboard(text) {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("clip", { input: text, shell: true, windowsHide: true });
      return r.status === 0;
    }
    const cmd = process.platform === "darwin" ? "pbcopy" : "xclip";
    const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
    const r = spawnSync(cmd, args, { input: text });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function desktopPath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Desktop"),
    path.join(home, "Рабочий стол"),
    path.join(home, "Downloads"),
    home,
    os.tmpdir(),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* пропускаем */
    }
  }
  return process.cwd();
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function relUnix(root, full) {
  return path.relative(root, full).replace(/\\/g, "/");
}

/** Безопасная запись: только внутри базовой папки. */
export function safeJoin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath.replace(/\//g, path.sep));
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) return null;
  return target;
}

export function sanitizeFileName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80) || "project";
}

export function readKeyValue(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function formatKeyValue(pairs) {
  return Object.entries(pairs)
    .map(([k, v]) => `${k}=${v ?? ""}`)
    .join("\n") + "\n";
}

export function banner(title) {
  const line = "=".repeat(60);
  console.log("");
  console.log(`  ${line}`);
  console.log(`    ${title}`);
  console.log(`  ${line}`);
  console.log("");
}

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = code;
  }
}

export function fail(message, code = 1) {
  throw new CliError(message, code);
}

/** Пауза в конце работы — только при запуске двойным щелчком (ARENA_PAUSE=1). */
export async function maybePause(flags) {
  if (flagOn(flags ?? new Map(), ["no-pause"])) return;
  if (process.env.ARENA_PAUSE !== "1") return;
  if (!hasTTY) return;
  await ask("  Нажмите Enter, чтобы закрыть окно... ");
}
