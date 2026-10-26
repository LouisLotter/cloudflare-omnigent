// The platform pages' static assets (WP3.5), bundled into the web Worker as text modules
// (`rules` in wrangler.web.jsonc): xterm.js 6.0.0 and its fit add-on, pinned exactly in
// package.json, the setup page's own script and the pages' styles. Served from this origin only,
// so the Content Security Policy needs no other source. Never from a computer.

import fitJs from "@xterm/addon-fit/lib/addon-fit.js";
import xtermCss from "@xterm/xterm/css/xterm.css";
import xtermJs from "@xterm/xterm/lib/xterm.js";
import setupClientJs from "./client/setup-client.js";
import { PAGES_CSS } from "./html.ts";
import type { Asset } from "./router.ts";

const JS = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";

export const ASSETS: Readonly<Record<string, Asset>> = {
  "xterm.js": { body: xtermJs, type: JS },
  "xterm.css": { body: xtermCss, type: CSS },
  "addon-fit.js": { body: fitJs, type: JS },
  "setup-client.js": { body: setupClientJs, type: JS },
  "pages.css": { body: PAGES_CSS, type: CSS },
};
