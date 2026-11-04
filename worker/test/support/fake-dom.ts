/**
 * A small synthetic DOM for running the setup page's script in Node (WP3.53, Codex r1): enough of
 * elements, `innerHTML`, `dataset`, selectors and click events for the script's paths, parsing
 * the real server-rendered markup. Not a browser: no layout, no styles, no scripts in markup.
 * `<noscript>` content is raw text, as in a browser with scripting on.
 *
 * Selectors: comma lists of descendant chains of compounds made of a tag, `#id`, `.class`,
 * `[name]` and `[name="value"]`.
 */

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const RAW = new Set(["script", "style", "noscript", "textarea", "title"]);
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X"))
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const escapeText = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (t: string) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export class FakeText {
  readonly nodeType = 3;
  parent: FakeParent | null = null;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

type FakeNode = FakeElement | FakeText;
type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  readonly type: string;
  readonly target: FakeElement;
  readonly key?: string;
  preventDefault(): void;
}

/** A node that holds children: an element, or a template's content. */
export class FakeParent {
  children: FakeNode[] = [];
  parent: FakeParent | null = null;

  get firstElementChild(): FakeElement | null {
    return (this.children.find((c) => c instanceof FakeElement) as FakeElement | undefined) ?? null;
  }

  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(text: string) {
    this.#setChildren([new FakeText(String(text))]);
  }

  get innerHTML(): string {
    return this.children.map(serialize).join("");
  }

  set innerHTML(html: string) {
    this.#setChildren(parse(String(html)));
  }

  #setChildren(nodes: FakeNode[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node: FakeNode): void {
    detach(node);
    node.parent = this;
    this.children.push(node);
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  /** Every element below, in document order. */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (p: FakeParent) => {
      for (const c of p.children) {
        if (c instanceof FakeElement) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((e) => e.matches(selector, this));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function detach(node: FakeNode): void {
  const parent = node.parent;
  if (parent === null) return;
  parent.children = parent.children.filter((c) => c !== node);
  node.parent = null;
}

export class FakeElement extends FakeParent {
  readonly nodeType = 1;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  /** An input's value. */
  value = "";
  /** A `<template>`'s content. */
  readonly content: FakeParent | null;
  readonly dataset: Record<string, string | undefined>;

  readonly localName: string;

  constructor(localName: string) {
    super();
    this.localName = localName;
    this.content = localName === "template" ? new FakeParent() : null;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, key) =>
        typeof key === "string" ? (this.getAttribute(dataName(key)) ?? undefined) : undefined,
      set: (_t, key, value) => {
        if (typeof key === "string") this.setAttribute(dataName(key), String(value));
        return true;
      },
      deleteProperty: (_t, key) => {
        if (typeof key === "string") this.removeAttribute(dataName(key));
        return true;
      },
    });
  }

  get tagName(): string {
    return this.localName.toUpperCase();
  }

  override get innerHTML(): string {
    return this.content !== null ? this.content.innerHTML : super.innerHTML;
  }

  override set innerHTML(html: string) {
    if (this.content !== null) this.content.innerHTML = html;
    else super.innerHTML = html;
  }

  set outerHTML(html: string) {
    const parent = this.parent;
    if (parent === null) return;
    const nodes = parse(String(html));
    const at = parent.children.indexOf(this);
    detach(this);
    for (const node of nodes) node.parent = parent;
    parent.children.splice(at, 0, ...nodes);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase());
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(value: string) {
    this.setAttribute("class", value);
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
  set disabled(on: boolean) {
    if (on) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }
  set hidden(on: boolean) {
    if (on) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }

  get isConnected(): boolean {
    let node: FakeParent | null = this.parent;
    while (node !== null) {
      if (node instanceof FakeDocumentRoot) return true;
      node = node.parent;
    }
    return false;
  }

  replaceWith(node: FakeNode): void {
    const parent = this.parent;
    if (parent === null) return;
    detach(node);
    const at = parent.children.indexOf(this);
    detach(this);
    node.parent = parent;
    parent.children.splice(at, 0, node);
  }

  remove(): void {
    detach(this);
  }

  matches(selector: string, scope?: FakeParent): boolean {
    return selector
      .split(",")
      .map((s) => s.trim())
      .some((chain) => matchesChain(this, chain.split(/\s+/), scope));
  }

  closest(selector: string): FakeElement | null {
    let node: FakeParent | null = this;
    while (node instanceof FakeElement) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  focus(): void {}
  scrollIntoView(): void {}
}

/** The document's root, so `isConnected` can tell an attached element from a detached one. */
class FakeDocumentRoot extends FakeParent {}

function dataName(key: string): string {
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function matchesCompound(e: FakeElement, compound: string): boolean {
  const parts = compound.match(/^[a-z][a-z0-9-]*|#[\w-]+|\.[\w-]+|\[[^\]]+\]/gi) ?? [];
  if (parts.join("") !== compound) throw new Error(`fake-dom: unsupported selector ${compound}`);
  return parts.every((part) => {
    if (part.startsWith("#")) return e.id === part.slice(1);
    if (part.startsWith(".")) return e.className.split(/\s+/).includes(part.slice(1));
    if (part.startsWith("[")) {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (m === null) throw new Error(`fake-dom: unsupported selector ${part}`);
      const value = e.getAttribute(m[1] ?? "");
      return m[2] === undefined ? value !== null : value === m[2];
    }
    return e.localName === part.toLowerCase();
  });
}

function matchesChain(e: FakeElement, chain: string[], scope?: FakeParent): boolean {
  const last = chain[chain.length - 1];
  if (last === undefined || !matchesCompound(e, last)) return false;
  let rest = chain.slice(0, -1);
  let node: FakeParent | null = e.parent;
  while (rest.length > 0 && node instanceof FakeElement) {
    const want = rest[rest.length - 1] ?? "";
    if (matchesCompound(node, want)) rest = rest.slice(0, -1);
    node = node.parent;
  }
  void scope;
  return rest.length === 0;
}

function serialize(node: FakeNode): string {
  if (node instanceof FakeText) return escapeText(node.data);
  const attrs = [...node.attrs]
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`))
    .join("");
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  const inner = RAW.has(node.localName)
    ? node.children.map((c) => (c instanceof FakeText ? c.data : serialize(c))).join("")
    : node.innerHTML;
  return `<${node.localName}${attrs}>${inner}</${node.localName}>`;
}

/** Parses well-formed markup, as the server renders it. */
export function parse(html: string): FakeNode[] {
  const top = new FakeParent();
  const stack: FakeParent[] = [top];
  let i = 0;
  const current = () => stack[stack.length - 1] ?? top;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const name = html
        .slice(i + 2, end)
        .trim()
        .toLowerCase();
      for (let s = stack.length - 1; s > 0; s -= 1) {
        const el = stack[s];
        if (el instanceof FakeElement && el.localName === name) {
          stack.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    const open = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i));
    if (open !== null) {
      const el = new FakeElement((open[1] ?? "").toLowerCase());
      i += open[0].length;
      const attr = /^\s*([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/;
      for (;;) {
        const rest = html.slice(i);
        const close = /^\s*(\/?)>/.exec(rest);
        if (close !== null) {
          i += close[0].length;
          break;
        }
        const a = attr.exec(rest);
        if (a === null) throw new Error(`fake-dom: bad markup at ${html.slice(i, i + 40)}`);
        el.setAttribute(a[1] ?? "", decode(a[2] ?? a[3] ?? a[4] ?? ""));
        i += a[0].length;
      }
      current().appendChild(el);
      if (VOID.has(el.localName)) continue;
      if (RAW.has(el.localName)) {
        const end = html.toLowerCase().indexOf(`</${el.localName}`, i);
        const raw = html.slice(i, end === -1 ? html.length : end);
        if (raw !== "") el.appendChild(new FakeText(raw));
        i = end === -1 ? html.length : html.indexOf(">", end) + 1;
        continue;
      }
      stack.push(el);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const text = html.slice(i, next === -1 ? html.length : next);
    current().appendChild(new FakeText(decode(text)));
    i = next === -1 ? html.length : next;
  }
  const nodes = [...top.children];
  for (const node of nodes) node.parent = null;
  return nodes;
}

/** A document whose body is `html`. */
export class FakeDocument {
  readonly body = new FakeDocumentRoot();
  visibilityState = "visible";

  constructor(html: string) {
    this.body.innerHTML = html;
  }

  getElementById(id: string): FakeElement | null {
    return this.body.descendants().find((e) => e.id === id) ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }
  createElement(name: string): FakeElement {
    return new FakeElement(name.toLowerCase());
  }

  /** A click on `target`, bubbling to every ancestor's listeners, as a browser's does. */
  click(target: FakeElement): void {
    const event: FakeEvent = { type: "click", target, preventDefault: () => undefined };
    let node: FakeParent | null = target;
    while (node instanceof FakeElement) {
      for (const listener of node.listeners.get("click") ?? []) listener(event);
      node = node.parent;
    }
  }
}
