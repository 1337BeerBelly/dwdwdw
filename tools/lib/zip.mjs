/**
 * Минимальный ZIP: чтение и запись без внешних зависимостей.
 *
 * Поддерживается только то, что нужно обмену архивами с чатом:
 *   запись  — методы store и deflate, UTF-8 имена, обычный (не zip64) формат;
 *   чтение  — методы store и deflate, имена в UTF-8 и CP866 не встречаются.
 *
 * Формат валиден: архивы читаются Windows Explorer, `unzip`, Python zipfile.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_UINT32 = 0xffffffff;

/* ------------------------------- CRC32 ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/* ------------------------------ запись ------------------------------- */

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

function useDeflate(data, ext) {
  const already = new Set([
    ".zip", ".gz", ".tgz", ".7z", ".rar", ".xz", ".bz2", ".png", ".jpg", ".jpeg", ".gif",
    ".webp", ".avif", ".ico", ".mp3", ".mp4", ".mov", ".mkv", ".avi", ".webm", ".woff",
    ".woff2", ".pdf", ".jar", ".apk", ".ipa", ".dmg", ".iso", ".ofs",
  ]);
  if (already.has(ext)) return false;
  // Мелкие файлы: deflate-заголовки съедают выигрыш.
  return data.length > 256;
}

/**
 * Создать zip-архив.
 * @param {Array<{name:string, data?:Buffer, sourcePath?:string, mtime?:Date}>} entries
 *        `name` — путь внутри архива (прямые слэши), `data` или `sourcePath` — содержимое.
 * @param {string} outPath
 * @returns {{count:number, bytes:number, stored:number, compressed:number}}
 */
export function writeZip(entries, outPath) {
  if (entries.length > 65000) {
    throw new Error(`слишком много файлов для этого формата: ${entries.length} (лимит 65000)`);
  }

  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  for (const entry of entries) {
    const name = String(entry.name).replace(/\\/g, "/").replace(/^\/+/, "");
    const nameBuf = Buffer.from(name, "utf8");
    const raw = entry.data instanceof Buffer ? entry.data : fs.readFileSync(entry.sourcePath);
    const ext = path.extname(name).toLowerCase();

    let method = METHOD_STORE;
    let body = raw;
    if (useDeflate(raw, ext)) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }

    if (raw.length > MAX_UINT32 || body.length > MAX_UINT32) {
      throw new Error(`файл слишком большой для этого формата: ${name}`);
    }

    const { time, day } = dosDateTime(entry.mtime);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const localOffset = offset;
    push(local);
    push(nameBuf);
    push(body);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(SIG_CENTRAL, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(FLAG_UTF8, 8);
    centralEntry.writeUInt16LE(method, 10);
    centralEntry.writeUInt16LE(time, 12);
    centralEntry.writeUInt16LE(day, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(body.length, 20);
    centralEntry.writeUInt32LE(raw.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30); // extra
    centralEntry.writeUInt16LE(0, 32); // comment
    centralEntry.writeUInt16LE(0, 34); // disk
    centralEntry.writeUInt16LE(0, 36); // internal attrs
    centralEntry.writeUInt32LE(0, 38); // external attrs
    centralEntry.writeUInt32LE(localOffset, 42);
    central.push(centralEntry, nameBuf);
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  for (const buf of central) push(buf);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  push(eocd);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(chunks));

  return {
    count: entries.length,
    bytes: fs.statSync(outPath).size,
    stored: 0,
  };
}

/* ------------------------------- чтение ------------------------------ */

function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const total = buf.readUInt16LE(i + 10);
      const cdSize = buf.readUInt32LE(i + 12);
      const cdOffset = buf.readUInt32LE(i + 16);
      const commentLen = buf.readUInt16LE(i + 20);
      if (cdOffset + cdSize <= buf.length && i + 22 + commentLen <= buf.length) {
        return { total, cdSize, cdOffset };
      }
    }
  }
  return null;
}

export class ZipArchive {
  constructor(filePath) {
    this.filePath = filePath;
    this.buffer = fs.readFileSync(filePath);
    const eocd = findEocd(this.buffer);
    if (!eocd) throw new Error(`не похоже на zip-архив: ${filePath}`);
    if (eocd.total === 0xffff || eocd.cdOffset === MAX_UINT32) {
      throw new Error("архив в формате zip64 — такие пока не поддерживаются");
    }
    this.entries = [];
    let p = eocd.cdOffset;
    for (let i = 0; i < eocd.total; i++) {
      if (this.buffer.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("повреждённое оглавление архива");
      const flags = this.buffer.readUInt16LE(p + 8);
      const method = this.buffer.readUInt16LE(p + 10);
      const time = this.buffer.readUInt16LE(p + 12);
      const day = this.buffer.readUInt16LE(p + 14);
      const crc = this.buffer.readUInt32LE(p + 16);
      const compSize = this.buffer.readUInt32LE(p + 20);
      const size = this.buffer.readUInt32LE(p + 24);
      const nameLen = this.buffer.readUInt16LE(p + 28);
      const extraLen = this.buffer.readUInt16LE(p + 30);
      const commentLen = this.buffer.readUInt16LE(p + 32);
      const localOffset = this.buffer.readUInt32LE(p + 42);
      const name = this.buffer.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");

      let dataOffset = 0;
      if (localOffset + 30 <= this.buffer.length && this.buffer.readUInt32LE(localOffset) === SIG_LOCAL) {
        const lNameLen = this.buffer.readUInt16LE(localOffset + 26);
        const lExtraLen = this.buffer.readUInt16LE(localOffset + 28);
        dataOffset = localOffset + 30 + lNameLen + lExtraLen;
      }

      this.entries.push({
        name,
        method,
        flags,
        encrypted: (flags & 0x0001) !== 0,
        crc,
        compSize,
        size,
        time,
        day,
        dataOffset,
        isDirectory: name.endsWith("/") || size === 0 && compSize === 0 && name.endsWith("/"),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** Имена файлов без служебной папки `_ARENA` (папки исключены). */
  list() {
    return this.entries.filter((e) => !e.name.endsWith("/"));
  }

  get(name) {
    return this.entries.find((e) => e.name.toLowerCase() === String(name).toLowerCase());
  }

  /** Содержимое записи как Buffer. */
  read(entry) {
    const e = typeof entry === "string" ? this.get(entry) : entry;
    if (!e) throw new Error(`в архиве нет файла ${entry}`);
    if (e.encrypted) throw new Error(`запись ${e.name} зашифрована`);
    const chunk = this.buffer.subarray(e.dataOffset, e.dataOffset + e.compSize);
    if (e.method === METHOD_STORE) return Buffer.from(chunk);
    if (e.method === METHOD_DEFLATE) {
      const out = zlib.inflateRawSync(chunk);
      if (out.length !== e.size) {
        throw new Error(`не удалось распаковать ${e.name} (ожидалось ${e.size} байт, получили ${out.length})`);
      }
      return out;
    }
    throw new Error(`метод сжатия ${e.method} не поддерживается (${e.name})`);
  }

  /** Содержимое записи как текст UTF-8. */
  readText(entry) {
    return this.read(entry).toString("utf8");
  }
}

export function readZip(filePath) {
  return new ZipArchive(filePath);
}
