export interface GoogleTileHttpFailure {
  status: number;
  statusText: string;
  contentType: string | null;
  body: string | null;
}

export interface GoogleTileResourceTiming {
  responseStatus: number;
  durationMs: number;
}

const SECRET_PARAMS = new Set(["key", "session", "token", "api_key"]);

export function redactTileUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of [...parsed.searchParams.keys()]) {
      if (SECRET_PARAMS.has(name.toLowerCase())) parsed.searchParams.set(name, "redacted");
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function causeLines(error: unknown, depth = 0): string[] {
  if (depth > 4 || error == null || typeof error !== "object" || !("cause" in error) || error.cause == null) return [];
  const cause = error.cause;
  const name = cause instanceof Error ? cause.name : "cause";
  const message = cause instanceof Error ? cause.message : String(cause);
  return [`cause: ${name}: ${message}`, ...causeLines(cause, depth + 1)];
}

/** Everything the failed request still exposes. A CORS block has no HTTP status. */
export function describeGoogleTileFailure(input: {
  error: unknown;
  url: string;
  http?: GoogleTileHttpFailure | null;
  resource?: GoogleTileResourceTiming | null;
  online?: boolean;
  origin?: string;
}): string {
  const error = input.error;
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const lines = [
    `${name}: ${message}`,
    `url: ${redactTileUrl(input.url)}`,
    ...causeLines(error),
  ];
  if (input.http) {
    lines.push(`http: ${input.http.status} ${input.http.statusText}`.trim());
    if (input.http.contentType) lines.push(`content-type: ${input.http.contentType}`);
    if (input.http.body) lines.push(`body: ${input.http.body}`);
  }
  if (input.resource) {
    const status = input.resource.responseStatus;
    lines.push(status > 0
      ? `resource timing status: ${status}`
      : "resource timing status: hidden (0). The browser often does this when the response has no CORS headers, which is how a rejected key or a disabled Map Tiles API shows up.");
    lines.push(`resource timing duration: ${Math.round(input.resource.durationMs)} ms`);
  }
  if (input.online === false) lines.push("navigator.onLine: false");
  if (input.origin) lines.push(`page origin: ${input.origin}`);
  return lines.join("\n");
}

export async function readGoogleTileHttpFailure(response: Response): Promise<GoogleTileHttpFailure> {
  let body: string | null = null;
  try {
    const text = (await response.text()).replace(/\s+/g, " ").trim();
    body = text.length > 500 ? `${text.slice(0, 499)}…` : text || null;
  } catch {
    body = null;
  }
  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    body,
  };
}

export function latestResourceTiming(url: string): GoogleTileResourceTiming | null {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep the raw string and match on it.
  }
  const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  const match = [...entries].reverse().find((entry) => entry.name.includes(path));
  if (!match) return null;
  const status = "responseStatus" in match ? Number(match.responseStatus) : 0;
  return { responseStatus: Number.isFinite(status) ? status : 0, durationMs: match.duration };
}
