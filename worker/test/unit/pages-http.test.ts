// The pages' HTTP rules (WP3.5, `pages/http.ts`) where the routes do not reach them.
import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  escapeHtml,
  newOperationId,
  readChange,
  seeOther,
  socketOriginOf,
} from "../../src/pages/http.ts";

const ORIGIN = "https://omnigent.example.test";

describe("readChange", () => {
  it("refuses anything but a POST", async () => {
    expect(
      await readChange(new Request(ORIGIN, { headers: { origin: ORIGIN } }), ORIGIN, "form"),
    ).toEqual({
      ok: false,
      refusal: "method",
    });
  });

  it("reads an empty form, and ignores a content length that is not a number", async () => {
    const empty = new Request(ORIGIN, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "x",
      },
    });
    expect(await readChange(empty, ORIGIN, "form")).toEqual({ ok: true, value: {} });
  });

  it("reads JSON strings, safe integers and nulls, and refuses anything nested", async () => {
    const post = (body: string) =>
      new Request(ORIGIN, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json; charset=utf-8" },
        body,
      });
    expect(await readChange(post('{"a":"x","b":7,"c":null}'), ORIGIN, "json")).toEqual({
      ok: true,
      value: { a: "x", b: "7" },
    });
    expect(await readChange(post('{"a":1.5}'), ORIGIN, "json")).toMatchObject({
      ok: false,
      refusal: "malformed",
    });
    expect(await readChange(post("null"), ORIGIN, "json")).toMatchObject({
      ok: false,
      refusal: "malformed",
    });
    expect(await readChange(post("[]"), ORIGIN, "json")).toMatchObject({
      ok: false,
      refusal: "malformed",
    });
  });

  it("refuses a request without a content type", async () => {
    const bare = new Request(ORIGIN, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: new Uint8Array([1]),
    });
    expect(await readChange(bare, ORIGIN, "form")).toMatchObject({
      ok: false,
      refusal: "content_type",
    });
  });
});

describe("helpers", () => {
  it("redirect only within the platform pages", () => {
    expect(seeOther("/platform/computers").headers.get("location")).toBe("/platform/computers");
    expect(() => seeOther("https://evil.example/")).toThrow("redirects stay on the platform pages");
  });

  it("escape every character that could open markup or an attribute", () => {
    expect(escapeHtml(`<a href='x' title="y">&</a>`)).toBe(
      "&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("name the WebSocket origin for HTTPS and for local HTTP", () => {
    expect(socketOriginOf(ORIGIN)).toBe("wss://omnigent.example.test");
    expect(socketOriginOf("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787");
  });

  it("mint operation IDs in the contract's form", () => {
    expect(newOperationId()).toMatch(/^op_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(newOperationId()).not.toBe(newOperationId());
  });

  it("deny framing in every policy", () => {
    expect(contentSecurityPolicy({})).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy({ inlineStyles: true, socketOrigin: "wss://h" })).toContain(
      "connect-src 'self' wss://h",
    );
  });
});
