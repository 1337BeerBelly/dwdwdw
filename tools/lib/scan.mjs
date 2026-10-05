/**
 * Обход папки проекта с теми же правилами фильтрации, что и в arena-pack.
 * Используется и упаковкой, и сборкой ответного архива.
 */

import fs from "node:fs";
import path from "node:path";

import {
  SKIP_DIRS,
  SKIP_EXT,
  OS_JUNK,
  isSecretName,
  matchesAny,
  relUnix,
} from "./common.mjs";

const DIR_SCAN_LIMIT = 20000;
const MAX_PATH_LENGTH = 250;

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length && files < DIR_SCAN_LIMIT) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      const full = path.join(current, d.name);
      if (d.isDirectory()) stack.push(full);
      else if (d.isFile()) {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* пропускаем */
        }
      }
    }
  }
  return { files, bytes };
}

/**
 * @param {string} root  корень проекта
 * @param {{includeList?:string[], excludeList?:string[], all?:boolean, maxBytes?:number, withSecrets?:boolean}} options
 */
export function scanProject(root, options = {}) {
  const includeList = options.includeList ?? [];
  const excludeList = options.excludeList ?? [];
  const all = options.all === true;
  const maxBytes = options.maxBytes ?? 0;
  const withSecrets = options.withSecrets === true;

  const includeRoots = includeList.map((item) => path.resolve(root, item));
  const noFilters = all || includeRoots.length > 0;

  const files = [];
  const skipped = [];
  const skippedDirs = [];
  let totalBytes = 0;
  let longPaths = 0;

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skippedDirs.push({ rel: relUnix(root, dir), reason: "нет доступа", files: 0, bytes: 0 });
      continue;
    }

    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (full.length > MAX_PATH_LENGTH) {
        longPaths++;
        continue;
      }
      const rel = relUnix(root, full);
      const whitelisted =
        includeRoots.length === 0
          ? true
          : includeRoots.some(
              (w) => full === w || full.startsWith(w + path.sep) || w.startsWith(full + path.sep)
            );

      if (dirent.isSymbolicLink()) {
        if (!noFilters) skipped.push({ rel, reason: "символическая ссылка", size: 0 });
        continue;
      }

      if (dirent.isDirectory()) {
        if (!whitelisted) continue;
        if (matchesAny(excludeList, rel, dirent.name)) {
          skippedDirs.push({ rel, reason: "по маске --exclude", ...dirStats(full) });
          continue;
        }
        if (!noFilters && SKIP_DIRS.has(dirent.name)) {
          skippedDirs.push({ rel, reason: "служебная папка", ...dirStats(full) });
          continue;
        }
        stack.push(full);
        continue;
      }

      if (!dirent.isFile()) continue;
      if (!whitelisted) continue;

      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        skipped.push({ rel, reason: "не читается", size: 0 });
        continue;
      }

      if (matchesAny(excludeList, rel, dirent.name)) {
        skipped.push({ rel, reason: "по маске --exclude", size });
        continue;
      }
      if (isSecretName(dirent.name) && !withSecrets) {
        skipped.push({ rel, reason: "похоже на секрет", size, secret: true });
        continue;
      }
      if (OS_JUNK.has(dirent.name)) {
        skipped.push({ rel, reason: "мусор ОС", size });
        continue;
      }
      if (!noFilters) {
        if (SKIP_EXT.has(path.extname(dirent.name).toLowerCase())) {
          skipped.push({ rel, reason: "двоичный или архив", size });
          continue;
        }
        if (maxBytes && size > maxBytes) {
          skipped.push({ rel, reason: "больше лимита", size });
          continue;
        }
      }

      files.push({ full, rel, size });
      totalBytes += size;
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel, "ru"));
  return { files, skipped, skippedDirs, totalBytes, longPaths, includeRoots, noFilters };
}
