// The platform pages' HTTP rules (WP3.5; design, Platform pages; P1; RC-07's G3 part):
// - every answer under `/platform/` carries framing protection (`frame-ancestors 'none'` and
//   `X-Frame-Options: DENY`), a strict Content Security Policy, `nosniff` and `no-store`;
// - a GET or HEAD never changes state; a control URL opened with GET renders a confirmation page;
// - a change is a POST whose `Origin` is exactly this installation's origin (missing, `null`,
//   foreign and same-site sibling origins refused), with `Sec-Fetch-Site: same-origin` when the
//   browser sends it, a bounded body and the page's request-intent token, which WorkspaceDO's
//   page front compares in constant time before any effect;
// - the terminal's WebSocket upgrade needs the same exact origin, and its capability.
// Ingress (WP2.1) has already admitted the pinned owner and refused a foreign Origin; these checks
// are the pages' own and stricter, so a later change at the entrance cannot loosen them.

/** The most a page form or the terminal's JSON may carry. */
export const MAX_FORM_BYTES = 4096;

export interface PageHeadersOptions {
  /** The setup page runs xterm.js, which writes `<style>` elements: inline styles allowed. */
  readonly inlineStyles?: boolean;
  /** The WebSocket origin the page may connect to (`wss://host`, or `ws://` on loopback). */
  readonly socketOrigin?: string;
}

/** The Content Security Policy of every platform answer. */
export function contentSecurityPolicy(options: PageHeadersOptions): string {
  const connect = options.socketOrigin ? `'self' ${options.socketOrigin}` : "'self'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self'${options.inlineStyles ? " 'unsafe-inline'" : ""}`,
    "img-src 'self'",
    "font-src 'self'",
    `connect-src ${connect}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** Headers every platform answer carries, pages, assets, refusals and 404s alike. */
export function securityHeaders(options: PageHeadersOptions = {}): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(options),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "no-store",
  };
}

export function htmlResponse(html: string, status = 200, options?: PageHeadersOptions): Response {
  return new Response(html, {
    status,
    headers: { ...securityHeaders(options), "content-type": "text/html; charset=utf-8" },
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(), "content-type": "application/json; charset=utf-8" },
  });
}

/** A 303 to a path on this origin (after a POST, so a reload never repeats it). */
export function seeOther(path: string): Response {
  if (!path.startsWith("/platform/")) throw new Error("redirects stay on the platform pages");
  return new Response(null, { status: 303, headers: { ...securityHeaders(), location: path } });
}

/** Why a state-changing request was refused; logged, never shown in detail. */
export type ChangeRefusal =
  | "method"
  | "missing_origin"
  | "null_origin"
  | "foreign_origin"
  | "cross_site_fetch"
  | "content_type"
  | "too_large"
  | "malformed";

/** The origin check of a change or an upgrade: exact, and same-origin fetch metadata. */
export function originRefusal(request: Request, origin: string): ChangeRefusal | null {
  const sent = request.headers.get("origin");
  if (sent === null) return "missing_origin";
  if (sent === "null") return "null_origin";
  if (sent !== origin) return "foreign_origin";
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return "cross_site_fetch";
  return null;
}

/** Reads a body of at most `MAX_FORM_BYTES`, or null if it is larger. */
async function boundedText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FORM_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ChangeRefusal };

/** The checks of a page POST, in order, then its form fields. */
export async function readChange(
  request: Request,
  origin: string,
  kind: "form" | "json",
): Promise<Parsed<Record<string, string>>> {
  if (request.method !== "POST") return { ok: false, refusal: "method" };
  const bad = originRefusal(request, origin);
  if (bad !== null) return { ok: false, refusal: bad };
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const wanted = kind === "form" ? "application/x-www-form-urlencoded" : "application/json";
  if (type !== wanted) return { ok: false, refusal: "content_type" };
  const text = await boundedText(request);
  if (text === null) return { ok: false, refusal: "too_large" };
  if (kind === "form") {
    const fields: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(text)) {
      if (name in fields) return { ok: false, refusal: "malformed" };
      fields[name] = value;
    }
    return { ok: true, value: fields };
  }
  try {
    const json = JSON.parse(text) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      return { ok: false, refusal: "malformed" };
    }
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(json)) {
      if (typeof value === "string") fields[name] = value;
      else if (typeof value === "number" && Number.isSafeInteger(value))
        fields[name] = String(value);
      else if (value !== null) return { ok: false, refusal: "malformed" };
    }
    return { ok: true, value: fields };
  } catch {
    return { ok: false, refusal: "malformed" };
  }
}

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** A fresh operation ID for a form: a double submit of the same form is the same operation. */
export function newOperationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let id = "op_";
  for (const b of bytes) id += BASE32[b % 32];
  return id;
}

/** HTML-escapes text: every name a page shows is untrusted and rendered as text only. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The WebSocket origin for a page origin: `wss://` for `https://`, `ws://` for loopback HTTP. */
export function socketOriginOf(origin: string): string {
  return origin.startsWith("https://") ? `wss://${origin.slice(8)}` : `ws://${origin.slice(7)}`;
}
