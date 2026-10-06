import type { Job, SessionPayload } from "./types";

let csrfToken = "";

export function setCsrf(token?: string | null) {
  csrfToken = token || "";
}

type ApiOptions = Omit<RequestInit, "body"> & { json?: unknown; body?: BodyInit | null };

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  if ((options.method || "GET").toUpperCase() !== "GET" && csrfToken)
    headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error?: unknown }).error)
      : `خطای ${response.status}`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export async function readSession() {
  const session = await api<SessionPayload>("/api/session");
  setCsrf(session.csrf);
  return session;
}

export async function waitForJob(id: string, onProgress?: (job: Job) => void) {
  for (;;) {
    const job = await api<Job>(`/api/jobs/${encodeURIComponent(id)}`);
    onProgress?.(job);
    if (job.state !== "running") {
      if (job.state === "failed") throw new Error(job.error || "اجرای کار ناموفق بود.");
      return job;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1100));
  }
}
