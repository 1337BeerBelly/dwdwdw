#!/usr/bin/env node
/**
 * arena-unpack.mjs — разложить присланный из чата архив обратно в проект.
 *
 * Запуск (обычно через arena-unpack.bat, можно перетащить zip прямо на батник):
 *   node arena-unpack.mjs <архив.zip> [--into C:\dev\my-app] [--here]
 *                         [--dry-run] [--force] [--help]
 *
 * Что делает:
 *   1. Смотрит, что изменилось (по хешам), и показывает план.
 *   2. Копирует затрагиваемые файлы в <проект>\_arena_backup\<дата>\.
 *   3. Раскладывает новые и изменённые файлы, удалённые переносит в бэкап.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readZip } from "./lib/zip.mjs";
import {
  humanSize,
  stamp,
  sha256,
  sha256File,
  parseArgs,
  flagValue,
  flagOn,
  ask,
  stripQuotes,
  readKeyValue,
  banner,
  fail,
  hasTTY,
  CliError,
  maybePause,
} from "./lib/common.mjs";

const HELP = `
  arena-unpack — разложить правки из архива в проект

  Использование:
    arena-unpack.bat                          найдёт свежий zip в Загрузках/на Рабочем столе
    arena-unpack.bat C:\\Users\\me\\Downloads\\reply.zip
    arena-unpack.bat reply.zip --into C:\\dev\\my-app
    arena-unpack.bat reply.zip --dry-run      только показать план

  Параметры:
    --into <папка>   куда раскладывать (по умолчанию папка из архива)
    --here           разложить в текущую папку
    --dry-run        ничего не менять, только показать
    --force          разложить архив без служебной папки _ARENA как обычный zip
    --no-pause       не ждать нажатия клавиши (для скриптов)
    --help           эта справка
`;

function newestZip() {
  const home = os.homedir();
  const dirs = [path.join(home, "Downloads"), path.join(home, "Desktop")];
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.zip$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile()) found.push({ full, mtime: stat.mtimeMs });
      } catch {
        /* пропускаем */
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.full ?? null;
}

async function main({ flags, positional }) {
  if (flagOn(flags, ["help", "h", "?"])) {
    console.log(HELP);
    return 0;
  }

  const dryRun = flagOn(flags, ["dry-run", "dryrun", "n"]);
  const force = flagOn(flags, ["force", "f"]);
  const here = flagOn(flags, ["here"]);

  let zipPath = positional[0] ?? flagValue(flags, ["zip", "z"]);
  if (zipPath) {
    zipPath = stripQuotes(zipPath);
  } else if (hasTTY) {
    const answer = await ask("  Перетащите присланный архив в это окно и нажмите Enter: ");
    zipPath = stripQuotes(answer);
  }
  if (!zipPath) zipPath = newestZip();
  if (!zipPath) fail("не нашёл zip-архив — укажите путь к нему или перетащите файл на батник");
  if (!fs.existsSync(zipPath)) fail(`файл не найден: ${zipPath}`);
  zipPath = path.resolve(zipPath);

  const zip = readZip(zipPath);
  banner(`arena-unpack — ${path.basename(zipPath)}`);

  /* -------------------- служебная папка и префикс ---------------------- */

  const changesEntry = zip.entries.find((e) => /(^|\/)_ARENA\/CHANGES\.txt$/i.test(e.name));
  const infoEntry = zip.entries.find((e) => /(^|\/)_ARENA\/INFO\.txt$/i.test(e.name));
  const deletedEntry = zip.entries.find((e) => /(^|\/)_ARENA\/DELETED\.txt$/i.test(e.name));

  let prefix = "";
  if (changesEntry) prefix = changesEntry.name.replace(/_ARENA\/CHANGES\.txt$/i, "");
  else if (infoEntry) prefix = infoEntry.name.replace(/_ARENA\/INFO\.txt$/i, "");

  if (!changesEntry && !force) {
    if (infoEntry) {
      console.log("  Это архив-отправка (в нём нет файла изменений _ARENA/CHANGES.txt).");
      console.log("  Такой архив вы отправляете мне, а не я вам — раскладывать нечего.");
      console.log("  Если всё же нужно распаковать его поверх проекта: --force");
    } else {
      console.log("  В архиве нет служебной папки _ARENA — не похоже на архив из этого обмена.");
      console.log("  Разложить как есть: --force (файлы будут записаны в указанную папку).");
    }
    console.log("");
    return 2;
  }

  const info = infoEntry ? readKeyValue(zip.readText(infoEntry)) : {};
  const packId = info.PACK_ID || "unknown";

  /* ------------------------------- цель -------------------------------- */

  let target;
  if (here) {
    target = process.cwd();
  } else {
    const intoArg = flagValue(flags, ["into", "target", "t"], "");
    if (intoArg) {
      target = path.resolve(stripQuotes(intoArg));
    } else if (info.PROJECT_PATH && fs.existsSync(info.PROJECT_PATH)) {
      target = path.resolve(info.PROJECT_PATH);
    } else if (info.PROJECT_PATH) {
      console.log(`  Папка из архива (${info.PROJECT_PATH}) не найдена.`);
      const answer = hasTTY ? stripQuotes(await ask("  Укажите папку проекта (или Enter — отмена): ")) : "";
      if (!answer) fail("папка проекта не найдена — запустите с параметром --into <папка>");
      target = path.resolve(answer);
    } else {
      fail("в архиве нет пути к проекту — запустите с параметром --into <папка>");
    }
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    fail(`папка проекта не найдена: ${target}`);
  }

  console.log(`  Проект:  ${target}`);
  console.log(`  Пакет:   ${packId}`);
  console.log("");

  /* --------------------------- разбор архива ---------------------------- */

  const strip = (name) => {
    let value = name.replace(/\\/g, "/");
    if (!prefix) return value;
    if (!value.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    return value.slice(prefix.length);
  };

  const items = [];
  for (const entry of zip.list()) {
    const rel = strip(entry.name);
    if (!rel) continue;
    if (rel.toLowerCase().startsWith("_arena/")) continue;
    if (!rel || rel.endsWith("/")) continue;
    items.push({ entry, rel });
  }

  const deletions = [];
  if (deletedEntry) {
    for (const line of zip.readText(deletedEntry).split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith("#")) continue;
      const rel = strip(value);
      if (rel) deletions.push(rel);
    }
  }

  const plan = { created: [], changed: [], same: [], missingTargets: [] };
  for (const item of items) {
    const dest = path.resolve(target, item.rel.replace(/\//g, path.sep));
    const prefixDir = target.endsWith(path.sep) ? target : target + path.sep;
    if (!dest.startsWith(prefixDir)) {
      plan.missingTargets.push(`${item.rel} (путь вне проекта — пропущен)`);
      continue;
    }
    item.dest = dest;
    if (!fs.existsSync(dest)) {
      plan.created.push(item);
      continue;
    }
    const data = zip.read(item.entry);
    const sameSize = fs.statSync(dest).size === data.length;
    if (sameSize && sha256(data) === sha256File(dest)) plan.same.push(item);
    else plan.changed.push(item);
  }

  const deletionPlan = [];
  for (const rel of deletions) {
    const dest = path.resolve(target, rel.replace(/\//g, path.sep));
    if (fs.existsSync(dest)) deletionPlan.push({ rel, dest });
  }

  /* -------------------------------- план -------------------------------- */

  const writeList = [...plan.created, ...plan.changed];
  if (!writeList.length && !deletionPlan.length) {
    console.log("  Изменений нет: файлы в архиве совпадают с текущими.");
    if (plan.same.length) console.log(`  Проверено файлов: ${plan.same.length}`);
    console.log("");
    return 0;
  }

  console.log(`  Новых файлов:      ${plan.created.length}`);
  console.log(`  Изменённых:        ${plan.changed.length}`);
  console.log(`  Удалить (в бэкап): ${deletionPlan.length}`);
  console.log(`  Без изменений:     ${plan.same.length}`);
  console.log("");
  const show = (title, list, colorMark) => {
    if (!list.length) return;
    console.log(`  ${title}:`);
    for (const item of list.slice(0, 40)) console.log(`    ${colorMark} ${item.rel}`);
    if (list.length > 40) console.log(`    ... и ещё ${list.length - 40}`);
    console.log("");
  };
  show("Новые", plan.created, "+");
  show("Изменённые", plan.changed, "~");
  show("Удаляемые", deletionPlan, "-");
  for (const note of plan.missingTargets) console.log(`  Внимание: ${note}`);

  if (dryRun) {
    console.log("  --dry-run: ничего не изменено.");
    console.log("");
    return 0;
  }

  /* ------------------------------- бэкап -------------------------------- */

  const backupDir = path.join(target, "_arena_backup", packId === "unknown" ? stamp() : packId);
  let backupCount = 0;
  const backup = (rel, dest) => {
    const save = path.join(backupDir, rel.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.copyFileSync(dest, save);
    backupCount++;
  };
  for (const item of plan.changed) backup(item.rel, item.dest);
  for (const item of deletionPlan) backup(item.rel, item.dest);
  if (backupCount) console.log(`  Бэкап: ${backupDir} (${backupCount} файлов)`);

  /* ------------------------------ запись -------------------------------- */

  let written = 0;
  for (const item of writeList) {
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    fs.writeFileSync(item.dest, zip.read(item.entry));
    written++;
  }
  for (const item of deletionPlan) {
    fs.rmSync(item.dest, { force: true });
  }

  console.log(`  Готово: записано ${written} файлов, удалено ${deletionPlan.length}.`);
  console.log("");

  if (changesEntry) {
    const text = zip.readText(changesEntry).trim();
    if (text) {
      console.log("  ------------------------------------------------------------");
      console.log("  Что сделано (из _ARENA/CHANGES.txt):");
      console.log("");
      const lines = text.split(/\r?\n/);
      for (const line of lines.slice(0, 80)) console.log(`    ${line}`);
      if (lines.length > 80) console.log(`    ... (ещё ${lines.length - 80} строк в _ARENA/CHANGES.txt)`);
      console.log("  ------------------------------------------------------------");
      console.log("");
    }
  }

  if (fs.existsSync(path.join(target, ".git"))) {
    console.log("  Правки не закоммичены — посмотреть:  git status  /  git diff");
  }
  if (backupCount) {
    console.log(`  Откатить: скопируйте файлы обратно из ${backupDir}`);
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
