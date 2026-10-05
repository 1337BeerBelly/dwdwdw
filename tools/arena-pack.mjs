#!/usr/bin/env node
/**
 * arena-pack.mjs — упаковать папку проекта в zip для отправки в чат Arena.
 *
 * Запуск (обычно через arena-pack.bat):
 *   node arena-pack.mjs [папка] [--include src,docs] [--all] [--max 5] [--out путь]
 *                       [--exclude маска] [--dry-run] [--clip] [--yes] [--no-prompt]
 *                       [--with-secrets] [--request "текст"] [--help]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeZip } from "./lib/zip.mjs";
import { scanProject } from "./lib/scan.mjs";
import {
  TOOL_VERSION,
  humanSize,
  stamp,
  sha256File,
  parseArgs,
  flagValue,
  flagOn,
  splitList,
  matchesAny,
  ask,
  stripQuotes,
  copyToClipboard,
  desktopPath,
  sanitizeFileName,
  formatKeyValue,
  banner,
  fail,
  hasTTY,
  CliError,
  maybePause,
} from "./lib/common.mjs";

const GUARD_TOTAL_MB = 300;

const HELP = `
  arena-pack — упаковать проект для отправки в чат Arena

  Использование:
    arena-pack.bat                       спросит папку проекта
    arena-pack.bat C:\\dev\\my-app          упаковать указанную папку
    arena-pack.bat C:\\dev\\my-app --include src,docs   только эти папки/файлы
    arena-pack.bat C:\\dev\\my-app --all    всё, кроме .git и мусора ОС
    arena-pack.bat C:\\dev\\my-app --max 20 --out D:\\   лимит на файл и куда положить

  Параметры:
    --include <пути>   упаковать только эти пути (относительно корня), фильтры отключаются
    --exclude <маски>  дополнительно исключить (например "*.log,secrets/*")
    --max <МБ>         максимум на один файл, по умолчанию 5; 0 — без ограничения
    --all              снять фильтры папок/размеров/бинарников (секреты всё равно вырезаются)
    --with-secrets     не вырезать .env, ключи и прочие потенциальные секреты
    --out <путь>       куда положить архив (по умолчанию Рабочий стол)
    --request <текст>  задача одной строкой (попадёт в _ARENA/REQUEST.txt)
    --dry-run          показать, что попадёт в архив, и ничего не создавать
    --clip             скопировать готовое сообщение для чата в буфер обмена
    --yes              не задавать подтверждающих вопросов
    --no-prompt        не спрашивать задачу
    --help             эта справка
`;

async function main({ flags, positional }) {
  if (flagOn(flags, ["help", "h", "?"])) {
    console.log(HELP);
    return 0;
  }

  const dryRun = flagOn(flags, ["dry-run", "dryrun", "n"]);
  const all = flagOn(flags, ["all"]);
  const withSecrets = flagOn(flags, ["with-secrets"]);
  const yes = flagOn(flags, ["yes", "y"]);
  const noPrompt = flagOn(flags, ["no-prompt"]);
  const clip = flagOn(flags, ["clip"]);
  const includeList = splitList(flagValue(flags, ["include", "only"], ""));
  const excludeList = splitList(flagValue(flags, ["exclude"], ""));
  const maxMbRaw = flagValue(flags, ["max", "max-file-mb"], "5");
  const maxMb = Number(maxMbRaw);
  if (!Number.isFinite(maxMb) || maxMb < 0) fail(`некорректный --max: ${maxMbRaw}`);
  const maxBytes = maxMb === 0 ? 0 : maxMb * 1024 * 1024;

  /* ---------------------------- папка проекта --------------------------- */

  let projectPath = positional[0] ?? flagValue(flags, ["path", "p"]);
  if (!projectPath && hasTTY && !yes) {
    const answer = await ask("  Перетащите папку проекта в это окно и нажмите Enter: ");
    projectPath = stripQuotes(answer);
  }
  if (!projectPath) {
    projectPath = process.cwd();
    console.log(`  Папка не указана, беру текущую: ${projectPath}`);
  } else {
    projectPath = stripQuotes(projectPath);
  }

  if (!fs.existsSync(projectPath)) fail(`папка не найдена: ${projectPath}`);
  const root = path.resolve(projectPath);
  if (!fs.statSync(root).isDirectory()) fail(`это не папка: ${root}`);

  const projectName = path.basename(root);
  const includeRoots = includeList.map((item) => path.resolve(root, item));
  const noFilters = all || includeRoots.length > 0;

  banner(`arena-pack — ${root}`);

  /* ------------------------------- обход -------------------------------- */

  const scan = scanProject(root, {
    includeList,
    excludeList,
    all,
    maxBytes,
    withSecrets,
  });
  const files = scan.files;
  const skipped = scan.skipped;
  const skippedDirs = scan.skippedDirs;
  const totalBytes = scan.totalBytes;
  const longPaths = scan.longPaths;

  const secrets = skipped.filter((s) => s.secret);
  const big = skipped.filter((s) => !s.secret && s.reason.startsWith("больше"));
  const binaries = skipped.filter((s) => s.reason === "двоичный или архив");

  /* ------------------------------ сводка -------------------------------- */

  console.log(`  Проект:    ${root}`);
  console.log(`  Режим:     ${all ? "--all (без фильтров)" : includeRoots.length ? `--include ${includeList.join(", ")}` : "по умолчанию"}`);
  console.log(`  Файлов:    ${files.length} (${humanSize(totalBytes)})`);
  if (skippedDirs.length) {
    const top = [...skippedDirs].sort((a, b) => b.bytes - a.bytes).slice(0, 12);
    console.log("");
    console.log(`  Пропущены папки (${skippedDirs.length}):`);
    for (const d of top) {
      console.log(`    ${d.rel.padEnd(34).slice(0, 34)} ${String(d.files).padStart(6)} файлов  ${humanSize(d.bytes).padStart(9)}  (${d.reason})`);
    }
    console.log("    Нужна такая папка — добавьте её в --include, например: --include dist,src");
  }
  if (secrets.length) {
    console.log("");
    console.log(`  Вырезаны потенциальные секреты (${secrets.length}):`);
    for (const s of secrets.slice(0, 12)) console.log(`    ${s.rel}  (${humanSize(s.size)})`);
    if (secrets.length > 12) console.log(`    ... и ещё ${secrets.length - 12}`);
    console.log("    Нужны в архиве осознанно — запустите с --with-secrets");
  }
  if (big.length || binaries.length) {
    console.log("");
    console.log(`  Пропущено файлов: больших — ${big.length}, двоичных/архивных — ${binaries.length}`);
    for (const b of [...big, ...binaries].slice(0, 8)) console.log(`    ${b.rel}  (${humanSize(b.size)}, ${b.reason})`);
    if (big.length + binaries.length > 8) console.log(`    ... и ещё ${big.length + binaries.length - 8}`);
  }
  if (longPaths) console.log(`\n  Пропущено из-за длинного пути (>250 символов): ${longPaths}`);

  if (files.length === 0) fail("в архив нечего положить — проверьте параметры отбора");

  if (dryRun) {
    console.log("");
    console.log("  --dry-run: архив не создаётся.");
    console.log("");
    return 0;
  }

  if (totalBytes > GUARD_TOTAL_MB * 1024 * 1024 && !yes && hasTTY) {
    console.log("");
    const answer = await ask(`  Архив получится ${humanSize(totalBytes)}. Продолжить? [д/н]: `);
    if (!/^(д|y|yes|да)$/i.test(answer)) fail("отменено пользователем", 2);
  }

  /* ------------------------------- задача -------------------------------- */

  let request = String(flagValue(flags, ["request"], "") || "").trim();
  const requestFile = path.join(root, "_ARENA_REQUEST.txt");
  if (!request && fs.existsSync(requestFile)) request = fs.readFileSync(requestFile, "utf8").trim();
  if (!request && !noPrompt && hasTTY) {
    const answer = await ask("  Что нужно сделать? (можно Enter — тогда напишете в чате): ");
    request = answer.trim();
  }

  /* ------------------------------- архив --------------------------------- */

  const packId = `${sanitizeFileName(projectName)}-${stamp()}`;
  const outArg = flagValue(flags, ["out", "o"], "");
  const outDir = outArg ? path.resolve(stripQuotes(outArg)) : desktopPath();
  const zipPath = path.join(outDir, `${packId}.zip`);

  const info = {
    ARENA_PACK: 1,
    TOOL: "arena-pack",
    TOOL_VERSION,
    PACK_ID: packId,
    PACKED_AT: new Date().toISOString(),
    PROJECT_NAME: projectName,
    PROJECT_PATH: root,
    HOSTNAME: os.hostname(),
    OS: `${process.platform} ${os.release()}`,
    GIT_BRANCH: "",
    GIT_HEAD: "",
    MODE: all ? "all" : includeRoots.length ? "include" : "default",
    INCLUDE: includeList.join(","),
    EXCLUDE: excludeList.join(","),
    MAX_FILE_MB: String(maxMb),
    FILE_COUNT: String(files.length),
    TOTAL_BYTES: String(totalBytes),
    SKIPPED_FILES: String(skipped.length),
    SKIPPED_SECRETS: String(secrets.length),
    SKIPPED_DIRS: skippedDirs.map((d) => d.rel).slice(0, 40).join(","),
  };

  const gitHeadFile = path.join(root, ".git", "HEAD");
  if (fs.existsSync(gitHeadFile)) {
    const head = fs.readFileSync(gitHeadFile, "utf8").trim();
    if (head.startsWith("ref:")) info.GIT_BRANCH = head.slice(4).trim().replace("refs/heads/", "");
    info.GIT_HEAD = head.replace("ref:", "").trim();
  }

  const manifestLines = [];
  const entries = [];
  let done = 0;
  for (const file of files) {
    let hash = "";
    try {
      hash = sha256File(file.full);
    } catch {
      hash = "(не прочитан)";
    }
    manifestLines.push(`${hash}  ${String(file.size).padStart(10)}  ${file.rel}`);
    entries.push({ name: file.rel, sourcePath: file.full });
    done++;
    if (done % 200 === 0) process.stdout.write(".");
  }
  if (done >= 200) process.stdout.write("\n");

  entries.push({
    name: "_ARENA/INFO.txt",
    data: Buffer.from(formatKeyValue(info), "utf8"),
  });
  entries.push({
    name: "_ARENA/MANIFEST.txt",
    data: Buffer.from(
      `# sha256  размер(байт)  путь\n${manifestLines.join("\n")}\n`,
      "utf8"
    ),
  });
  if (request) {
    entries.push({
      name: "_ARENA/REQUEST.txt",
      data: Buffer.from(request.endsWith("\n") ? request : request + "\n", "utf8"),
    });
  }

  const result = writeZip(entries, zipPath);

  /* ------------------------------- итог ---------------------------------- */

  console.log("");
  console.log("  ------------------------------------------------------------");
  console.log(`  Архив:   ${zipPath}`);
  console.log(`  Размер:  ${humanSize(result.bytes)}  (${result.count} файлов внутри)`);
  console.log("  ------------------------------------------------------------");
  console.log("  Дальше:");
  console.log("    1. Откройте чат в Arena.");
  console.log("    2. Перетащите туда этот архив и напишите задачу.");
  if (request) console.log("       Задача уже лежит внутри: _ARENA/REQUEST.txt");
  console.log("  ------------------------------------------------------------");

  if (clip) {
    const firstLine = request ? request.split(/\r?\n/)[0].slice(0, 200) : "см. _ARENA/REQUEST.txt";
    const message = `Прикладываю архив ${path.basename(zipPath)} (pack ${packId}).\nЗадача: ${firstLine}`;
    console.log(copyToClipboard(message) ? "\n  Сообщение для чата скопировано в буфер обмена." : "\n  Буфер обмена недоступен — напишите сообщение вручную.");
  }
  console.log("");
  return 0;
}

/* ------------------------------ запуск -------------------------------- */

const parsed = parseArgs(process.argv.slice(2));
try {
  process.exitCode = await main(parsed);
} catch (err) {
  console.log("");
  console.log(`  [ОШИБКА] ${err && err.message ? err.message : String(err)}`);
  console.log("");
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
} finally {
  await maybePause(parsed.flags);
}
