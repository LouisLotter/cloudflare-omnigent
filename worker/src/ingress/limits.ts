// Coarse rate limits at the entrance, checked before the assertion's signature, so that nothing
// past ingress sees more than a bounded request rate from one client. They do not bound an open
// stream; the stream limits do (the design's "Availability").
//
// One token bucket per client address, kept in the isolate. Isolates are per location and are
// recycled, so this is a coarse brake against a runaway client, not a global quota; Access in
// front of the hostname is what stops strangers. IPv6 clients are grouped by their /64, which one
// subscriber usually holds whole.

export interface LimitOptions {
  /** Requests a client may make at once. */
  readonly burst: number;
  /** Requests per second a client regains. */
  readonly perSecond: number;
  /** Clients tracked at once; the least recently seen is forgotten first. */
  readonly maxClients: number;
}

/**
 * About ten requests a second, with room for a page load's burst. Only the owner passes Access,
 * so this is sized to never slow the owner's own use of Omnigent's interface.
 */
export const LIMIT_DEFAULTS: LimitOptions = { burst: 600, perSecond: 10, maxClients: 4096 };

export type LimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly options: LimitOptions;
  private readonly clockMs: () => number;

  constructor(clockMs: () => number, options: LimitOptions = LIMIT_DEFAULTS) {
    if (!(options.burst >= 1 && options.perSecond > 0 && options.maxClients >= 1)) {
      throw new Error("rate limit options out of range");
    }
    this.clockMs = clockMs;
    this.options = options;
  }

  /** Takes one request from `client`'s bucket. */
  take(client: string): LimitDecision {
    const now = this.clockMs();
    const { burst, perSecond, maxClients } = this.options;
    const found = this.buckets.get(client);
    const bucket: Bucket = found ?? { tokens: burst, updatedMs: now };
    const elapsed = Math.max(0, now - bucket.updatedMs) / 1000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * perSecond);
    bucket.updatedMs = now;
    // Most recently seen last, so the first entry is the one to forget.
    this.buckets.delete(client);
    this.buckets.set(client, bucket);
    while (this.buckets.size > maxClients) {
      const oldest = this.buckets.keys().next().value as string;
      this.buckets.delete(oldest);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / perSecond)),
    };
  }

  /** Clients currently tracked, for tests. */
  get size(): number {
    return this.buckets.size;
  }
}

/** The first 64 bits of an IPv6 address as `a:b:c:d::/64`, or undefined if it is not one. */
export function ipv6Prefix64(address: string): string | undefined {
  const text = address.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(text) || !text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string): string[] | undefined => {
    if (part === "") return [];
    const raw = part.split(":");
    const out: string[] = [];
    for (const [i, group] of raw.entries()) {
      if (i === raw.length - 1 && group.includes(".")) {
        const octets = group.split(".");
        if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) < 256)) {
          return undefined;
        }
        const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(group)) {
        out.push(group);
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = groupsOf(halves[0] as string);
  const tail = halves.length === 2 ? groupsOf(halves[1] as string) : [];
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/** The rate-limit key for a request: its client address from Cloudflare, an IPv6 one by /64. */
export function clientKey(headers: Headers): string {
  const address = headers.get("cf-connecting-ip")?.trim();
  if (!address) return "unknown";
  return ipv6Prefix64(address) ?? address.slice(0, 64);
}
