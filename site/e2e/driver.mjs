// Minimal Chrome DevTools Protocol driver for the Metta end-to-end flows.
// No dependencies: Node 22 (global WebSocket) + a local Chrome/Edge.
//
// Every page lives in its own browser context (separate cookies), so one
// Chrome process can hold the admin, the manager, the designer and two clients
// at the same time. Interactions go through real input events: clicks and taps
// are dispatched at the element's centre after checking nothing covers it,
// text is typed with Input.insertText and files are given to the real file
// chooser (Page.fileChooserOpened → DOM.setFileInputFiles).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Chrome não encontrado. Defina CHROME_PATH.");
  return found;
}

// Injected into every document: element lookup by accessible name, the way a
// person reads the screen (visible, not behind a modal, top layer first).
export const HELPERS = String.raw`(() => {
  if (window.__e2e) return;
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const ROLES = {
    button: 'button, [role=button], input[type=button], input[type=submit], summary',
    link: 'a[href], [role=link]',
    tab: '[role=tab]',
    menuitem: '[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]',
    option: '[role=option], [role=radio], input[type=radio]',
    checkbox: 'input[type=checkbox], [role=checkbox], [role=switch]',
    textbox: 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true], [role=textbox], [role=combobox]',
    row: '[role=row], tr',
    dialog: 'dialog[open], [role=dialog]',
    heading: 'h1, h2, h3, h4, h5, h6, [role=heading]',
  };
  ROLES.clickable = [ROLES.button, ROLES.link, ROLES.tab, ROLES.menuitem, ROLES.option, ROLES.checkbox, 'label', '[tabindex]:not([tabindex="-1"])'].join(', ');
  ROLES.any = ROLES.clickable;
  const isShown = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    const box = (el.matches('input[type=checkbox], input[type=radio]') && (el.closest('label') || el.parentElement)) || el;
    const rect = box.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    for (let node = box; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden') return false;
    }
    return true;
  };
  const modals = () => Array.from(document.querySelectorAll('dialog')).filter((d) => { try { return d.matches(':modal'); } catch { return false; } });
  const popovers = () => Array.from(document.querySelectorAll('[popover]')).filter((p) => { try { return p.matches(':popover-open'); } catch { return false; } });
  // What a person can interact with right now: the topmost modal (plus open
  // popovers), otherwise the whole document.
  const scopes = (within) => {
    if (within) {
      const roots = typeof within === 'string' ? Array.from(document.querySelectorAll(within)).filter(isShown) : [within];
      return roots;
    }
    const m = modals();
    if (m.length) return [m[m.length - 1], ...popovers().filter((p) => !m[m.length - 1].contains(p))];
    return [document.body];
  };
  const textOf = (el) => norm(el.innerText ?? el.textContent);
  // Text a screen reader would announce: skips aria-hidden parts (the "*" of
  // required fields, decorative icons) and anything not rendered.
  const nameText = (el) => {
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.textContent; continue; }
        if (child.nodeType !== 1) continue;
        if (child.getAttribute('aria-hidden') === 'true' || child.matches('svg, input, select, textarea, script, style, template')) continue;
        const cs = getComputedStyle(child);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const block = cs.display !== 'inline' && cs.display !== 'contents';
        if (block) out += ' ';
        walk(child);
        if (block) out += ' ';
      }
    };
    walk(el);
    return norm(out);
  };
  const accName = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return norm(label);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = norm(by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? nameText(n) : ''; }).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length && el.matches('input, textarea, select')) return norm(Array.from(el.labels).map((l) => nameText(l)).join(' '));
    if (el.matches('input[type=button], input[type=submit]')) return norm(el.value);
    if (el.matches('input, textarea, select')) return norm(el.getAttribute('placeholder') || el.getAttribute('title') || '');
    const text = nameText(el);
    if (text) return text;
    const img = el.querySelector('img[alt], svg[aria-label]');
    if (img) return norm(img.getAttribute('alt') || img.getAttribute('aria-label'));
    return norm(el.getAttribute('title') || '');
  };
  const score = (name, query, exact) => {
    if (query instanceof RegExp) return query.test(name) ? 4 : 0;
    const q = norm(query);
    if (name === q) return 5;
    const a = name.toLowerCase(), b = q.toLowerCase();
    if (a === b) return 4;
    if (exact) return 0;
    if (a.startsWith(b)) return 3;
    if (a.includes(b)) return 2;
    return 0;
  };
  const parseQuery = (q) => (q && typeof q === 'object' && q.re) ? new RegExp(q.re, q.flags || '') : q;
  const all = (role, within) => {
    const sel = ROLES[role] || role;
    const out = [];
    for (const root of scopes(within)) {
      if (root.matches?.(sel)) out.push(root);
      out.push(...root.querySelectorAll(sel));
    }
    return out.filter(isShown);
  };
  const find = (query, opts = {}) => {
    const q = parseQuery(query);
    const role = opts.role || 'any';
    let best = [];
    let top = 0;
    for (const el of all(role, opts.within ? resolveWithin(opts.within) : null)) {
      const s = score(accName(el), q, opts.exact);
      if (!s) continue;
      if (s > top) { top = s; best = [el]; } else if (s === top) best.push(el);
    }
    // A label wrapping a control is the same target: keep the innermost match.
    best = best.filter((el) => !best.some((other) => other !== el && el.contains(other)));
    return best[opts.nth || 0] || null;
  };
  const resolveWithin = (within) => {
    if (typeof within !== 'object') return within;
    // {text, role}: the smallest container (dialog, section, row, card…) holding that text.
    const q = parseQuery(within.text);
    const sel = within.selector || 'dialog, [role=dialog], section, article, li, tr, [role=row], form, fieldset, aside, .ui-card, .ui-panel';
    const hits = Array.from(document.querySelectorAll(sel)).filter((el) => isShown(el) && score(textOf(el), q, false) && (q instanceof RegExp ? q.test(textOf(el)) : textOf(el).toLowerCase().includes(norm(q).toLowerCase())));
    hits.sort((a, b) => textOf(a).length - textOf(b).length);
    return hits[0] || '__none__';
  };
  const describe = (el) => {
    if (!el) return null;
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls + ' "' + accName(el).slice(0, 60) + '"';
  };
  // Scrolls the target into view and returns its centre, or why it can't be clicked.
  const point = (el) => {
    const target = (el.matches('input[type=checkbox], input[type=radio]') && (el.closest('label') || el.parentElement)) || el;
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = target.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(r.width / 2, Math.max(4, r.width - 4)));
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    const ok = hit && (target === hit || target.contains(hit) || hit.contains(target) && hit.closest('label') === target || el.contains(hit) || (hit.closest && hit.closest('label') && hit.closest('label').contains(el)));
    return { x, y, ok: Boolean(ok), covered: ok ? null : describe(hit), name: accName(el), tag: el.tagName.toLowerCase(), disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), w: r.width, h: r.height };
  };
  const scopeText = (within) => scopes(within ? resolveWithin(within) : null).map((root) => root.innerText || '').join('\n');
  window.__e2e = { norm, find, all, accName, isShown, point, describe, scopeText, modals, popovers, resolveWithin, parseQuery };
})();`;

class Browser {
  constructor(proc, profile, ws) {
    this.proc = proc;
    this.profile = profile;
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> Page
    this.pagesByTarget = new Map();
    ws.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data)));
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (msg.sessionId) this.sessions.get(msg.sessionId)?.onEvent(msg);
    else if (msg.method.startsWith("Browser.download")) {
      for (const page of this.sessions.values()) page.onDownloadEvent(msg);
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /**
   * New isolated page. opts: { name, base, mobile, reduced, downloadsDir, shotsDir, onShot }
   */
  async newPage(opts = {}) {
    const { browserContextId } = await this.send("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, { sessionId, targetId, browserContextId, ...opts });
    this.sessions.set(sessionId, page);
    await page.init();
    return page;
  }

  async close() {
    try {
      await this.send("Browser.close");
    } catch {}
    try {
      this.ws.close();
    } catch {}
    await new Promise((resolve) => {
      if (this.proc.exitCode !== null) return resolve();
      this.proc.once("exit", resolve);
      setTimeout(() => {
        try {
          this.proc.kill();
        } catch {}
        resolve();
      }, 3000);
    });
    // Windows keeps the profile locked for a moment after Chrome exits.
    for (let i = 0; i < 10; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
}

// extraArgs: more Chrome switches; disableFeatures: merged into the single
// --disable-features switch (Chrome keeps only the last one).
export async function launch({ headless = true, extraArgs = [], disableFeatures = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "metta-e2e-"));
  const args = [
    headless ? "--headless=new" : null,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--password-store=basic",
    `--disable-features=${["Translate", "MediaRouter", "OptimizationHints", ...disableFeatures].join(",")}`,
    ...extraArgs,
    "about:blank",
  ].filter(Boolean);
  const proc = spawn(findChrome(), args, { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  let endpoint = null;
  for (let i = 0; i < 120 && !endpoint; i++) {
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").split(/\r?\n/);
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    }
    if (!endpoint) await sleep(100);
  }
  if (!endpoint) throw new Error("Chrome não abriu a porta de depuração.");
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return new Browser(proc, profile, ws);
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

export class Page {
  constructor(browser, opts) {
    this.browser = browser;
    this.opts = opts;
    this.name = opts.name || "page";
    this.base = opts.base || "http://127.0.0.1:5173";
    this.mobile = Boolean(opts.mobile);
    this.sessionId = opts.sessionId;
    this.targetId = opts.targetId;
    this.contextId = opts.browserContextId;
    this.listeners = new Set();
    this.inflight = new Map();
    this.lastNetwork = Date.now();
    this.consoleErrors = [];
    this.badResponses = [];
    this.allowedStatus = []; // [{status, pattern}] expected 4xx/5xx for the current step
    this.downloads = new Map();
    this.fileChooser = null;
  }

  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  async init() {
    const { width, height } = this.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    this.viewport = { width, height };
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    await this.send("Log.enable");
    await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: this.mobile ? 2 : 1,
      mobile: this.mobile,
    });
    if (this.mobile) {
      await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await this.send("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA, platform: "Android" });
    }
    if (this.opts.reduced)
      await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    if (this.opts.downloadsDir) {
      mkdirSync(this.opts.downloadsDir, { recursive: true });
      await this.browser.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        browserContextId: this.contextId,
        downloadPath: this.opts.downloadsDir,
        eventsEnabled: true,
      });
    }
  }

  onEvent(msg) {
    const { method, params } = msg;
    switch (method) {
      case "Runtime.exceptionThrown":
        this.consoleErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text);
        break;
      case "Runtime.consoleAPICalled":
        if (params.type === "error")
          this.consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? "").join(" "));
        break;
      case "Log.entryAdded":
        if (params.entry.level === "error" && !/Failed to load resource/.test(params.entry.text))
          this.consoleErrors.push(`${params.entry.text} ${params.entry.url || ""}`.trim());
        break;
      case "Network.requestWillBeSent":
        if (["Fetch", "XHR", "Document", "Script", "Stylesheet"].includes(params.type)) {
          this.inflight.set(params.requestId, params.request.url);
          this.lastNetwork = Date.now();
        }
        break;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        if (this.inflight.delete(params.requestId)) this.lastNetwork = Date.now();
        if (method === "Network.loadingFailed" && !params.canceled && params.type !== "Other" && !/ERR_ABORTED/.test(params.errorText))
          this.badResponses.push({ status: 0, url: params.errorText, method: "" });
        break;
      case "Network.responseReceived": {
        const { status, url } = params.response;
        if (status >= 400 && /\/(api|dl)\//.test(url)) {
          const path = url.replace(/^https?:\/\/[^/]+/, "");
          const allowed = this.allowedStatus.find((a) => a.status === status && (!a.pattern || a.pattern.test(path)));
          if (allowed) allowed.seen = (allowed.seen || 0) + 1;
          else this.badResponses.push({ status, url: path });
        }
        break;
      }
      case "Page.fileChooserOpened":
        this.fileChooser?.(params);
        break;
      case "Page.javascriptDialogOpening":
        // Never leave the page hanging on a native dialog; report it unless expected.
        if (!this.expectDialog) this.consoleErrors.push(`diálogo nativo inesperado (${params.type}): ${params.message}`);
        this.lastDialog = params;
        this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        break;
      default:
        break;
    }
    for (const fn of this.listeners) fn(msg);
  }

  onDownloadEvent({ method, params }) {
    if (method === "Browser.downloadWillBegin") {
      if (params.frameId !== this.targetId && !this.expectingDownload) return;
      this.downloads.set(params.guid, { ...params, state: "inProgress" });
    } else if (method === "Browser.downloadProgress") {
      const d = this.downloads.get(params.guid);
      if (d) Object.assign(d, { state: params.state, receivedBytes: params.receivedBytes, totalBytes: params.totalBytes });
    }
  }

  // Expected HTTP errors during `fn` (e.g. 415 for a refused upload).
  async allowing(statuses, fn) {
    const entries = statuses.map((s) => (typeof s === "number" ? { status: s } : s));
    this.allowedStatus.push(...entries);
    try {
      return await fn();
    } finally {
      this.allowedStatus = this.allowedStatus.filter((a) => !entries.includes(a));
    }
  }

  takeProblems() {
    const out = { consoleErrors: [...new Set(this.consoleErrors)], badResponses: this.badResponses };
    this.consoleErrors = [];
    this.badResponses = [];
    return out;
  }

  // ---------- evaluation ----------
  async eval(fnOrExpr, ...args) {
    const expression =
      typeof fnOrExpr === "function"
        ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
        : fnOrExpr;
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    if (res.exceptionDetails)
      throw new Error(`eval: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    return res.result?.value;
  }

  async ensureHelpers() {
    const ok = await this.eval("Boolean(window.__e2e)");
    if (!ok) await this.eval(HELPERS);
  }

  url() {
    return this.eval("location.pathname + location.search");
  }

  async waitFor(fn, { timeout = 15000, interval = 120, message } = {}, ...args) {
    const until = Date.now() + timeout;
    let last;
    while (Date.now() < until) {
      try {
        await this.ensureHelpers();
        last = await this.eval(fn, ...args);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`${message || "condição não atendida"} (após ${timeout} ms)${last && typeof last === "string" ? `: ${last}` : ""}`);
  }

  async waitIdle({ quiet = 450, timeout = 20000 } = {}) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetwork >= quiet) {
        const busy = await this.eval(
          "document.readyState !== 'complete' || Boolean(document.querySelector('.ui-skeleton:not(.ui-thumb .ui-skeleton), [aria-busy=true]:not(.ui-thumb)'))",
        ).catch(() => false);
        if (!busy) return;
      }
      await sleep(100);
    }
  }

  async goto(path, { idle = true } = {}) {
    const url = /^https?:/.test(path) ? path : this.base + path;
    const loaded = new Promise((resolve) => {
      const fn = (m) => {
        if (m.method === "Page.loadEventFired") {
          this.listeners.delete(fn);
          resolve();
        }
      };
      this.listeners.add(fn);
      setTimeout(resolve, 20000);
    });
    const nav = await this.send("Page.navigate", { url });
    if (nav.errorText) throw new Error(`falha ao abrir ${url}: ${nav.errorText}`);
    await loaded;
    await this.ensureHelpers();
    const want = new URL(url).pathname;
    const at = await this.eval("location.pathname");
    if (at !== want)
      throw new Error(`a navegação para ${want} parou em ${at}`);
    if (idle) await this.waitIdle();
  }

  async reload() {
    await this.goto(await this.eval("location.href"));
  }

  // ---------- reading ----------
  text(within) {
    return this.eval((w) => window.__e2e.scopeText(w), within ?? null);
  }

  async waitText(query, { timeout = 15000, within, gone = false } = {}) {
    const q = query instanceof RegExp ? { re: query.source, flags: query.flags } : query;
    return this.waitFor(
      (q, w, gone) => {
        const text = window.__e2e.norm(window.__e2e.scopeText(w));
        const query = window.__e2e.parseQuery(q);
        const has = query instanceof RegExp ? query.test(text) : text.toLowerCase().includes(window.__e2e.norm(query).toLowerCase());
        return gone ? !has : has;
      },
      { timeout, message: `${gone ? "texto ainda visível" : "texto não apareceu"}: ${query}` },
      q,
      within ?? null,
      gone,
    );
  }

  async has(query, opts = {}) {
    await this.ensureHelpers();
    const q = query instanceof RegExp ? { re: query.source, flags: query.flags } : query;
    return this.eval((q, o) => Boolean(window.__e2e.find(q, o)), q, opts);
  }

  // ---------- acting ----------
  async locate(query, opts = {}) {
    const q = query instanceof RegExp ? { re: query.source, flags: query.flags } : query;
    const { timeout = 10000, ...findOpts } = opts;
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      await this.ensureHelpers();
      last = await this.eval(
        (q, o) => {
          const el = window.__e2e.find(q, o);
          if (!el) return { missing: true };
          return window.__e2e.point(el);
        },
        q,
        findOpts,
      );
      if (!last.missing && last.ok && !last.disabled) {
        // Only act on a settled target (entrance animations, smooth scrolling).
        await sleep(90);
        const again = await this.eval(
          (q, o) => {
            const el = window.__e2e.find(q, o);
            return el ? window.__e2e.point(el) : { missing: true };
          },
          q,
          findOpts,
        );
        if (!again.missing && again.ok && !again.disabled && Math.abs(again.x - last.x) <= 1 && Math.abs(again.y - last.y) <= 1)
          return again;
        last = again;
      }
      await sleep(150);
    }
    const what = `${findOpts.role || "elemento"} "${query}"`;
    if (!last || last.missing) throw new Error(`${what} não encontrado na tela`);
    if (last.disabled) throw new Error(`${what} está desativado`);
    throw new Error(`${what} está coberto por ${last.covered}`);
  }

  async tapAt(x, y) {
    if (this.mobile) {
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await sleep(40);
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sleep(30);
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
  }

  // Click (desktop) or tap (mobile) an element by its accessible name.
  async click(query, opts = {}) {
    const { idle = true, ...rest } = opts;
    const p = await this.locate(query, { role: "clickable", ...rest });
    await this.tapAt(p.x, p.y);
    await sleep(60);
    if (idle) await this.waitIdle();
    return p;
  }

  async press(key, { modifiers = 0 } = {}) {
    const k = KEYS[key] || { code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.toUpperCase().charCodeAt(0), text: key.length === 1 ? key : undefined };
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers });
    await sleep(50);
  }

  // Focus a labelled field, clear it and type the value.
  async fill(label, value, opts = {}) {
    const p = await this.locate(label, { role: "textbox", ...opts });
    await this.tapAt(p.x, p.y);
    const q = label instanceof RegExp ? { re: label.source, flags: label.flags } : label;
    const kind = await this.eval(
      (q, o) => {
        const el = window.__e2e.find(q, o);
        el.focus();
        if (el.tagName === "SELECT") return "select";
        if (["date", "time", "datetime-local", "month", "color"].includes(el.type)) return "native";
        if (typeof el.select === "function") el.select();
        else if (el.isContentEditable) document.execCommand("selectAll");
        return "text";
      },
      q,
      { role: "textbox", ...opts },
    );
    if (kind === "select") throw new Error(`"${label}" é uma lista; use select()`);
    if (kind === "native") {
      await this.eval(
        (q, o, v) => {
          const el = window.__e2e.find(q, o);
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        },
        q,
        { role: "textbox", ...opts },
        String(value),
      );
    } else {
      await this.press("Delete");
      if (String(value)) await this.send("Input.insertText", { text: String(value) });
    }
    await sleep(60);
  }

  // Choose an option of a native <select> by its visible text.
  async select(label, optionText, opts = {}) {
    const p = await this.locate(label, { role: "textbox", ...opts });
    await this.tapAt(p.x, p.y);
    await sleep(80);
    await this.press("Escape"); // close the native picker, as a person would after choosing
    const q = label instanceof RegExp ? { re: label.source, flags: label.flags } : label;
    const o = optionText instanceof RegExp ? { re: optionText.source, flags: optionText.flags } : optionText;
    const until = Date.now() + (opts.timeout ?? 10000);
    let result;
    while (Date.now() < until) {
      result = await this.eval(
        (q, fo, o) => {
          const el = window.__e2e.find(q, fo);
          if (!el || el.tagName !== "SELECT") return { error: "lista não encontrada" };
          const want = window.__e2e.parseQuery(o);
          const options = Array.from(el.options);
          const match =
            options.find((opt) => (want instanceof RegExp ? want.test(opt.text) : window.__e2e.norm(opt.text) === window.__e2e.norm(want))) ||
            (!(want instanceof RegExp) && options.find((opt) => window.__e2e.norm(opt.text).toLowerCase().includes(window.__e2e.norm(want).toLowerCase())));
          if (!match) return { error: "opção não encontrada", options: options.map((opt) => opt.text) };
          if (match.disabled) return { error: "opção desativada" };
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(el, match.value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: match.value, text: match.text };
        },
        q,
        { role: "textbox", ...opts },
        o,
      );
      if (!result.error) break;
      await sleep(200);
    }
    if (result.error) throw new Error(`${label} → ${optionText}: ${result.error}${result.options ? ` (${result.options.join(" | ")})` : ""}`);
    await this.waitIdle();
    return result;
  }

  // Tick or untick a checkbox/switch by its label.
  async check(label, on = true, opts = {}) {
    const q = label instanceof RegExp ? { re: label.source, flags: label.flags } : label;
    await this.locate(label, { role: "checkbox", ...opts });
    const state = () =>
      this.eval((q, o) => {
        const el = window.__e2e.find(q, o);
        return el ? (el.checked ?? el.getAttribute("aria-checked") === "true") : null;
      }, q, { role: "checkbox", ...opts });
    if ((await state()) === on) return;
    // Like a person: tick, look, and tick again if the list moved under the
    // pointer (re-layout after a filter). The second try is reported.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.click(label, { role: "checkbox", ...opts });
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        if ((await state()) === on) {
          if (attempt > 1) console.log(`    aviso: "${label}" só mudou no segundo toque`);
          return;
        }
        await sleep(100);
      }
    }
    throw new Error(`a caixa "${label}" não ficou ${on ? "marcada" : "desmarcada"}`);
  }

  // Click a button that opens the file chooser and answer it with local files.
  async chooseFiles(buttonQuery, files, opts = {}) {
    const chosen = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`o seletor de arquivos não abriu ao tocar em "${buttonQuery}"`)), 8000);
      this.fileChooser = (params) => {
        clearTimeout(timer);
        this.fileChooser = null;
        resolve(params);
      };
    });
    await this.click(buttonQuery, { role: "button", idle: false, ...opts });
    const params = await chosen;
    await this.send("DOM.setFileInputFiles", { files, backendNodeId: params.backendNodeId });
    await sleep(200);
  }

  // Runs `action` and waits for the download it starts. Returns {path, suggestedFilename, url, size}.
  async download(action, { timeout = 60000 } = {}) {
    if (!this.opts.downloadsDir) throw new Error("página sem pasta de downloads");
    const before = new Set(this.downloads.keys());
    this.expectingDownload = true;
    try {
      await action();
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const fresh = [...this.downloads.values()].find((d) => !before.has(d.guid));
        if (fresh?.state === "completed") {
          const path = join(this.opts.downloadsDir, fresh.guid);
          return { path, suggestedFilename: fresh.suggestedFilename, url: fresh.url, size: fresh.receivedBytes };
        }
        if (fresh?.state === "canceled") throw new Error(`download cancelado: ${fresh.suggestedFilename}`);
        await sleep(150);
      }
      throw new Error("nenhum download concluído");
    } finally {
      this.expectingDownload = false;
    }
  }

  async setCookie(name, value) {
    await this.send("Network.setCookie", { name, value, url: this.base, httpOnly: true, sameSite: "Lax", path: "/" });
  }

  async clearCookies() {
    await this.send("Network.clearBrowserCookies");
  }

  async shot(file, { full = false } = {}) {
    const metrics = (height) =>
      this.send("Emulation.setDeviceMetricsOverride", {
        width: this.viewport.width,
        height,
        deviceScaleFactor: this.mobile ? 2 : 1,
        mobile: this.mobile,
      });
    if (full) {
      // Grow the viewport to the page height so fixed/sticky parts render once, in place.
      const h = await this.eval("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)");
      await metrics(Math.min(Math.max(h, this.viewport.height), 6000));
      await sleep(350);
    }
    try {
      const { data } = await this.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(data, "base64"));
    } finally {
      if (full) await metrics(this.viewport.height);
    }
    return file;
  }

  async scrollTop() {
    await this.eval("window.scrollTo(0, 0)");
  }
}
