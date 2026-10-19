// supaforge-bridge — shared helpers: HTTP with timeouts + JSON convenience.

const DEFAULT_TIMEOUT_MS = 30000;

export async function request(method, url, opts = {}) {
  const { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    return res;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export async function jsonRequest(method, url, opts = {}) {
  const res = await request(method, url, {
    ...opts,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(opts.headers || {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const detail = typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500);
    throw new Error(`${method} ${url} -> ${res.status}: ${detail}`);
  }
  return data;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString();
}
