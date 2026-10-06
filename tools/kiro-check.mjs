#!/usr/bin/env node
/**
 * kiro-check.mjs — проверка доступности сервисов авторизации Kiro.
 *
 * Отвечает на вопрос «почему не открывается портал Kiro / не подключается провайдер»:
 * проверяет DNS и HTTPS для каждого домена, задействованного во входе,
 * состояние локального шлюза OmniRoute, прокси, часы и файл hosts.
 *
 *   node kiro-check.mjs [--json] [--port 20128] [--timeout 8000] [--no-pause]
 */

import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runKiroSocialProbe, formatResponse, probeRecommendations } from "./lib/kiro-probe.mjs";
import {
  TOOL_VERSION,
  parseArgs,
  flagValue,
  flagOn,
  banner,
  maybePause,
  CliError,
  hasTTY,
} from "./lib/common.mjs";

const HELP = `
  kiro-check — доступность сервисов авторизации Kiro

  Использование:
    kiro-check                          проверить домены, шлюз, прокси, часы
    kiro-check --probe-kiro             дополнительно повторить запросы входа
                                        Google/GitHub и показать сырые ответы Kiro
    kiro-check --probe-kiro --login-provider github
    kiro-check --json > kiro-check.json отчёт файлом (для отправки в чат)
    kiro-check --test-call             послать пробный запрос через локальный шлюз
                                        и показать ответ (какой провайдер, какая ошибка)
    kiro-check --test-call --provider kiro    то же, но строго через Kiro
    kiro-check --test-call --api-key <ключ>   если на шлюзе задан REQUIRE_API_KEY
    kiro-check --port 20128 --timeout 8000
    kiro-check --version
    kiro-check --help

  Проба (--probe-kiro) делает два настоящих запроса к Kiro: просит device-код
  и один раз его опрашивает — ровно как это делает OmniRoute. Ничего не
  подтверждает и не меняет; код живёт ~5 минут и сам истекает.

  Проверка клиента (в отчёте) показывает, куда на самом деле смотрит Claude
  Code: переменные ANTHROPIC_* и файл ~/.claude/settings.json. Если там чужой
  адрес — запросы уходят мимо вашего шлюза (частая причина ошибок 429).

  --test-call отправляет в ваш локальный шлюз один короткий запрос (model auto,
  16 токенов) и печатает статус, тело ответа и служебные заголовки OmniRoute.
`;

/** Домены и эндпоинты, задействованные во входе в Kiro. */
const TARGETS = [
  {
    host: "prod.us-east-1.auth.desktop.kiro.dev",
    url: "https://prod.us-east-1.auth.desktop.kiro.dev/",
    what: "сервис входа Kiro (Google/GitHub) — именно его адрес открывает окно авторизации",
    critical: true,
    hint: "Если недоступен: включите вход через Builder ID (другой домен), либо Auto-Import / Import Token / API Key — портал в них не участвует.",
  },
  {
    host: "oidc.us-east-1.amazonaws.com",
    url: "https://oidc.us-east-1.amazonaws.com/",
    what: "AWS SSO OIDC: выдача device-кода и токенов для Builder ID / IDC",
    critical: true,
    hint: "Если недоступен, но вход через Google/GitHub работает — используйте его (или Auto-Import/токен/ключ).",
  },
  {
    host: "view.awsapps.com",
    url: "https://view.awsapps.com/start",
    what: "страница AWS, где вводится код подтверждения при входе через Builder ID",
    critical: false,
    hint: "Без неё не завершить вход по коду. Попробуйте открыть эту ссылку на телефоне — код можно вводить с любого устройства.",
  },
  {
    host: "kiro.dev",
    url: "https://kiro.dev/",
    what: "сайт Kiro (регистрация, документация, статус)",
    critical: false,
    hint: "Сайт может быть недоступен из вашей сети/региона: проверьте доступ с телефона по мобильному интернету.",
  },
  {
    host: "accounts.google.com",
    url: "https://accounts.google.com/",
    what: "вход через Google (используется в социальном сценарии)",
    critical: false,
    hint: "Если Google недоступен, попробуйте вход через GitHub.",
  },
  {
    host: "github.com",
    url: "https://github.com/",
    what: "вход через GitHub (используется в социальном сценарии)",
    critical: false,
    hint: "Если GitHub недоступен, попробуйте вход через Google.",
  },
];

const HOSTS_FILE = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

function line(mark, name, text) {
  const width = 40;
  const label = String(name).padEnd(width).slice(0, width);
  console.log(`  [${mark}] ${label} ${text ?? ""}`);
}

async function resolveHost(host, timeoutMs) {
  const withTimeout = Promise.race([
    dns.promises.lookup(host, { all: true, verbatim: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), timeoutMs)),
  ]);
  const records = await withTimeout;
  return records.map((r) => r.address);
}

async function probe(url, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "kiro-check/1.0 (OmniRoute diagnostics)" },
    });
    return {
      ok: true,
      status: res.status,
      ms: Date.now() - started,
      date: res.headers.get("date") || "",
    };
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.code || err?.name || "error";
    return { ok: false, status: 0, ms: Date.now() - started, error: String(cause), date: "" };
  }
}

async function probeLocal(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/api/monitoring/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 200), url };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.cause?.code || err?.code || err?.message), url };
  }
}

function omnirouteConnectionsList(bin, args) {
  let res;
  try {
    res = spawnSync(bin, args, {
      encoding: "utf8",
      shell: true,
      timeout: 60000,
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, reason: "error", detail: String(err?.message || err) };
  }
  if (res.error) {
    return {
      ok: false,
      reason: "error",
      detail: String(res.error.code === "ENOENT" ? "не найден в PATH" : res.error.message),
    };
  }
  if (res.status !== 0) {
    // Команда нашлась, но не отработала: чаще всего не запущен сам шлюз.
    const detail = (res.stdout || res.stderr || "").replace(/\s+/g, " ").trim().slice(0, 120);
    return { ok: false, reason: "exit", status: res.status, detail };
  }
  try {
    const start = res.stdout.indexOf("{");
    if (start < 0) return { ok: false, reason: "error", detail: `неожиданный ответ команды ${args.join(" ")}` };
    const data = JSON.parse(res.stdout.slice(start));
    // providers list -> { providers }, providers status -> { count, connections }, API -> { list }
    const list = Array.isArray(data.providers)
      ? data.providers
      : Array.isArray(data.connections)
        ? data.connections
        : Array.isArray(data.list)
          ? data.list
          : null;
    if (!list) return { ok: false, reason: "error", detail: "в ответе нет списка подключений" };
    return { ok: true, list, count: typeof data.count === "number" ? data.count : list.length };
  } catch (err) {
    return { ok: false, reason: "error", detail: String(err?.message || err) };
  }
}

function omnirouteKiroConnections() {
  const candidates = process.platform === "win32" ? ["omniroute.cmd", "omniroute"] : ["omniroute"];
  let lastError = "";
  let exitNote = null;
  for (const bin of candidates) {
    // База подключений — источник истины; providers status читает другой,
    // счётчик истечения токенов, и для ключей без срока действия пуст.
    const attempts = [
      ["providers", "list", "--json"],
      ["providers", "status", "--json"],
    ];
    let best = null;
    let bestCount = -1;
    for (const args of attempts) {
      const got = omnirouteConnectionsList(bin, args);
      if (got.ok) {
        if (got.list.length > bestCount) {
          best = got;
          bestCount = got.list.length;
        }
      } else if (got.reason === "exit") {
        exitNote = got;
        lastError = got.detail;
      } else {
        lastError = got.detail;
      }
    }
    if (best) {
      const kiro = best.list.filter((item) =>
        String(item.provider || item.id || "").toLowerCase().includes("kiro")
      );
      return {
        ok: true,
        total: best.count,
        kiro: kiro.length,
        names: kiro.map((k) => k.name || k.provider),
      };
    }
    if (exitNote) {
      return { ok: false, reason: "exit", status: exitNote.status, detail: exitNote.detail, total: -1, kiro: -1, names: [] };
    }
  }
  return { ok: false, reason: "error", detail: lastError, total: -1, kiro: -1, names: [] };
}

function proxyEnv() {
  const found = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(https?|all|ftp)_proxy$/i.test(key)) continue;
    if (value) found.push(`${key}=${value}`);
  }
  return found;
}

function windowsSystemProxy() {
  if (process.platform !== "win32") return null;
  try {
    const query = (value) =>
      spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", value], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      }).stdout || "";
    const enabled = /0x1/.test(query("ProxyEnable"));
    if (!enabled) return { enabled: false, server: "" };
    const server = (query("ProxyServer").match(/REG_SZ\s+(.*)/) || [])[1]?.trim() || "";
    return { enabled: true, server };
  } catch {
    return null;
  }
}

function hostsEntries(hosts) {
  try {
    const text = fs.readFileSync(HOSTS_FILE, "utf8");
    const hits = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const lineText = rawLine.split("#")[0].trim();
      if (!lineText) continue;
      for (const host of hosts) {
        if (new RegExp(`(^|\\s)${host.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}(\\s|$)`, "i").test(lineText)) {
          hits.push(lineText);
        }
      }
    }
    return hits;
  } catch {
    return [];
  }
}

function clockSkew(dateHeader, localDate) {
  if (!dateHeader) return null;
  const serverTime = Date.parse(dateHeader);
  if (Number.isNaN(serverTime)) return null;
  return Math.round((localDate.getTime() - serverTime) / 1000);
}

const MASK = (value) => {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 6)}…(${text.length} симв.)`;
};

const ANTHROPIC_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

function isLocalUrl(value) {
  try {
    const url = new URL(String(value));
    return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(url.hostname);
  } catch {
    return null; // не URL — не наша забота
  }
}

/** Куда на самом деле смотрит Claude Code: переменные окружения и settings.json. */
function clientTarget(port) {
  const env = {};
  for (const key of ANTHROPIC_ENV_KEYS) {
    if (process.env[key]) env[key] = MASK(process.env[key]);
  }
  const files = [];
  const foreign = [];
  const candidates = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
    path.join(process.cwd(), ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.local.json"),
  ];
  const expected = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const checkUrl = (where, value) => {
    if (!value || typeof value !== "string") return;
    const local = isLocalUrl(value);
    if (local === false) foreign.push({ where, url: value });
    else if (local === true && !expected.includes(value.replace(/\/$/, ""))) {
      foreign.push({ where, url: `${value} (другой порт, ожидался ${port})` });
    }
  };
  checkUrl("ANTHROPIC_BASE_URL (переменная)", process.env.ANTHROPIC_BASE_URL);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      files.push({ path: file, error: String(err?.message || err) });
      continue;
    }
    const envBlock = data && typeof data.env === "object" && data.env ? data.env : {};
    const shown = {};
    for (const [key, value] of Object.entries(envBlock)) {
      if (/^(ANTHROPIC|CLAUDE_CODE)/i.test(key)) shown[key] = MASK(value);
    }
    files.push({ path: file, env: shown, count: Object.keys(envBlock).length });
    checkUrl(`${file} → env.ANTHROPIC_BASE_URL`, envBlock.ANTHROPIC_BASE_URL);
  }
  return { env, files, foreign };
}

/** Один короткий запрос через локальный шлюз: видно, кто отвечает и чем. */
async function gatewayTestCall(port, timeoutMs, apiKey, providerId) {
  const url = `http://127.0.0.1:${port}/v1/messages`;
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": `kiro-check/${TOOL_VERSION} (OmniRoute diagnostics)`,
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  // Пришпиливает конкретного провайдера: так видно, работает ли Kiro сам по себе,
  // когда обычная маршрутизация (auto) уходит на исчерпанного провайдера.
  if (providerId) headers["x-omniroute-provider"] = String(providerId);
  const body = {
    model: "auto",
    max_tokens: 16,
    messages: [{ role: "user", content: "Ответь одним словом: ping" }],
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 15000)),
    });
    const text = await res.text();
    const interesting = {};
    for (const [key, value] of res.headers.entries()) {
      if (/^(x-omniroute|x-request|retry-after)/i.test(key)) interesting[key] = value;
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: interesting,
      body: text.slice(0, 1200),
      url,
      provider: providerId || null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: String(err?.cause?.code || err?.code || err?.message),
      url,
    };
  }
}

async function main({ flags }) {
  if (flagOn(flags, ["help", "h", "?"])) {
    console.log(HELP);
    return 0;
  }

  if (flagOn(flags, ["version", "v"])) {
    console.log(`kiro-check v${TOOL_VERSION}`);
    return 0;
  }
  const timeoutMs = Number(flagValue(flags, ["timeout"], "8000")) || 8000;
  const port = String(flagValue(flags, ["port"], process.env.OMNIROUTE_PORT || "20128"));
  const asJson = flagOn(flags, ["json"]);

  const results = { tool: "kiro-check", version: TOOL_VERSION, at: new Date().toISOString(), targets: [], local: {}, env: {}, verdicts: [] };

  const dnsCache = new Map();
  for (const target of TARGETS) {
    let addresses = null;
    let dnsError = null;
    try {
      addresses = await resolveHost(target.host, timeoutMs);
    } catch (err) {
      dnsError = String(err?.code || err?.message || err);
    }
    const http = await probe(target.url, timeoutMs);
    results.targets.push({ ...target, addresses, dnsError, http });
    dnsCache.set(target.host, addresses);
  }

  results.local.omniroute = await probeLocal(port, timeoutMs);
  results.local.connections = omnirouteKiroConnections();
  results.client = clientTarget(port);
  if (flagOn(flags, ["test-call", "test"])) {
    results.testCall = await gatewayTestCall(
      port,
      timeoutMs,
      flagValue(flags, ["api-key"], null),
      flagValue(flags, ["provider"], null)
    );
  }
  results.env.proxy = proxyEnv();
  results.env.winProxy = windowsSystemProxy();
  results.env.hosts = hostsEntries(TARGETS.map((t) => t.host));
  const withDate = results.targets.find((t) => t.http.ok && t.http.date);
  results.env.clockSkewSec = withDate ? clockSkew(withDate.http.date, new Date()) : null;
  results.env.platform = `${process.platform} ${os.release()} · Node ${process.version}`;

  /* ------------------------------- проба ------------------------------- */

  if (flagOn(flags, ["probe-kiro", "probe"])) {
    const loginProvider = /^github$/i.test(String(flagValue(flags, ["login-provider"], "google")))
      ? "Github"
      : "Google";
    results.probe = await runKiroSocialProbe({ loginProvider, timeoutMs });
  }

  /* ------------------------------ вердикт ------------------------------ */

  const failedTargets = results.targets.filter((t) => !t.http.ok || t.dnsError);
  const kiroAuthDown = failedTargets.some((t) => t.host.startsWith("prod.us-east-1.auth.desktop.kiro.dev"));
  const awsDown = failedTargets.some((t) => t.host === "oidc.us-east-1.amazonaws.com");
  const clockOff = results.env.clockSkewSec !== null && Math.abs(results.env.clockSkewSec) > 300;
  const exitCode =
    (kiroAuthDown && awsDown) || !results.local.omniroute.ok || clockOff ? 1 : 0;
  results.exitCode = exitCode;
  results.summary = {
    failedHosts: failedTargets.map((t) => t.host),
    kiroAuthDown,
    awsDown,
    gatewayUp: Boolean(results.local.omniroute.ok),
    clockOff,
    foreignBaseUrl: results.client.foreign.map((f) => `${f.where}=${f.url}`),
  };

  /* ------------------------------- вывод ------------------------------- */

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return exitCode;
  }

  banner(`kiro-check — доступность сервисов авторизации Kiro (v${TOOL_VERSION})`);

  console.log("  Домены и сервисы:");
  for (const t of results.targets) {
    if (t.dnsError) {
      line("x", t.host, `DNS не разрешается (${t.dnsError})`);
    } else if (!t.http.ok) {
      line("x", t.host, `нет соединения: ${t.http.error} (${t.http.ms} мс)`);
    } else {
      const mark = t.http.status >= 500 ? "!" : "+";
      line(mark, t.host, `HTTPS ${t.http.status}, ${t.http.ms} мс`);
    }
    console.log(`        ${t.what}`);
  }

  console.log("");
  console.log("  Локальный шлюз OmniRoute:");
  const local = results.local.omniroute;
  if (local.ok) {
    line("+", `http://127.0.0.1:${port}`, `отвечает: ${local.body.replace(/\s+/g, " ").slice(0, 80)}`);
  } else {
    line("x", `http://127.0.0.1:${port}`, `не отвечает (${local.error || local.status}) — запустите: omniroute serve --daemon --no-open`);
  }
  const conn = results.local.connections;
  if (conn.ok) {
    line(conn.kiro > 0 ? "+" : "!", "Подключения Kiro", conn.kiro > 0 ? `${conn.kiro} (${conn.names.join(", ")}), всего подключений: ${conn.total}` : `нет ни одного (всего подключений: ${conn.total}) — добавьте в Dashboard → Providers`);
  } else if (conn.reason === "exit") {
    line("!", "Подключения Kiro", `команда omniroute ответила кодом ${conn.status} — вероятно, шлюз не запущен${conn.detail ? ` (${conn.detail})` : ""}`);
  } else {
    line("!", "Подключения Kiro", `не удалось получить: ${conn.detail || "неизвестная причина"}`);
  }

  console.log("");
  console.log("  Клиент Claude Code (куда уходят запросы):");
  const client = results.client;
  const envKeys = Object.keys(client.env);
  const baseVar = client.env.ANTHROPIC_BASE_URL;
  if (client.foreign.length === 0) {
    if (baseVar) {
      line("+", "ANTHROPIC_BASE_URL", baseVar);
    } else {
      line("+", "ANTHROPIC_BASE_URL", `не задан — Claude Code возьмёт адрес из запуска (freeclaude → http://localhost:${port})`);
    }
  } else {
    line("!", "Чужой адрес API", client.foreign.map((f) => `${f.where}: ${f.url}`).join(" · "));
    console.log("        Запросы уходят НЕ в ваш шлюз — отсюда ошибки 429/401 и «Budget has been exceeded».");
    console.log("        Уберите ANTHROPIC_BASE_URL из переменных среды и из .claude\\settings.json, затем запустите freeclaude заново.");
  }
  const otherVars = envKeys.filter((k) => k !== "ANTHROPIC_BASE_URL");
  if (otherVars.length) {
    line("+", "Переменные ANTHROPIC_*", otherVars.map((k) => `${k}=${client.env[k]}`).join(", "));
  }
  for (const file of client.files) {
    if (file.error) {
      line("!", "settings.json", `${file.path} — не удалось прочитать: ${file.error}`);
      continue;
    }
    const keys = Object.keys(file.env || {});
    line("+", "settings.json", `${file.path}${keys.length ? ` → ${keys.map((k) => `${k}=${file.env[k]}`).join(", ")}` : " (настройки Claude Code не заданы)"}`);
  }

  if (results.testCall) {
    const tc = results.testCall;
    console.log("");
    console.log(
      `  Пробный запрос через шлюз${results.testCall.provider ? ` (провайдер ${results.testCall.provider})` : " (model auto)"}, 16 токенов:`
    );
    if (tc.error) {
      line("x", tc.url, `соединения нет: ${tc.error} — шлюз не запущен?`);
    } else {
      const mark = tc.ok ? "+" : "!";
      line(mark, tc.url, `HTTP ${tc.status}`);
      for (const [key, value] of Object.entries(tc.headers)) {
        console.log(`        ${key}: ${value}`);
      }
      const body = tc.body.replace(/\s+/g, " ").trim();
      console.log(`        ответ: ${body.slice(0, 300)}${body.length > 300 ? "…" : ""}`);
      if (/budget/i.test(tc.body) && /exceed/i.test(tc.body)) {
        line("!", "Вердикт", "бюджет исчерпан на стороне провайдера, которому шлюз передал запрос");
        console.log("        Проверьте, какие провайдеры подключены (omniroute providers list) и на кого ушёл запрос (Dashboard → Логи).");
        console.log("        Обходной путь: модель конкретного провайдера или заголовок x-omniroute-provider.");
      } else if (tc.status === 401 || tc.status === 403) {
        line("!", "Вердикт", "шлюз требует ключ: передайте его флагом --api-key <ключ OmniRoute>");
      } else if (tc.ok) {
        line("+", "Вердикт", "шлюз отвечает — связка Claude Code → OmniRoute → провайдер работает");
      }
    }
  }

  console.log("");
  console.log("  Окружение:");
  if (results.env.proxy.length) {
    line("!", "Переменные прокси", results.env.proxy.join(", "));
    console.log("        Сервер шлюза пойдёт через этот прокси за токенами — проверьте, что он пропускает amazonaws.com и kiro.dev");
  } else {
    line("+", "Переменные прокси", "не заданы");
  }
  if (results.env.winProxy?.enabled) {
    line("!", "Системный прокси Windows", results.env.winProxy.server || "(включён)");
  }
  if (results.env.hosts.length) {
    line("!", "Файл hosts", `есть записи: ${results.env.hosts.join(" | ")}`);
  } else {
    line("+", "Файл hosts", "записей для доменов Kiro нет");
  }
  if (results.env.clockSkewSec === null) {
    line("!", "Часы системы", "не удалось сверить с сервером (нет доступных серверов) — проверьте дату и время вручную");
  } else {
    const skew = results.env.clockSkewSec;
    line(Math.abs(skew) <= 60 ? "+" : "!", "Часы системы", `расхождение ${skew} с (${Math.abs(skew) <= 60 ? "норма" : "исправьте время — device-код не сработает"})`);
  }
  line("+", "Платформа", results.env.platform);

  /* ------------------------------ диагноз ------------------------------ */

  const failed = failedTargets;
  const googleDown = failed.some((t) => t.host === "accounts.google.com");
  const githubDown = failed.some((t) => t.host === "github.com");

  if (results.probe) {
    const probe = results.probe;
    console.log("");
    console.log(`  Проба входа через ${probe.loginProvider} (${probe.baseUrl}):`);
    for (const line of formatResponse("1) запрос device-кода", probe.authorize)) console.log(line);
    if (probe.authorize.data) {
      const shape = probe.shape;
      const missing = [];
      if (!shape.deviceCode) missing.push("deviceCode");
      if (!shape.userCode) missing.push("userCode");
      if (!shape.verificationUriComplete) missing.push("verificationUriComplete");
      line(
        missing.length ? "!" : "+",
        "   поля ответа",
        missing.length ? `нет: ${missing.join(", ")}` : "deviceCode, userCode, ссылка — на месте"
      );
    }
    if (probe.poll) {
      for (const lineText of formatResponse("2) опрос device-кода", probe.poll)) console.log(lineText);
      const mark = probe.pollClassification === "pending" ? "+" : probe.pollClassification === "success" ? "+" : "!";
      line(mark, "   классификация", probe.pollClassification);
    }
    console.log("");
    console.log("  Что это значит:");
    for (const rec of probeRecommendations(probe)) console.log(`    • ${rec}`);
  }

  console.log("");
  console.log("  ------------------------------------------------------------");
  console.log("  Диагноз:");

  if (failed.length === 0) {
    console.log("    Все домены доступны, сеть не при чём.");
    console.log("    Значит дело в браузере или в самом окне авторизации:");
    console.log("      • откройте ссылку из окна авторизации в режиме инкогнито;");
    console.log("      • отключите блокировщики рекламы и DNS-фильтры для этих доменов;");
    console.log("      • код живёт 5 минут — если окно провисело, закройте и начните заново;");
    console.log("      • ссылку можно открыть на телефоне, код — ввести там же.");
  } else {
    for (const t of failed) {
      console.log(`    • ${t.host} — недоступен. ${t.hint}`);
    }
    if (kiroAuthDown && !awsDown) {
      console.log("    • Прямой выход: вход через Builder ID (домен AWS отдельный) либо Auto-Import/Import Token/API Key в Dashboard → Providers → Kiro.");
    }
    if (awsDown && !kiroAuthDown) {
      console.log("    • Прямой выход: вход через Google/GitHub (домен Kiro отдельный) либо Auto-Import/Import Token/API Key.");
    }
    if (googleDown && !githubDown) console.log("    • Google недоступен — используйте вход через GitHub.");
    if (githubDown && !googleDown) console.log("    • GitHub недоступен — используйте вход через Google.");
    if (results.env.proxy.length || results.env.winProxy?.enabled) {
      console.log("    • Обнаружен прокси: если он фильтрует домены, задайте прокси для провайдера в Dashboard → Settings → Proxies.");
    }
    if (!results.local.omniroute.ok) {
      console.log("    • Сам шлюз OmniRoute не отвечает — сначала поднимите его: omniroute serve --daemon --no-open");
    }
  }
  console.log("  ------------------------------------------------------------");
  console.log("  Подробный разбор: docs/KIRO_TROUBLESHOOTING.md");
  console.log("  Для отправки в чат: kiro-check --json > kiro-check.json");
  console.log("");

  return exitCode;
}

const parsed = parseArgs(process.argv.slice(2));
try {
  process.exitCode = await main(parsed);
} catch (err) {
  console.log("");
  console.log(`  [ОШИБКА] ${err && err.message ? err.message : String(err)}`);
  console.log("");
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
} finally {
  if (hasTTY && process.env.ARENA_PAUSE === "1") await maybePause(parsed.flags);
}
