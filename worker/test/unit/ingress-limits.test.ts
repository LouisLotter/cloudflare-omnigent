import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clientKey, ipv6Prefix64, LIMIT_DEFAULTS, RateLimiter } from "../../src/ingress/limits.ts";

describe("RateLimiter", () => {
  it("allows a burst, then refuses with Retry-After, then refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, { burst: 3, perSecond: 1, maxClients: 10 });
    for (let i = 0; i < 3; i++) expect(limiter.take("a")).toEqual({ allowed: true });
    expect(limiter.take("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.take("b")).toEqual({ allowed: true }); // per client
    now = 1000;
    expect(limiter.take("a")).toEqual({ allowed: true });
    expect(limiter.take("a").allowed).toBe(false);
    now = 100_000; // refills only up to the burst
    for (let i = 0; i < 3; i++) expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
  });

  it("rounds Retry-After up to whole seconds, at least one", () => {
    const limiter = new RateLimiter(() => 0, { burst: 1, perSecond: 0.25, maxClients: 10 });
    limiter.take("a");
    expect(limiter.take("a")).toEqual({ allowed: false, retryAfterSeconds: 4 });
  });

  it("ignores a clock that goes backwards", () => {
    let now = 10_000;
    const limiter = new RateLimiter(() => now, { burst: 1, perSecond: 1, maxClients: 10 });
    expect(limiter.take("a").allowed).toBe(true);
    now = 0;
    expect(limiter.take("a").allowed).toBe(false);
  });

  it("tracks a bounded number of clients, forgetting the least recently seen", () => {
    const limiter = new RateLimiter(() => 0, { burst: 1, perSecond: 0.001, maxClients: 2 });
    limiter.take("a");
    limiter.take("b");
    limiter.take("a"); // a is now the most recent
    limiter.take("c"); // forgets b
    expect(limiter.size).toBe(2);
    expect(limiter.take("a").allowed).toBe(false);
    expect(limiter.take("b").allowed).toBe(true); // a fresh bucket
  });

  it("refuses nonsensical options", () => {
    for (const options of [
      { ...LIMIT_DEFAULTS, burst: 0 },
      { ...LIMIT_DEFAULTS, perSecond: 0 },
      { ...LIMIT_DEFAULTS, maxClients: 0 },
      { ...LIMIT_DEFAULTS, burst: Number.NaN },
    ]) {
      expect(() => new RateLimiter(() => 0, options)).toThrow("out of range");
    }
  });

  it("property: over any schedule, a client gets at most burst + elapsed × rate requests", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(2000), { minLength: 1, maxLength: 300 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 10 }),
        (steps, burst, perSecond) => {
          let now = 0;
          const limiter = new RateLimiter(() => now, { burst, perSecond, maxClients: 4 });
          let allowed = 0;
          for (const step of steps) {
            now += step;
            if (limiter.take("x").allowed) allowed++;
          }
          expect(allowed).toBeLessThanOrEqual(burst + Math.floor((now / 1000) * perSecond));
        },
      ),
    );
  });

  it("default limits let a page load's burst through", () => {
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 300; i++) expect(limiter.take("owner").allowed).toBe(true);
  });
});

describe("ipv6Prefix64", () => {
  it.each([
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002::1", "2001:db8:1:2::/64"],
    ["2001:DB8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::", "0:0:0:0::/64"],
    ["1::2:3:4:5:6:7", "1:0:2:3::/64"],
    ["1:2:3:4:5:6::", "1:2:3:4::/64"],
    ["::ffff:192.0.2.1", "0:0:0:0::/64"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
  ])("%s -> %s", (address, prefix) => {
    expect(ipv6Prefix64(address)).toBe(prefix);
  });

  it.each([
    "192.0.2.1",
    "",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "1:2:3:4:5:6:7::8",
    "12345::",
    "g::1",
    "::1.2.3",
    "::256.0.0.1",
    "1:2:3:4:5:6:7:1.2.3.4",
    "fe80::1%eth0",
  ])("refuses %s", (address) => {
    expect(ipv6Prefix64(address)).toBeUndefined();
  });

  it("property: addresses that differ only in their last 64 bits share a key", () => {
    const group = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
    fc.assert(
      fc.property(
        fc.array(group, { minLength: 4, maxLength: 4 }),
        fc.array(group, { minLength: 4, maxLength: 4 }),
        fc.array(group, { minLength: 4, maxLength: 4 }),
        (prefix, a, b) => {
          const key = ipv6Prefix64([...prefix, ...a].join(":"));
          expect(key).toBe(ipv6Prefix64([...prefix, ...b].join(":")));
          expect(key).toBe(
            `${prefix.map((g) => Number.parseInt(g, 16).toString(16)).join(":")}::/64`,
          );
        },
      ),
    );
  });
});

describe("clientKey", () => {
  it("keys by Cloudflare's client address, IPv6 by /64", () => {
    expect(clientKey(new Headers({ "cf-connecting-ip": "192.0.2.7" }))).toBe("192.0.2.7");
    expect(clientKey(new Headers({ "cf-connecting-ip": " 2001:db8::7 " }))).toBe(
      "2001:db8:0:0::/64",
    );
    expect(clientKey(new Headers())).toBe("unknown");
    expect(clientKey(new Headers({ "cf-connecting-ip": "" }))).toBe("unknown");
    expect(clientKey(new Headers({ "cf-connecting-ip": "x".repeat(100) }))).toHaveLength(64);
    // The client's own forwarding headers count for nothing.
    expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.1" }))).toBe("unknown");
  });
});
