#!/usr/bin/env node
/**
 * roundtrip.mjs — сквозная проверка обмена архивами:
 * создаёт тестовый проект, упаковывает его, вносит правки как это делаю я,
 * собирает ответный архив и раскладывает его обратно. Проверяет фильтры,
 * удаления, бэкап, dry-run и читаемость архивов сторонними инструментами.
 *
 *   node tests/roundtrip.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TOOLS = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tools");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arena-rt-"));
let failed = 0;

const ok = (name, cond, extra = "") => {
  console.log(`  ${cond ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failed++;
};

const run = (script, args) =>
  execFileSync(process.execPath, [path.join(TOOLS, script), ...args], { encoding: "utf8" });

const runFail = (script, args) => {
  try {
    execFileSync(process.execPath, [path.join(TOOLS, script), ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out: "" };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

/* ------------------------- тестовый проект ------------------------- */

const proj = path.join(tmp, "my-app");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.mkdirSync(path.join(proj, "node_modules", "leftpad"), { recursive: true });
fs.mkdirSync(path.join(proj, "dist"), { recursive: true });
fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
fs.writeFileSync(path.join(proj, "src", "a.js"), "export const a = 1;\n");
fs.writeFileSync(path.join(proj, "src", "b.js"), "export const b = 2;\n");
fs.writeFileSync(path.join(proj, "README.md"), "# my-app\n");
fs.writeFileSync(path.join(proj, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(proj, "dist", "bundle.js"), "x".repeat(5000));
fs.writeFileSync(path.join(proj, ".git", "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(proj, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(proj, ".env.example"), "SECRET=\n");
fs.writeFileSync(path.join(proj, "secrets.json"), '{"token":"x"}\n');
fs.writeFileSync(path.join(proj, "big.bin"), Buffer.alloc(8 * 1024 * 1024));
fs.writeFileSync(path.join(proj, "notes.txt"), "hello\n");

const outDir = path.join(tmp, "out");
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------ pack ------------------------------ */

console.log("\n1) arena-pack");
const packOut = run("arena-pack.mjs", [proj, "--out", outDir, "--no-prompt", "--yes", "--request", "Поправь баг в a.js"]);
const packZip = fs.readdirSync(outDir).find((f) => f.endsWith(".zip"));
ok("архив создан", Boolean(packZip), packZip);
ok("в выводе есть размер", /Размер:/.test(packOut));
ok("секреты вырезаны", /Вырезаны потенциальные секреты/.test(packOut) && /\.env\b/.test(packOut));
ok("служебные папки пропущены", /node_modules/.test(packOut) && /dist/.test(packOut));

const packPath = path.join(outDir, packZip);
const list = execFileSync("python3", ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
print("\\n".join(sorted(i.filename for i in z.infolist())))
`, packPath], { encoding: "utf8" });
console.log("     содержимое архива:\n" + list.split("\n").filter(Boolean).map((l) => "       " + l).join("\n"));
ok("python читает наш zip", list.includes("src/a.js"));
ok("src/b.js на месте", list.includes("src/b.js"));
ok("_ARENA/INFO.txt на месте", list.includes("_ARENA/INFO.txt"));
ok("_ARENA/MANIFEST.txt на месте", list.includes("_ARENA/MANIFEST.txt"));
ok("_ARENA/REQUEST.txt на месте", list.includes("_ARENA/REQUEST.txt"));
ok("node_modules не попал", !list.includes("node_modules/leftpad/index.js"));
ok("dist не попал", !list.includes("dist/bundle.js"));
ok("секрет .env не попал", !/^\.env$/m.test(list));
ok("секрет secrets.json не попал", !list.includes("secrets.json"));
ok(".env.example оставлен", list.includes(".env.example"));
ok("большой файл не попал", !list.includes("big.bin"));
ok("обычный файл попал", list.includes("notes.txt"));

/* --------------------------- мои правки --------------------------- */

const work = path.join(tmp, "work");
fs.cpSync(proj, work, { recursive: true });
fs.writeFileSync(path.join(work, "src", "a.js"), "export const a = 42; // исправлено\n");
fs.writeFileSync(path.join(work, "src", "c.js"), "export const c = 3;\n");
fs.rmSync(path.join(work, "src", "b.js"));

console.log("\n2) arena-reply (моя сторона)");
const changesFile = path.join(tmp, "changes.txt");
fs.writeFileSync(changesFile, "Исправил a.js, добавил c.js, удалил b.js.\n");
const replyOut = run("arena-reply.mjs", ["--pack", packPath, "--src", work, "--changes", changesFile, "--out", outDir]);
ok("ответный архив собран", /ответный архив|Ответный архив/i.test(replyOut));
const replyZip = fs.readdirSync(outDir).find((f) => f.endsWith("-reply.zip"));
ok("файл ответа есть", Boolean(replyZip), replyZip);
const replyPath = path.join(outDir, replyZip);
const replyList = execFileSync("python3", ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
print("\\n".join(sorted(i.filename for i in z.infolist())))
`, replyPath], { encoding: "utf8" });
ok("в ответе нет неизменённых файлов", !replyList.includes("README.md") && !replyList.includes("notes.txt"));
ok("в ответе есть изменённый и новый", replyList.includes("src/a.js") && replyList.includes("src/c.js"));
ok("в ответе есть DELETED", replyList.includes("_ARENA/DELETED.txt"));

/* ----------------------------- unpack ----------------------------- */

console.log("\n3) arena-unpack");
const dry = run("arena-unpack.mjs", [replyPath, "--into", proj, "--dry-run"]);
ok("dry-run показывает план", /Новых файлов:\s+1/.test(dry) && /Изменённых:\s+1/.test(dry) && /Удалить/.test(dry));
ok("dry-run ничего не меняет", fs.readFileSync(path.join(proj, "src", "a.js"), "utf8").includes("= 1;") && fs.existsSync(path.join(proj, "src", "b.js")));

const apply = run("arena-unpack.mjs", [replyPath, "--into", proj]);
ok("файл изменён", fs.readFileSync(path.join(proj, "src", "a.js"), "utf8").includes("42"));
ok("новый файл создан", fs.existsSync(path.join(proj, "src", "c.js")));
ok("удалённый файл убран", !fs.existsSync(path.join(proj, "src", "b.js")));
const backups = fs.readdirSync(path.join(proj, "_arena_backup"), { recursive: true }).map(String);
ok("бэкап изменённого", backups.some((f) => f.replace(/\\/g, "/").endsWith("src/a.js")));
ok("бэкап удалённого", backups.some((f) => f.replace(/\\/g, "/").endsWith("src/b.js")));
ok("в выводе есть описание правок", /Исправил a\.js/.test(apply));

console.log("\n4) повторный unpack — идемпотентность");
const again = run("arena-unpack.mjs", [replyPath, "--into", proj]);
ok("повторно ничего не меняется", /Изменений нет/.test(again));

console.log("\n5) защита от неверного архива");
const ownPack = runFail("arena-unpack.mjs", [packPath, "--into", proj]);
ok("свой pack-архив не раскладывается", ownPack.code === 2 && /архив-отправка/.test(ownPack.out));

console.log("\n6) режимы pack");
const incDir = path.join(tmp, "inc");
fs.mkdirSync(incDir, { recursive: true });
const incOut = run("arena-pack.mjs", [proj, "--include", "dist,notes.txt", "--out", incDir, "--no-prompt", "--yes"]);
const incZip = fs.readdirSync(incDir).find((f) => f.endsWith(".zip"));
const incList = execFileSync("python3", ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
print("\\n".join(sorted(i.filename for i in z.infolist())))
`, path.join(incDir, incZip)], { encoding: "utf8" });
ok("--include берёт только указанное", incList.includes("dist/bundle.js") && incList.includes("notes.txt") && !incList.includes("src/a.js"));

const allDir = path.join(tmp, "all");
fs.mkdirSync(allDir, { recursive: true });
run("arena-pack.mjs", [proj, "--all", "--out", allDir, "--no-prompt", "--yes"]);
const allZip = fs.readdirSync(allDir).find((f) => f.endsWith(".zip"));
const allList = execFileSync("python3", ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
print("\\n".join(sorted(i.filename for i in z.infolist())))
`, path.join(allDir, allZip)], { encoding: "utf8" });
ok("--all берёт большие файлы и node_modules", allList.includes("big.bin") && allList.includes("node_modules/leftpad/index.js"));
ok("--all всё равно вырезает секреты", !/^\.env$/m.test(allList));

const secDir = path.join(tmp, "sec");
fs.mkdirSync(secDir, { recursive: true });
run("arena-pack.mjs", [proj, "--with-secrets", "--out", secDir, "--no-prompt", "--yes"]);
const secZip = fs.readdirSync(secDir).find((f) => f.endsWith(".zip"));
const secList = execFileSync("python3", ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1])
print("\\n".join(sorted(i.filename for i in z.infolist())))
`, path.join(secDir, secZip)], { encoding: "utf8" });
ok("--with-secrets включает .env", /^\.env$/m.test(secList) && secList.includes("secrets.json"));

console.log("\n7) вложенный корень и внешний zip");
// ответ, в котором всё лежит в подпапке (как если бы архив собирали вручную)
const nested = path.join(tmp, "nested");
fs.mkdirSync(nested, { recursive: true });
fs.writeFileSync(path.join(nested, "d.js"), "export const d = 4;\n");
execFileSync("python3", ["-c", `
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(src, "d.js"), "my-app/src/d.js")
    z.writestr("my-app/_ARENA/CHANGES.txt", "Добавил d.js\\n")
`, nested, path.join(tmp, "nested.zip")], { encoding: "utf8" });
const nestedOut = run("arena-unpack.mjs", [path.join(tmp, "nested.zip"), "--into", proj]);
ok("вложенный корень распознан", fs.existsSync(path.join(proj, "src", "d.js")), nestedOut.split("\n")[0]);

// zip, созданный сторонним инструментом (python) с не-_ARENA содержимым + --force
fs.writeFileSync(path.join(nested, "e.js"), "export const e = 5;\n");
execFileSync("python3", ["-c", `
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w") as z:
    z.write(os.path.join(src, "e.js"), "src/e.js")
`, nested, path.join(tmp, "plain.zip")], { encoding: "utf8" });
const plainNo = runFail("arena-unpack.mjs", [path.join(tmp, "plain.zip"), "--into", proj]);
ok("без --force обычный zip отклонён", plainNo.code === 2);
run("arena-unpack.mjs", [path.join(tmp, "plain.zip"), "--into", proj, "--force"]);
ok("с --force обычный zip разложен", fs.existsSync(path.join(proj, "src", "e.js")));

console.log("\n8) устойчивость: путь проекта из INFO");
const infoOut = run("arena-unpack.mjs", [replyPath]);
ok("без --into берётся путь из архива", /Исправил a\.js|Изменений нет/.test(infoOut));

console.log(`\nПровалено проверок: ${failed}`);
console.log(`Рабочая папка теста: ${tmp}`);
process.exit(failed ? 1 : 0);
