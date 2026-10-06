#!/usr/bin/env node
/**
 * kiro-check.mjs — проверка доступности сервисов авторизации Kiro.
 *
 * Отвечает на вопрос «почему не открывается портал Kiro / не подключается провайдер»:
 * проверяет DNS и HTTPS для каждого домена, задействованного во входе,
 * состояние локального шлюза OmniRoute, прокси, часы и файл hosts.
 *
 *   node kiro-check.mjs [--json] [--port 20128] [--timeout 8000] [--no-pause]
 *
 * v1.7: разбирает ANTHROPIC_AUTH_TOKEN у клиента — это пропуск в локальный шлюз,
 * а не токен Kiro/Anthropic. Инструмент говорит, что именно туда положено и что
 * с этим делать (частая путаница при подключении Kiro по OAuth).
 *
 * v1.8: --check-kiro-key — проверка API-ключа Kiro напрямую, ровно как это делает шлюз
 * при сохранении (ListAvailableProfiles, при необходимости — пробный запрос модели).
 * Прогоняет ключ по обоим регионам профиля (us-east-1 и eu-central-1) и объясняет
 * вердикт, включая случай «Invalid Kiro API key or AWS region» в дашборде.
 */

import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
    kiro-check --test-call --model kr/claude-sonnet-4.5    конкретная модель
    kiro-check --test-call --api-key <ключ>   если на шлюзе задан REQUIRE_API_KEY
    kiro-check --check-kiro-key "<ключ>"      проверить API-ключ Kiro до похода в дашборд
    kiro-check --check-kiro-key "<ключ>" --region eu-central-1   только один регион
    kiro-check --port 20128 --timeout 8000
    kiro-check --version
    kiro-check --help

  Проба (--probe-kiro) делает два настоящих запроса к Kiro: просит device-код
  и один раз его опрашивает — ровно как это делает OmniRoute. Ничего не
  подтверждает и не меняет; код живёт ~5 минут и сам истекает.

  Проверка клиента (в отчёте) показывает, куда на самом деле смотрит Claude
  Code: переменные ANTHROPIC_* и файл ~/.claude/settings.json. Если там чужой
  адрес — запросы уходят мимо вашего шлюза (частая причина ошибок 429).

  Отдельно разбирается ANTHROPIC_AUTH_TOKEN: это пропуск в ваш локальный шлюз,
  а НЕ токен Kiro и не токен Anthropic. Инструмент покажет, что там лежит
  (ключ OmniRoute sk-…, служебное значение, токен Kiro/AWS) и что с этим делать.
  Для подключения Kiro по OAuth (Учётная запись OAuth) заполнять его не нужно.

  Проверка ключа (--check-kiro-key) повторяет то, что делает шлюз при сохранении:
  ListAvailableProfiles, а при необходимости — пробный запрос модели. Сразу видно,
  принят ли ключ и в каком регионе, поэтому в дашборде («Invalid Kiro API key or
  AWS region») уже не нужно угадывать. Регионы профиля у Kiro только два:
  us-east-1 и eu-central-1 — по умолчанию проверяются оба. Ключ печатается
  замаскированным и никуда не сохраняется. --aws-base — служебный флаг для
  проверки через свой прокси/макет.

  --test-call отправляет в ваш локальный шлюз один короткий запрос (model auto,
  16 токенов) и печатает статус, тело ответа и служебные заголовки OmniRoute.
  Он же разбирает частые ответы: «Ambiguous model» (нужен префикс провайдера),
  «Budget has been exceeded» (бюджет чужого шлюза) и 403 от Kiro
  («The bearer token ... is invalid» — подключение Kiro не принято).
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
    // Одна строка команды вместо массива: Node предупреждает (DEP0190) о
    // передаче аргументов вместе с shell:true. Аргументы здесь — только
    // литералы ("providers", "list", "--json"), подстановки извне нет.
    res = spawnSync(`${bin} ${args.join(" ")}`, {
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
/** Что за значение лежит в ANTHROPIC_AUTH_TOKEN: пропуск в шлюз или чужой токен. */
function classifyClientToken(raw) {
  const value = String(raw || "").trim();
  if (!value) return "empty";
  if (value === "omniroute-no-auth") return "sentinel";
  if (/^sk-/.test(value)) return "omniroute";
  // Токены Kiro/AWS: OAuth-аккаунт (aoa…), refresh-токен (aor…), старый формат.
  if (/^(?:aoa|aor|AQAAA)[A-Za-z0-9._-]{8,}$/i.test(value)) return "kiro";
  // Токен доступа в формате JWT (IDC / Builder ID / чужие шлюзы).
  if (/^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(value)) return "jwt";
  return "other";
}

const TOKEN_TEXT = {
  sentinel: "служебное значение freeclaude — шлюз принимает его, пока REQUIRE_API_KEY выключен (по умолчанию)",
  omniroute: "ключ OmniRoute, всё верно",
  kiro: "это токен Kiro/AWS, а не ключ шлюза",
  jwt: "похоже на токен доступа (JWT), а не на ключ шлюза",
  other: "произвольное значение — шлюз примет его, только если REQUIRE_API_KEY выключен (по умолчанию)",
};

const KIRO_TOKEN_HINT = [
  "Токены Kiro живут в подключении на шлюзе (Dashboard → Providers → Kiro), а не здесь.",
  "Если Kiro подключён по OAuth (Учётная запись OAuth) — в ANTHROPIC_AUTH_TOKEN писать нечего: он к Kiro не относится.",
  "Оставьте там ключ OmniRoute (sk-…) или вообще ничего — freeclaude подставит служебное значение.",
];

function clientTarget(port) {
  const env = {};
  for (const key of ANTHROPIC_ENV_KEYS) {
    if (process.env[key]) env[key] = MASK(process.env[key]);
  }
  const files = [];
  const auth = [];
  const foreign = [];
  const notes = [];
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

  // Токен клиента. ANTHROPIC_AUTH_TOKEN — это пропуск в ваш шлюз, поэтому его
  // содержимое не имеет отношения к способу подключения Kiro (OAuth/ключ).
  const checkToken = (where, value) => {
    const kind = classifyClientToken(value);
    if (kind === "empty") return;
    const item = {
      label: "ANTHROPIC_AUTH_TOKEN",
      where,
      shown: MASK(value),
      kind,
      text: TOKEN_TEXT[kind],
      hint: kind === "kiro" || kind === "jwt" ? KIRO_TOKEN_HINT : [],
    };
    auth.push(item);
  };
  // ANTHROPIC_API_KEY перебивает Bearer-токен (уходит как x-api-key) и включает
  // у Claude Code экран «Detected a custom API key…» — его лучше не задавать.
  const checkApiKeyVar = (where, value) => {
    if (!value || typeof value !== "string" || !value.trim()) return;
    auth.push({
      label: "ANTHROPIC_API_KEY",
      where,
      shown: MASK(value),
      kind: "apikey",
      text: "лишний: Claude Code отправит его как x-api-key и покажет экран «Detected a custom API key…»",
      hint: [
        "Уберите его: если задавали в переменных среды — снимите значение, если в settings.json — удалите строку; затем перезапустите терминал.",
        "Токен шлюза должен ходить только как ANTHROPIC_AUTH_TOKEN.",
      ],
    });
  };
  checkToken("переменная", process.env.ANTHROPIC_AUTH_TOKEN);
  checkApiKeyVar("переменная", process.env.ANTHROPIC_API_KEY);

  // Модели: Claude Code просит имя без префикса, а шлюз требует префикс, когда
  // такую модель отдают несколько маршрутов (400 Ambiguous model).
  const MODEL_VARS = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  ];
  const checkModelVar = (where, key, value) => {
    if (!value || typeof value !== "string") return;
    const model = value.trim();
    if (!model.includes("/")) {
      notes.push({
        kind: "no-prefix",
        where: `${key} (${where})`,
        model,
        text: `${key} без префикса провайдера («${model}») — при нескольких подключениях шлюз ответит 400 Ambiguous model. Задайте kr/${model}`,
      });
      return;
    }
    if (/^kr\//.test(model) && /sonnet-5$/.test(model)) {
      notes.push({
        kind: "plan-gated",
        where: `${key} (${where})`,
        model,
        text: `${key} = ${model}: Kiro отдаёт эту модель не всем аккаунтам — если приходит 400 от Kiro, замените на kr/claude-sonnet-4.5`,
      });
    }
  };
  for (const key of MODEL_VARS) checkModelVar("переменная", key, process.env[key]);
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
      if (/^(ANTHROPIC|CLAUDE_CODE)/i.test(key) && key !== "ANTHROPIC_AUTH_TOKEN" && key !== "ANTHROPIC_API_KEY") {
        shown[key] = MASK(value);
      }
    }
    files.push({ path: file, env: shown, count: Object.keys(envBlock).length });
    checkUrl(`${file} → env.ANTHROPIC_BASE_URL`, envBlock.ANTHROPIC_BASE_URL);
    checkToken(`${file} → env`, envBlock.ANTHROPIC_AUTH_TOKEN);
    checkApiKeyVar(`${file} → env`, envBlock.ANTHROPIC_API_KEY);
    for (const key of MODEL_VARS) checkModelVar(path.basename(path.dirname(file)), key, envBlock[key]);
  }
  return { env, files, auth, foreign, notes };
}

/* ---------------- проверка API-ключа Kiro (как при сохранении) ---------------- */

/** Регионы, где AWS размещает профиль Q Developer (то есть где работает ключ). */
const KIRO_KEY_REGIONS = ["us-east-1", "eu-central-1"];

/** Хост CodeWhisperer/Amazon Q для региона: us-east-1 — старый, остальные — q.<регион>. */
function kiroAwsHost(region, awsBase) {
  if (awsBase) return String(awsBase).replace(/\/+$/, "");
  return region === "us-east-1"
    ? "https://codewhisperer.us-east-1.amazonaws.com"
    : `https://q.${region}.amazonaws.com`;
}

/** Короткий текст ошибки AWS: поле message, иначе первые символы ответа. */
function shortAwsError(text) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return "";
  const quoted = body.match(/"message"\s*:\s*"([^"]{1,220})"/);
  if (quoted) return quoted[1];
  return body.slice(0, 200);
}

/** ARN профиля из ответа ListAvailableProfiles: сначала совпадающий по региону. */
function profileArnFromListing(text, region) {
  try {
    const data = JSON.parse(String(text || ""));
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const arnOf = (p) => p?.arn || p?.profileArn || null;
    const match =
      profiles.find((p) => String(arnOf(p) || "").includes(`:${region}:`)) || profiles[0];
    return arnOf(match) || null;
  } catch {
    return null;
  }
}

/** Код сетевой ошибки fetch: ECONNREFUSED/ENOTFOUND/ETIMEDOUT и т.п. */
function netErrorText(err) {
  const cause = err?.cause;
  const code = cause?.errors?.[0]?.code || cause?.code || err?.code;
  return String(code || cause?.message || err?.message || err);
}

async function awsPost(host, path, headers, body, timeoutMs) {
  try {
    const res = await fetch(`${host}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(timeoutMs, 15000)),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text: String(text || "").slice(0, 800) };
  } catch (err) {
    return { status: 0, ok: false, error: netErrorText(err) };
  }
}

/** ListAvailableProfiles с tokentype: API_KEY — первый шаг проверки в OmniRoute. */
function kiroListProfiles(host, key, timeoutMs) {
  return awsPost(
    host,
    "/",
    {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-amz-json-1.0",
      "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
      Accept: "application/json",
      tokentype: "API_KEY",
    },
    { maxResults: 10 },
    timeoutMs
  );
}

/** Пробный запрос модели — то, что шлюз делает, если профиль не нашёлся. */
function kiroRuntimeProbe(host, key, timeoutMs) {
  return awsPost(
    host,
    "/generateAssistantResponse",
    {
      Authorization: `Bearer ${key}`,
      tokentype: "API_KEY",
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      Accept: "application/vnd.amazon.eventstream",
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": crypto.randomUUID(),
    },
    {
      conversationState: {
        chatTriggerType: "MANUAL",
        conversationId: crypto.randomUUID(),
        currentMessage: { userInputMessage: { content: "ping", modelId: "auto", origin: "AI_EDITOR" } },
        history: [],
      },
      inferenceConfig: { maxTokens: 1 },
    },
    timeoutMs
  );
}

function classifyListing(res, region) {
  if (res.error) return { outcome: "network", detail: res.error };
  if (res.ok) {
    const arn = profileArnFromListing(res.text, region);
    return arn
      ? { outcome: "accepted", method: "ListAvailableProfiles", detail: `профиль ${arn}` }
      : { outcome: "no-profile", detail: "ключ принят, но профилей нет" };
  }
  const detail = shortAwsError(res.text) || `HTTP ${res.status}`;
  if (/API key authentication is not supported/i.test(res.text || "")) {
    return { outcome: "unsupported", status: res.status, detail };
  }
  if (res.status === 401 || res.status === 403) {
    return { outcome: "denied", status: res.status, detail };
  }
  return { outcome: "error", status: res.status, detail };
}

/** Проверка одного региона: листинг профилей, при необходимости — пробный запрос. */
async function checkKiroKeyInRegion(key, region, awsBase, timeoutMs) {
  const host = kiroAwsHost(region, awsBase);
  const attempts = [];
  const listing = await kiroListProfiles(host, key, timeoutMs);
  const verdict = classifyListing(listing, region);
  attempts.push(
    verdict.outcome === "network"
      ? `ListAvailableProfiles: соединения нет (${listing.error})`
      : `ListAvailableProfiles: HTTP ${listing.status}${verdict.outcome === "accepted" ? " — профиль найден" : ""}`
  );

  let result = { ...verdict, region };
  if (verdict.outcome === "no-profile" || verdict.outcome === "unsupported") {
    // Ровно то же делает OmniRoute: профиль не получен — пробуем живой запрос модели.
    const probe = await kiroRuntimeProbe(host, key, timeoutMs);
    attempts.push(
      probe.error ? `пробный запрос: соединения нет (${probe.error})` : `пробный запрос: HTTP ${probe.status}`
    );
    if (probe.error) {
      result = { region, outcome: "network", detail: probe.error };
    } else if (probe.ok) {
      result = { region, outcome: "accepted", method: "generateAssistantResponse", detail: "пробный запрос модели прошёл" };
    } else if ([400, 422, 429].includes(probe.status)) {
      result = { region, outcome: "accepted", method: `generateAssistantResponse_${probe.status}`, detail: `HTTP ${probe.status} — шлюз считает такой ответ рабочим` };
    } else if (probe.status === 401 || probe.status === 403) {
      result = { region, outcome: "unsupported", status: probe.status, detail: shortAwsError(probe.text) || `HTTP ${probe.status} AccessDenied` };
    } else {
      result = { region, outcome: "error", status: probe.status, detail: shortAwsError(probe.text) || `HTTP ${probe.status}` };
    }
  }
  return { ...result, attempts };
}

/** Проверка ключа по регионам + человеческий вердикт. Ключ нигде не печатается целиком. */
async function kiroKeyCheck(key, regions, awsBase, timeoutMs) {
  const clean = String(key || "").trim();
  const out = { key: MASK(clean), prefixOk: /^ksk_/i.test(clean), regions: [], verdict: [] };
  if (!clean) {
    out.verdict.push("Ключ не задан. Пример: kiro-check --check-kiro-key \"ksk_...\"");
    return out;
  }
  for (const region of regions) {
    out.regions.push(await checkKiroKeyInRegion(clean, region, awsBase, timeoutMs));
  }

  const accepted = out.regions.filter((r) => r.outcome === "accepted");
  const unsupported = out.regions.filter((r) => r.outcome === "unsupported");
  const denied = out.regions.filter((r) => r.outcome === "denied");
  const netErr = out.regions.filter((r) => r.outcome === "network");

  if (accepted.length) {
    const list = accepted.map((r) => r.region).join(", ");
    out.verdict.push(
      `Ключ принят (${list}). В Dashboard → Providers → Kiro укажите «Регион AWS» = ${accepted[0].region} и нажмите «Проверить и сохранить API-ключ».`
    );
    if (accepted.length < out.regions.length) {
      out.verdict.push("В другом регионе тот же ключ не работает — ключи Kiro привязаны к региону, где выдан ключ.");
    }
  } else if (unsupported.length) {
    out.verdict.push(
      "Kiro не принимает этот ключ на вызовах, которыми пользуется шлюз — сохранить его не получится (в дашборде это и есть «Invalid Kiro API key or AWS region»)."
    );
    out.verdict.push(
      "Скорее всего ключ не предназначен для CodeWhisperer-вызовов: подключите Kiro через Builder ID, Auto-Import или Import Token."
    );
  } else if (denied.length === out.regions.length && denied.length > 0) {
    out.verdict.push(
      "Ключ отклонён в обоих регионах: он неверный или отозван, скопирован не полностью либо выдан в другом регионе."
    );
    out.verdict.push(
      "Пересоздайте API-ключ Kiro (он начинается с ksk_) и повторите; если не помогает — подключите Kiro способом без ключа (Builder ID / Auto-Import / Import Token)."
    );
  } else if (netErr.length === out.regions.length && netErr.length > 0) {
    out.verdict.push(
      "Сеть не пускает к codewhisperer.us-east-1.amazonaws.com / q.<регион>.amazonaws.com — проверьте прокси и антивирус."
    );
  } else {
    out.verdict.push("Однозначного ответа нет — смотрите строки выше: там ответ AWS по каждому региону.");
  }
  if (!out.prefixOk) {
    out.verdict.push(
      "Ключ не начинается с ksk_ — это не похоже на API-ключ Kiro (refresh-токен aor… или AWS-ключ не подойдут)."
    );
  }
  return out;
}

/** Один короткий запрос через локальный шлюз: видно, кто отвечает и чем. */
async function gatewayTestCall(port, timeoutMs, apiKey, providerId, modelId) {
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
    model: modelId || "auto",
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
      model: modelId || "auto",
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
      flagValue(flags, ["provider"], null),
      flagValue(flags, ["model"], null)
    );
  }
  const keyCheckValue = flagValue(flags, ["check-kiro-key"], null);
  if (keyCheckValue !== null) {
    const regionArg = String(flagValue(flags, ["region"], "") || "").trim();
    const regions = regionArg ? [regionArg] : KIRO_KEY_REGIONS;
    for (const region of regions) {
      if (!/^[a-z]{2}-[a-z]+-\d{1,2}$/.test(region)) {
        throw new CliError(`Регион «${region}» не похож на AWS-регион (пример: us-east-1).`);
      }
    }
    results.keyCheck = await kiroKeyCheck(
      keyCheckValue,
      regions,
      String(flagValue(flags, ["aws-base"], "") || "").trim() || null,
      timeoutMs
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
  for (const note of client.notes) {
    line("!", "Модель", note.text);
  }
  if (client.auth.length) {
    for (const item of client.auth) {
      const bad = item.kind === "kiro" || item.kind === "jwt" || item.kind === "apikey";
      line(bad ? "!" : "+", item.label, `${item.shown} — ${item.text} (${item.where})`);
      for (const hint of item.hint || []) console.log(`        ${hint}`);
    }
  } else {
    line("+", "ANTHROPIC_AUTH_TOKEN", "не задан — freeclaude подставит служебное значение; шлюз примет его, пока REQUIRE_API_KEY выключен (по умолчанию)");
  }
  const otherVars = envKeys.filter(
    (k) => k !== "ANTHROPIC_BASE_URL" && k !== "ANTHROPIC_AUTH_TOKEN" && k !== "ANTHROPIC_API_KEY"
  );
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

  if (results.keyCheck) {
    const kc = results.keyCheck;
    console.log("");
    console.log("  Проверка API-ключа Kiro (то же, что делает шлюз при сохранении):");
    line("+", kc.key, kc.prefixOk ? "формат ksk_ — как у API-ключа Kiro" : "внимание: ключ Kiro начинается с ksk_");
    for (const r of kc.regions) {
      const mark = r.outcome === "accepted" ? "+" : r.outcome === "network" || r.outcome === "error" ? "x" : "!";
      line(mark, r.region, r.detail || r.outcome);
      for (const attempt of r.attempts || []) console.log(`        ${attempt}`);
    }
    for (const v of kc.verdict) console.log(`    • ${v}`);
  }

  if (results.testCall) {
    const tc = results.testCall;
    console.log("");
    console.log(
      `  Пробный запрос через шлюз (модель ${results.testCall.model}${results.testCall.provider ? `, провайдер ${results.testCall.provider}` : ""}, 16 токенов):`
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
      const kiroRejectedCredentials =
        /AccessDeniedException|bearer token[^"]*invalid|The bearer .*invalid/i.test(tc.body) &&
        tc.status === 403;
      if (kiroRejectedCredentials) {
        line("!", "Вердикт", "Kiro отклонил ваш ключ/токен: 403 AccessDeniedException («The bearer token … is invalid»).");
        console.log("        Это ответ AWS CodeWhisperer — то есть запрос дошёл до Kiro, но подключение больше не годится.");
        console.log("");
        console.log("        Порядок действий:");
        console.log("        1) проверьте ключ свежим: создайте новый API-ключ Kiro и вставьте заново");
        console.log("           (Dashboard → Providers → Kiro → «API ключ» → «Проверить и сохранить»);");
        console.log("        2) попробуйте старшую модель — с API-ключом новая линейка Kiro часто отвечает 403:");
        console.log("             kiro-check --test-call --provider kiro --model kr/claude-sonnet-4.5");
        console.log("        3) если 403 остаётся — подключите Kiro через OAuth вместо ключа:");
        console.log("           Builder ID (вход по коду), Auto-Import (если Kiro CLI/IDE уже настроен),");
        console.log("           Import Token (refresh-токен, начинается с aorAAAAAG…) — в Dashboard → Providers → Kiro.");
        console.log("        Подробно: docs/KIRO_TROUBLESHOOTING.md, раздел 4.2.");
      } else if (/ambiguous model/i.test(tc.body)) {
        line("!", "Вердикт", "Claude Code попросил модель без префикса провайдера, а её отдают сразу несколько маршрутов");
        const hint = (tc.body.match(/\(ex: ([^)]+)\)/) || [])[1];
        if (hint) console.log(`        OmniRoute предложил выбрать: ${hint}`);
        // Идентификаторы взяты из реестра OmniRoute (open-sse/config/providers/registry/kiro):
        // у Kiro своя линейка имён, «claude-sonnet-4-6» среди них нет.
        console.log("        У Kiro модели называются иначе: claude-sonnet-4.5, claude-sonnet-5, claude-haiku-4.5.");
        console.log("        Разовая попытка:  freeclaude --model kr/claude-sonnet-4.5");
        console.log('        Навсегда: добавьте в %USERPROFILE%\\.claude\\settings.json');
        console.log('          { "env": { "ANTHROPIC_MODEL": "kr/claude-sonnet-4.5" } }');
        console.log("        Посмотреть, что подключено: omniroute providers list");
      } else if (/budget/i.test(tc.body) && /exceed/i.test(tc.body)) {
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

  // Если всё в порядке, не пугаем советами про браузер: раньше этот блок печатался
  // всегда, когда домены доступны, даже когда вход уже завершён и дело не в нём.
  const kiroCount = results.local.connections.ok ? results.local.connections.kiro : -1;
  const allGood =
    failed.length === 0 && results.local.omniroute.ok && !clockOff && kiroCount > 0;

  if (allGood) {
    console.log("    • Сеть, шлюз и подключения Kiro в порядке — вход тут ни при чём.");
    if (client.foreign.length) {
      console.log("    • Но запросы идут мимо шлюза: в клиенте задан чужой ANTHROPIC_BASE_URL (см. выше).");
    } else if (client.notes.length) {
      console.log("    • Обратите внимание на замечания по модели (помечены [!] выше) — это частая причина 400 Ambiguous model.");
    } else {
      console.log("    • Если Claude Code всё ещё ругается — пришлите: kiro-check --test-call --provider kiro");
    }
    if (kiroCount > 1) {
      console.log(`    • Подключений Kiro несколько (${kiroCount}): проверьте каждое «Тестовым соединением» в Dashboard → Providers и удалите нерабочее — лишние маршруты дают неоднозначность модели.`);
    }
  } else if (failed.length === 0) {
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
  if (client.auth.some((a) => a.kind === "kiro" || a.kind === "jwt")) {
    console.log("    • ANTHROPIC_AUTH_TOKEN: там лежит токен Kiro, а нужен пропуск в шлюз — уберите его (подробности выше).");
  }
  if (client.auth.some((a) => a.kind === "apikey")) {
    console.log("    • ANTHROPIC_API_KEY лучше убрать совсем: он перебивает Bearer-токен и путает Claude Code.");
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
