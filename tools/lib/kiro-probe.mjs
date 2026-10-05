/**
 * Проба social-входа Kiro — воспроизводит ровно те два запроса, которые делает
 * OmniRoute в потоке Google/GitHub, и показывает сырые ответы.
 *
 * Нужна для разбора ошибки `invalid_token_response`: она возникает, когда опрос
 * Kiro вернул HTTP 2xx, но без токенов и без пометки «ещё ждём» — то есть сервер
 * OmniRoute не понял ответ. Проба позволяет увидеть, что именно приходит.
 *
 * Контракт взят из OmniRoute 3.8.51:
 *   POST {base}/oauth/device/authorization  {clientId, loginProvider}
 *   POST {base}/oauth/device/poll           {deviceCode, clientId}
 *   classifyKiroSocialPoll(): pending | error | success | invalid_token_response
 */

export const KIRO_SOCIAL_BASE = "https://prod.us-east-1.auth.desktop.kiro.dev";
export const KIRO_SOCIAL_CLIENT_ID = "kiro-cli";

const PENDING_MARKERS = new Set(["authorization_pending", "slow_down"]);

/**
 * Копия classifyKiroSocialPoll() из OmniRoute (src/lib/oauth/kiroSocialPoll.ts).
 * @returns {"pending"|"error"|"success"|"invalid_token_response"}
 */
export function classifyKiroPoll(responseOk, responseStatus, data) {
  const progress = data?.error ?? data?.status;
  if (PENDING_MARKERS.has(progress)) return "pending";
  if (!responseOk || data?.error) return "error";
  if (!data?.accessToken && !data?.refreshToken) return "invalid_token_response";
  return "success";
}

function snippet(text, limit = 400) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}… (обрезано, всего ${clean.length} символов)`;
}

async function postJson(url, body, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "kiro-check/1.0 (OmniRoute diagnostics)" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      contentType: res.headers.get("content-type") || "",
      text,
      data,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      contentType: "",
      text: "",
      data: null,
      error: String(err?.cause?.code || err?.cause?.message || err?.code || err?.message || "error"),
    };
  }
}

/**
 * Выполнить пробу: запросить device-код и сразу опросить его один раз.
 *
 * @param {{baseUrl?:string, loginProvider?:"Google"|"Github", timeoutMs?:number, poll?:boolean}} options
 */
export async function runKiroSocialProbe(options = {}) {
  const baseUrl = String(options.baseUrl || KIRO_SOCIAL_BASE).replace(/\/$/, "");
  const loginProvider = options.loginProvider === "Github" ? "Github" : "Google";
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const doPoll = options.poll !== false;

  const authorize = await postJson(
    `${baseUrl}/oauth/device/authorization`,
    { clientId: KIRO_SOCIAL_CLIENT_ID, loginProvider },
    timeoutMs
  );

  const shape = {
    deviceCode: Boolean(authorize.data?.deviceCode),
    userCode: Boolean(authorize.data?.userCode),
    verificationUriComplete: Boolean(authorize.data?.verificationUriComplete),
    expiresInMilliseconds: Number(authorize.data?.expiresInMilliseconds || 0) || null,
    intervalInMilliseconds: Number(authorize.data?.intervalInMilliseconds || 0) || null,
  };

  const result = {
    baseUrl,
    loginProvider,
    authorize,
    shape,
    poll: null,
    pollClassification: null,
    verdict: "",
  };

  if (!authorize.ok || !shape.deviceCode) {
    result.verdict =
      authorize.status === 0
        ? "authorization-unreachable"
        : "authorize-failed";
    return result;
  }

  if (!doPoll) {
    result.verdict = "authorize-ok";
    return result;
  }

  const poll = await postJson(
    `${baseUrl}/oauth/device/poll`,
    { deviceCode: authorize.data.deviceCode, clientId: KIRO_SOCIAL_CLIENT_ID },
    timeoutMs
  );
  result.poll = poll;
  result.pollClassification =
    poll.status === 0 ? "unreachable" : classifyKiroPoll(poll.ok, poll.status, poll.data);
  result.verdict = `poll-${result.pollClassification}`;
  return result;
}

/** Отформатировать одно поле ответа для печати. */
export function formatResponse(label, response) {
  if (!response) return [];
  const lines = [];
  if (response.status === 0) {
    lines.push(`  ${label}: соединения нет (${response.error}), ${response.ms} мс`);
    return lines;
  }
  lines.push(`  ${label}: HTTP ${response.status}, ${response.ms} мс, ${response.contentType || "без content-type"}`);
  if (response.data === null) {
    lines.push(`    ответ не JSON: ${snippet(response.text) || "(пусто)"}`);
  } else {
    lines.push(`    JSON: ${snippet(JSON.stringify(response.data))}`);
  }
  return lines;
}

/** Что рекомендовать по итогам пробы. */
export function probeRecommendations(result) {
  const out = [];
  switch (result.verdict) {
    case "authorization-unreachable":
      out.push("Запрос к Kiro вообще не ушёл: сеть/прокси/файрвол блокируют домен.");
      out.push("Проверьте прокси (переменные окружения и системный) и повторите в другой сети.");
      out.push("Вход через Builder ID использует другие домены (amazonaws.com, awsapps.com) — попробуйте его.");
      break;
    case "authorize-failed":
      out.push("Kiro отказал в выдаче device-кода: смотрите текст ответа выше.");
      out.push("Частые причины: изменённый формат запроса на стороне Kiro, блокирующий прокси, временный сбой сервиса.");
      out.push("Пока не восстановится — используйте Builder ID, Auto-Import, Import Token или API Key.");
      break;
    case "poll-pending":
      out.push("Опрос отвечает корректно («ещё ждём») — значит сама связь с Kiro в порядке.");
      out.push("Тогда ошибка invalid_token_response возникала из-за конкретного кода: он истёк (~5 минут) или уже был использован.");
      out.push("Начните подключение заново и успейте подтвердить вход в браузере; код со страницы вводите сразу.");
      break;
    case "poll-invalid_token_response":
      out.push("Ошибка воспроизвелась: Kiro отвечает 2xx, но без токенов и без пометки «ждём» — именно это OmniRoute показывает как invalid_token_response.");
      out.push("Посмотрите на JSON выше: если пометка выглядит иначе (другое поле или другое значение) — версия OmniRoute не понимает новый формат.");
      out.push("Что делать: обновиться (npm install -g omniroute@latest) и повторить; если не помогло — подключить Kiro другим способом (Builder ID, Auto-Import, Import Token, API Key).");
      out.push("Полезно приложить вывод (kiro-check --probe-kiro) в issue проекта: форма ответа Kiro могла измениться.");
      break;
    case "poll-error":
      out.push("Kiro вернул ошибку на опрос — смотрите текст ответа выше, он объясняет причину.");
      if (/expired/i.test(result.poll?.text || "")) {
        out.push("Похоже, код истёк: начинайте подключение заново и подтверждайте вход сразу.");
      }
      break;
    case "poll-success":
      out.push("Ответ содержит токены — вход технически прошёл. Если в дашборде подключения нет, повторите попытку там или добавьте токен через Import Token.");
      break;
    case "poll-unreachable":
      out.push("Опрос не дошёл до Kiro: соединение оборвалось. Проверьте прокси/антивирус/VPN, затем повторите.");
      break;
    default:
      out.push("Проба завершена без вывода — смотрите детали выше.");
  }
  return out;
}
