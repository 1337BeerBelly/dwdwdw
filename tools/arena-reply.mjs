#!/usr/bin/env node
/**
 * arena-reply.mjs — служебный инструмент: собрать ответный архив для arena-unpack.
 *
 * Используется при подготовке правок: сравнивает исходный pack-архив
 * пользователя с текущим состоянием папки проекта и кладёт в ответ только
 * то, что реально изменилось.
 *
 *   node arena-reply.mjs --pack <присланный.zip> --src <папка с правками>
 *                        --changes <файл с описанием> [--out <путь>] [--name <имя>]
 *
 * Формат ответа зеркален pack-архиву:
 *   <изменённые и новые файлы в корне>
 *   _ARENA/CHANGES.txt   — что и почему изменено
 *   _ARENA/DELETED.txt   — что удалить (необязательно)
 *   _ARENA/INFO.txt      — копия INFO из pack-архива + поля REPLY_*
 */

import fs from "node:fs";
import path from "node:path";

import { writeZip, readZip } from "./lib/zip.mjs";
import { scanProject } from "./lib/scan.mjs";
import {
  TOOL_VERSION,
  humanSize,
  sha256,
  sha256File,
  parseArgs,
  flagValue,
  flagOn,
  readKeyValue,
  formatKeyValue,
  banner,
  fail,
  CliError,
} from "./lib/common.mjs";

const HELP = `
  arena-reply — собрать ответный архив (служебный инструмент)

    --pack <файл>     присланный pack-архив
    --src <папка>     папка с итоговым состоянием проекта
    --changes <файл>  текстовое описание правок для _ARENA/CHANGES.txt
    --out <папка>     куда положить ответ (по умолчанию рядом с --src)
    --name <имя>      имя архива без .zip
`;

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flagOn(flags, ["help", "h", "?"])) {
    console.log(HELP);
    return;
  }

  const packPath = flagValue(flags, ["pack"], "");
  const srcPath = flagValue(flags, ["src"], "");
  const changesPath = flagValue(flags, ["changes"], "");
  if (!packPath || !srcPath) fail("нужны параметры --pack <архив> и --src <папка>");
  if (!fs.existsSync(packPath)) fail(`pack-архив не найден: ${packPath}`);
  if (!fs.existsSync(srcPath)) fail(`папка с правками не найдена: ${srcPath}`);

  const zip = readZip(packPath);
  const infoEntry = zip.entries.find((e) => /(^|\/)_ARENA\/INFO\.txt$/i.test(e.name));
  const info = infoEntry ? readKeyValue(zip.readText(infoEntry)) : {};
  const prefix = infoEntry ? infoEntry.name.replace(/_ARENA\/INFO\.txt$/i, "") : "";
  const strip = (name) => {
    const value = name.replace(/\\/g, "/");
    if (!prefix) return value;
    if (!value.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    return value.slice(prefix.length);
  };

  const srcRoot = path.resolve(srcPath);
  banner(`arena-reply — ${packIdOf(info, packPath)}`);

  /* ------------------- сравнение с исходным архивом -------------------- */

  const original = new Map(); // rel -> sha256
  for (const entry of zip.list()) {
    const rel = strip(entry.name);
    if (!rel || rel.toLowerCase().startsWith("_arena/")) continue;
    original.set(rel, sha256(zip.read(entry)));
  }

  const changed = [];
  const deleted = [];
  for (const [rel, hash] of original) {
    const full = path.join(srcRoot, rel.replace(/\//g, path.sep));
    if (!fs.existsSync(full)) {
      deleted.push(rel);
      continue;
    }
    if (sha256File(full) !== hash) changed.push({ rel, full });
  }

  const maxMb = Number(info.MAX_FILE_MB ?? "5");
  const mode = info.MODE || "default";
  const scan = scanProject(srcRoot, {
    includeList: mode === "include" ? String(info.INCLUDE || "").split(",").filter(Boolean) : [],
    excludeList: String(info.EXCLUDE || "").split(",").filter(Boolean),
    all: mode === "all",
    maxBytes: Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1024 * 1024 : 0,
    withSecrets: false,
  });

  const added = scan.files.filter((f) => !original.has(f.rel)).map((f) => ({ rel: f.rel, full: f.full }));
  const removedSincePack = [...original.keys()].filter((rel) => !fs.existsSync(path.join(srcRoot, rel.replace(/\//g, path.sep))));

  console.log(`  Изменено:  ${changed.length}`);
  console.log(`  Добавлено: ${added.length}`);
  console.log(`  Удалено:   ${removedSincePack.length}`);
  console.log(`  Без правок: ${original.size - changed.length - removedSincePack.length}`);
  for (const item of [...changed, ...added].slice(0, 25)) console.log(`    ~ ${item.rel}`);
  if (changed.length + added.length > 25) console.log(`    ... и ещё ${changed.length + added.length - 25}`);
  for (const rel of removedSincePack.slice(0, 25)) console.log(`    - ${rel}`);
  console.log("");

  if (!changed.length && !added.length && !removedSincePack.length) {
    fail("правок нет — ответный архив не нужен", 2);
  }

  /* --------------------------- сборка архива --------------------------- */

  const changesText = changesPath && fs.existsSync(changesPath)
    ? fs.readFileSync(changesPath, "utf8")
    : "(описание не передано)\n";

  const replyInfo = {
    ...info,
    TOOL: "arena-reply",
    TOOL_VERSION,
    REPLY_FOR: info.PACK_ID || "",
    REPLIED_AT: new Date().toISOString(),
    CHANGED_COUNT: String(changed.length),
    ADDED_COUNT: String(added.length),
    DELETED_COUNT: String(removedSincePack.length),
  };

  const entries = [];
  for (const item of [...changed, ...added]) entries.push({ name: item.rel, sourcePath: item.full });
  entries.push({ name: "_ARENA/INFO.txt", data: Buffer.from(formatKeyValue(replyInfo), "utf8") });
  entries.push({ name: "_ARENA/CHANGES.txt", data: Buffer.from(changesText.endsWith("\n") ? changesText : changesText + "\n", "utf8") });
  if (removedSincePack.length) {
    entries.push({
      name: "_ARENA/DELETED.txt",
      data: Buffer.from(`# эти файлы нужно удалить (arena-unpack перенесёт их в бэкап)\n${removedSincePack.join("\n")}\n`, "utf8"),
    });
  }

  const outDir = path.resolve(flagValue(flags, ["out"], path.dirname(srcRoot)));
  const name = flagValue(flags, ["name"], `${info.PACK_ID || "reply"}-reply`);
  const outPath = path.join(outDir, `${name}.zip`);
  const result = writeZip(entries, outPath);

  console.log(`  Ответный архив: ${outPath}`);
  console.log(`  Размер: ${humanSize(result.bytes)}, файлов внутри: ${result.count}`);
  console.log("");
}

function packIdOf(info, packPath) {
  return info.PACK_ID || path.basename(packPath);
}

try {
  main();
} catch (err) {
  console.log("");
  console.log(`  [ОШИБКА] ${err && err.message ? err.message : String(err)}`);
  console.log("");
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
}
