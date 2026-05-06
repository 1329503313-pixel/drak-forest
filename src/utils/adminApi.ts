const STORAGE_KEY = "darkforest_admin_token";

export function loadAdminToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveAdminToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearAdminToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export async function fetchAdminStatus(): Promise<{ ok: boolean; hint?: string; auth?: string }> {
  const res = await fetch("/api/admin/status");
  return res.json() as Promise<{ ok: boolean; hint?: string; auth?: string }>;
}

export async function loginAdmin(username: string, password: string): Promise<{ token: string; username: string }> {
  const res = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || "登录失败");
  }
  return res.json() as Promise<{ token: string; username: string }>;
}

export async function logoutAdmin(): Promise<void> {
  const token = loadAdminToken();
  if (!token) return;
  await fetch("/api/admin/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => undefined);
}

export async function adminFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = loadAdminToken();
  const headers = new Headers();
  if (init?.headers != null) {
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`/api/admin${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body ?? null,
    signal: init?.signal,
    credentials: init?.credentials ?? "same-origin",
    cache: init?.cache,
    redirect: init?.redirect,
    referrer: init?.referrer,
    referrerPolicy: init?.referrerPolicy,
    integrity: init?.integrity,
    keepalive: init?.keepalive,
    mode: init?.mode,
  });

  if (res.status === 401) {
    const err = new Error("UNAUTHORIZED") as Error & { code?: string };
    err.code = "UNAUTHORIZED";
    throw err;
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}
