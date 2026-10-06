#!/usr/bin/env node
/**
 * kiro-probe.mjs — проверка диагностики social-входа Kiro.
 *
 * Поднимает локальный макет Kiro (два эндпоинта) и проверяет, что инструмент
 * правильно распознаёт: корректное «ждём», ошибку, изменение формата (то самое
 * invalid_token_response) и ответ-не-JSON от прокси.
 *
 *   node tests/kiro-probe.mjs
 */

import http from "node:http";
import {
  classifyKiroPoll,
  runKiroSocialProbe,
  formatResponse,
  probeRecommendations,
} from "../tools/lib/kiro-probe.mjs";

let failed = 0;
let total = 0;
const ok = (name, cond, extra = "") => {
  total++;
  console.log(`  ${cond ? "OK  " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failed++;
};

/* ------------------------- классификация ответов ------------------------- */

console.log("\n1) Классификация ответов Kiro (копия правил OmniRoute)");
ok("pending через error", classifyKiroPoll(true, 200, { error: "authorization_pending" }) === "pending");
ok("pending через status", classifyKiroPoll(true, 200, { status: "authorization_pending" }) === "pending");
ok("slow_down", classifyKiroPoll(true, 200, { status: "slow_down" }) === "pending");
ok("ошибка по HTTP", classifyKiroPoll(false, 500, {}) === "error");
ok("ошибка в теле", classifyKiroPoll(true, 200, { error: "access_denied" }) === "error");
ok("токены — успех", classifyKiroPoll(true, 200, { accessToken: "aoaAAA" }) === "success");
ok(
  "2xx без токенов и без пометки — та самая ошибка",
  classifyKiroPoll(true, 200, { message: "ok", data: null }) === "invalid_token_response"
);

/* --------------------------- макет сервера Kiro -------------------------- */

function startMock(handlers) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const handler = handlers[req.url] || (() => ({ status: 404, json: { error: "not_found" } }));
      const out = handler({ body: body ? JSON.parse(body) : {}, method: req.method });
      res.writeHead(out.status ?? 200, { "content-type": out.contentType ?? "application/json" });
      res.end(out.raw ?? JSON.stringify(out.json ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const authorizeOk = {
  deviceCode: "device-123",
  userCode: "ABCD-EFGH",
  verificationUriComplete: "https://example.invalid/verify?code=ABCD-EFGH",
  expiresInMilliseconds: 300000,
  intervalInMilliseconds: 5000,
};

console.log("\n2) Проба: Kiro отвечает корректно (ещё ждём)");
{
  const { server, port } = await startMock({
    "/oauth/device/authorization": () => ({ status: 200, json: authorizeOk }),
    "/oauth/device/poll": () => ({ status: 200, json: { status: "authorization_pending" } }),
  });
  const result = await runKiroSocialProbe({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 4000 });
  ok("шаг 1 пройден", result.shape.deviceCode && result.shape.userCode && result.shape.verificationUriComplete);
  ok("опрос распознан как «ждём»", result.pollClassification === "pending", result.verdict);
  const recs = probeRecommendations(result).join(" ");
  ok("подсказка про истёкший код", /истёк|5 минут/.test(recs), recs.slice(0, 80));
  ok("вывод форматируется", formatResponse("тест", result.poll).join("\n").includes("HTTP 200"));
  server.close();
}

console.log("\n3) Проба: воспроизводится invalid_token_response");
{
  const { server, port } = await startMock({
    "/oauth/device/authorization": () => ({ status: 200, json: authorizeOk }),
    "/oauth/device/poll": () => ({ status: 200, json: { message: "still working", ok: true } }),
  });
  const result = await runKiroSocialProbe({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 4000 });
  ok("распознано как invalid_token_response", result.pollClassification === "invalid_token_response");
  const recs = probeRecommendations(result).join(" ");
  ok("совет обновиться", /обновиться/.test(recs));
  ok("совет про другой способ входа", /Builder ID/.test(recs));
  ok("совет приложить вывод в issue", /issue/.test(recs));
  server.close();
}

console.log("\n4) Проба: прокси отдаёт HTML вместо JSON");
{
  const { server, port } = await startMock({
    "/oauth/device/authorization": () => ({
      status: 200,
      contentType: "text/html",
      raw: "<html><body>Доступ запрещён корпоративным прокси</body></html>",
    }),
  });
  const result = await runKiroSocialProbe({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 4000 });
  ok("шаг 1 не выдал device-код", !result.shape.deviceCode);
  ok("вердикт authorize-failed", result.verdict === "authorize-failed", result.verdict);
  const printed = formatResponse("1) запрос device-кода", result.authorize).join("\n");
  ok("в выводе видно «ответ не JSON»", /не JSON/.test(printed), printed.split("\n")[1]?.slice(0, 60));
  const recs = probeRecommendations(result).join(" ");
  ok("подсказка про прокси и Builder ID", /прокси/.test(recs) && /Builder ID/.test(recs));
  server.close();
}

console.log("\n5) Проба: Kiro недоступен");
{
  const result = await runKiroSocialProbe({ baseUrl: "http://127.0.0.1:9", timeoutMs: 1500 });
  ok("вердикт authorization-unreachable", result.verdict === "authorization-unreachable", result.verdict);
  const recs = probeRecommendations(result).join(" ");
  ok("совет про сеть и Builder ID", /сеть|прокси/.test(recs) && /Builder ID/.test(recs));
}

console.log("\n6) Проба: отключённый опрос (--poll=false)");
{
  const { server, port } = await startMock({
    "/oauth/device/authorization": () => ({ status: 200, json: authorizeOk }),
  });
  const result = await runKiroSocialProbe({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 4000, poll: false });
  ok("опрос не выполнялся", result.poll === null && result.verdict === "authorize-ok");
  server.close();
}

console.log("\n7) kiro-check --test-call: ответ шлюза с исчерпанным бюджетом");
{
  const budgetBody = {
    error: {
      message: "Budget has been exceeded! Current cost: 100188946.03, Max budget: 100000000.0",
      type: "budget_exceeded",
      code: "429",
    },
  };
  const { server, port } = await startMock({
    "/v1/messages": () => ({
      status: 429,
      json: budgetBody,
    }),
  });

  // spawn (не spawnSync): макет живёт в этом же процессе, а синхронный запуск
  // заблокировал бы цикл событий и сервер не успел бы ответить.
  const { spawn } = await import("node:child_process");
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["tools/kiro-check.mjs", ...args], {
        cwd: new URL("..", import.meta.url).pathname,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ stdout, stderr, code }));
    });

  const jsonRun = await run(["--port", String(port), "--test-call", "--json", "--no-pause", "--timeout", "3000"]);
  let parsed = null;
  try {
    parsed = JSON.parse(jsonRun.stdout.slice(jsonRun.stdout.indexOf("{")));
  } catch (err) {
    /* ниже отметим как провал */
  }
  ok("--test-call достучался до шлюза", parsed?.testCall?.status === 429, String(parsed?.testCall?.status));
  ok("тело ошибки сохранено в отчёте", /Budget has been exceeded/.test(parsed?.testCall?.body || ""));
  ok("отчёт помечает чужой base URL как отсутствующий", Array.isArray(parsed?.summary?.foreignBaseUrl));

  const human = await run(["--port", String(port), "--test-call", "--no-pause", "--timeout", "3000"]);
  ok(
    "человекочитаемый вывод объясняет бюджет",
    /бюджет исчерпан/i.test(human.stdout),
    (human.stdout.match(/Вердикт.*/) || [""])[0].slice(0, 60)
  );

  server.close();
}

console.log("\n8) kiro-check --test-call: 400 Ambiguous model");
{
  const ambiguousBody = {
    error: {
      message:
        "Ambiguous model 'claude-sonnet-4-6'. Use provider/model prefix (ex: pu/claude-sonnet-4-6 or cc/claude-sonnet-4-6).",
      type: "invalid_request_error",
      code: "400",
    },
  };
  const { server, port } = await startMock({
    "/v1/messages": () => ({ status: 400, json: ambiguousBody }),
  });

  const { spawn } = await import("node:child_process");
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["tools/kiro-check.mjs", ...args], {
        cwd: new URL("..", import.meta.url).pathname,
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve({ stdout }));
    });

  const human = await run(["--port", String(port), "--test-call", "--no-pause", "--timeout", "3000"]);
  ok("объясняет, что модель без префикса", /без префикса/.test(human.stdout));
  ok("повторяет подсказку шлюза", /pu\/claude-sonnet-4-6 or cc\/claude-sonnet-4-6/.test(human.stdout));
  ok("даёт имя модели Kiro", /kr\/claude-sonnet-4\.5/.test(human.stdout));
  ok("даёт команду и settings.json", /freeclaude --model kr\/claude-sonnet-4\.5/.test(human.stdout) && /ANTHROPIC_MODEL/.test(human.stdout));

  server.close();
}

console.log("\n9) kiro-check: замечания к моделям в settings.json");
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-testtesttesttesttest",
        ANTHROPIC_MODEL: "kr/claude-sonnet-5",
        ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4.5",
      },
    })
  );

  const run = (args, env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["tools/kiro-check.mjs", ...args], {
        cwd: new URL("..", import.meta.url).pathname,
        env,
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve({ stdout }));
    });

  const out = (
    await run(["--no-pause", "--timeout", "2000"], { ...process.env, HOME: home, USERPROFILE: home })
  ).stdout;

  ok("предупреждает о модели без префикса", /SMALL_FAST_MODEL без префикса/.test(out));
  ok("подсказывает kr/ для haiku", /kr\/claude-haiku-4\.5/.test(out));
  ok("предупреждает о plan-gated sonnet-5", /не всем аккаунтам/.test(out));
  ok("маскирует токен", /sk-tes…\(\d+ симв\.\)/.test(out));

  rmSync(home, { recursive: true, force: true });
}

console.log("\n10) kiro-check --test-call: Kiro отклонил ключ (403 bearer invalid)");
{
  const rejected = {
    error: {
      message: "[403]: The bearer abc123 included in the request is invalid.",
      type: "invalid_request_error",
      code: "403",
    },
  };
  const { server, port } = await startMock({
    "/v1/messages": () => ({ status: 403, json: rejected }),
  });

  const { spawn } = await import("node:child_process");
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["tools/kiro-check.mjs", ...args], {
        cwd: new URL("..", import.meta.url).pathname,
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve({ stdout }));
    });

  const human = await run([
    "--port", String(port), "--test-call", "--provider", "kiro",
    "--model", "kr/claude-sonnet-5", "--no-pause", "--timeout", "3000",
  ]);
  ok("распознаёт 403 от Kiro", /Kiro отклонил вашу? клю?ч\/токен|Kiro отклонил/.test(human.stdout));
  ok("объясняет, что это AWS CodeWhisperer", /CodeWhisperer/.test(human.stdout));
  ok("советует модель 4.5", /kr\/claude-sonnet-4\.5/.test(human.stdout));
  ok("советует OAuth-пути", /Builder ID/.test(human.stdout) && /Import Token/.test(human.stdout));
  ok("показывает выбранную модель в заголовке", /модель kr\/claude-sonnet-5/.test(human.stdout));

  server.close();
}

console.log("\n11) kiro-check: ANTHROPIC_AUTH_TOKEN — пропуск в шлюз, а не токен Kiro");
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const withSettings = async (settings, extraEnv = {}) => {
    const home = mkdtempSync(join(tmpdir(), "kiro-auth-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
    const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (!("ANTHROPIC_API_KEY" in extraEnv)) delete env.ANTHROPIC_API_KEY;
    const stdout = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["tools/kiro-check.mjs", "--no-pause", "--timeout", "2000"], {
        cwd: new URL("..", import.meta.url).pathname,
        env,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve(out));
    });
    rmSync(home, { recursive: true, force: true });
    return stdout;
  };

  const kiroToken = await withSettings({
    env: { ANTHROPIC_AUTH_TOKEN: "aoaAAAABBBCCCDDDEEEFFFGGGHHHIIIJJJ" },
  });
  ok("видит токен Kiro", /это токен Kiro\/AWS, а не ключ шлюза/.test(kiroToken));
  ok("объясняет случай OAuth", /Учётная запись OAuth/.test(kiroToken));
  ok("советует ключ OmniRoute или пусто", /Оставьте там ключ OmniRoute/.test(kiroToken));
  ok("добавляет пункт в диагноз", /там лежит токен Kiro/.test(kiroToken));

  const gatewayKey = await withSettings({
    env: { ANTHROPIC_AUTH_TOKEN: "sk-abcdefghijklmnopqrstuvwx" },
  });
  ok("узнаёт ключ OmniRoute", /ключ OmniRoute, всё верно/.test(gatewayKey));
  ok("не помечает ключ шлюза как проблему", !/\[!\] ANTHROPIC_AUTH_TOKEN/.test(gatewayKey));

  const apiKey = await withSettings(
    { env: { ANTHROPIC_MODEL: "kr/claude-sonnet-4.5" } },
    { ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop" }
  );
  ok("предупреждает про ANTHROPIC_API_KEY", /лишний: Claude Code отправит его как x-api-key/.test(apiKey));

  const nothing = await withSettings({ env: { ANTHROPIC_MODEL: "kr/claude-sonnet-4.5" } });
  ok("поясняет, что заполнять не обязательно", /не задан — freeclaude подставит служебное значение/.test(nothing));
}

console.log("\n12) kiro-check --check-kiro-key: что скажет AWS про ключ");
{
  const { spawn } = await import("node:child_process");

  const runKeyCheck = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["tools/kiro-check.mjs", "--no-pause", "--timeout", "3000", ...args], {
        cwd: new URL("..", import.meta.url).pathname,
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve(stdout));
    });

  const KEY = "ksk_testtesttesttesttesttesttest";
  const listTarget = "AmazonCodeWhispererService.ListAvailableProfiles";
  const probeTarget = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

  // Макет AWS: отвечает на ListAvailableProfiles и generateAssistantResponse по заголовку x-amz-target.
  const startAws = (answers) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const target = String(req.headers["x-amz-target"] || "");
        calls.push(target);
        const answer = answers[target] || (() => ({ status: 404, json: { message: "not_found" } }));
        const out = answer({ body: body ? JSON.parse(body) : {}, headers: req.headers });
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(out.raw ?? JSON.stringify(out.json ?? {}));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, calls }));
    });
  };

  // 1. Ключ принят по листингу профилей.
  {
    const { server, port } = await startAws({
      [listTarget]: () => ({ status: 200, json: { profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:111:profile/test" }] } }),
    });
    const out = await runKeyCheck(["--check-kiro-key", KEY, "--region", "us-east-1", "--aws-base", `http://127.0.0.1:${port}`]);
    ok("принятый ключ: вердикт «принят»", /Ключ принят/.test(out));
    ok("принятый ключ: подсказан регион для дашборда", /Регион AWS» = us-east-1/.test(out));
    ok("принятый ключ: видно профиль", /arn:aws:codewhisperer:us-east-1/.test(out));
    ok("ключ не печатается целиком", !out.includes(KEY));
    server.close();
  }

  // 2. Случай пользователя: "API key authentication is not supported" + пробный запрос 403.
  {
    const { server, port, calls } = await startAws({
      [listTarget]: () => ({
        status: 403,
        json: { message: "AccessDeniedException: API key authentication is not supported for this operation" },
      }),
      [probeTarget]: () => ({ status: 403, json: { message: "The bearer token included in the request is invalid." } }),
    });
    const out = await runKeyCheck(["--check-kiro-key", KEY, "--aws-base", `http://127.0.0.1:${port}`]);
    ok("случай «Invalid Kiro API key or AWS region» распознан", /Kiro не принимает этот ключ/.test(out));
    ok("объяснено, что в дашборде будет то же сообщение", /Invalid Kiro API key or AWS region/.test(out));
    ok("советует OAuth-способы", /Builder ID/.test(out) && /Import Token/.test(out));
    ok("проверяет оба региона по умолчанию", /eu-central-1/.test(out) && /us-east-1/.test(out));
    ok("пробный запрос отправлен в оба региона", calls.filter((c) => c === probeTarget).length === 2);
    server.close();
  }

  // 3. Ключ отклонён везде (листинг 403).
  {
    const { server, port } = await startAws({
      [listTarget]: () => ({ status: 403, json: { message: "The bearer token included in the request is invalid." } }),
    });
    const out = await runKeyCheck(["--check-kiro-key", KEY, "--aws-base", `http://127.0.0.1:${port}`]);
    ok("отклонённый ключ: вердикт про отзыв/копирование", /отклонён в обоих регионах/.test(out));
    ok("отклонённый ключ: совет пересоздать", /начинается с ksk_/.test(out));
    server.close();
  }

  // 4. Сеть не пускает.
  {
    const out = await runKeyCheck(["--check-kiro-key", KEY, "--region", "us-east-1", "--aws-base", "http://127.0.0.1:1"]);
    ok("сетевая ошибка распознана", /Сеть не пускает/.test(out));
  }

  // 5. Формат ключа.
  {
    const { server, port } = await startAws({
      [listTarget]: () => ({ status: 200, json: { profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:111:profile/test" }] } }),
    });
    const out = await runKeyCheck(["--check-kiro-key", "aorAAAAAG_test_refresh_token", "--region", "us-east-1", "--aws-base", `http://127.0.0.1:${port}`]);
    ok("предупреждает про формат ksk_", /не начинается с ksk_/.test(out));
    server.close();
  }
}

console.log(`\nПроверок: ${total}, провалено: ${failed}`);
process.exit(failed ? 1 : 0);
