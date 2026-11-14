// elisp-studio: write a web application in the browser and watch it change.
//
//   left    GNU Emacs (wasmacs), editing the project's files in its own
//           filesystem, /home/user/elisp-studio/app
//   right   the application: another Emacs (the wasmacs eval service) runs
//           the project's Emacs Lisp with elisp-react and draws the page
//
// This script is the wire between them.  The editor reports its files
// whenever one changes; a changed .el file is evaluated in the running
// application, whose components keep their state; a changed stylesheet is
// swapped; a changed index.html starts the application again.
import { projectFiles } from "./tar.js";
import { createZip } from "./zip.js";

const here = new URL("../", import.meta.url);                 // .../elisp-studio/
// The sibling sites, on the same origin (GitHub Pages: modeverv.github.io/...).
const WASMACS = new URL("../wasmacs/", here);
const ELISP_REACT = new URL("../elisp-react/", here);
const PROJECT = "/home/user/elisp-studio/app";
// What a new project starts with: template/, or with ?example=NAME one of
// examples/.  server.el is optional.  (A project that exists is left alone.)
const example = new URLSearchParams(location.search).get("example");
const TEMPLATE = /^[a-z0-9-]+$/.test(example || "") ? `examples/${example}/` : "template/";
const TEMPLATE_FILES = ["index.html", "app.el", "style.css"];
const TEMPLATE_OPTIONAL_FILES = ["server.el"];
const SERVER_FILE = "server.el";
const SERVER_DATA_KEY = "server-data";
const TAB_UPLOAD_LIMIT = 32 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60000;
const DEFERRED_TIMEOUT_MS = 30000;   // as app-server-deferred-timeout
const SERVER_TIMEOUT_MS = 8000;
const LOAD_TIMEOUT_MS = 8000;
// Starting the application: the first time Emacs may have to be downloaded
// (150 MB); after that it comes from the browser's cache.
const FIRST_START_TIMEOUT_MS = 300000;
const START_TIMEOUT_MS = 20000;
let startedOnce = false;

const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const previewSlot = document.querySelector("#preview-slot");
const editorFrame = document.querySelector("#editor");
document.querySelector("#project").textContent = PROJECT;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}
function showError(text) {
  errorEl.textContent = text || "";
  errorEl.classList.toggle("shown", Boolean(text));
}
const clock = () => new Date().toLocaleTimeString();
const lispString = (text) => `"${String(text).replace(/[\\"]/g, "\\$&")}"`;
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms)),
]);

// ---- the editor -----------------------------------------------------------------

// Where this page gets its isolation headers from a service worker, the
// editor's page needs its own (another scope) before it can be embedded:
// a document without the headers is refused inside an isolated page.
async function ensureEditorServiceWorker() {
  if (!navigator.serviceWorker?.controller) return;   // the server sends the headers itself
  const registration = await navigator.serviceWorker.register(new URL("coi-serviceworker.js", WASMACS));
  if (registration.active) return;
  const worker = registration.installing || registration.waiting;
  await new Promise((resolve) => {
    worker.addEventListener("statechange", () => { if (worker.state === "activated") resolve(); });
  });
}

// What Emacs evaluates when it starts (--eval forms): it creates the
// project from the template the first time, visits app.el and loads the
// editor's side of the studio, lisp/elisp-studio.el.  The editor's page
// asks for the forms ("wasmacs:options-request"): whole files do not fit
// into a URL.
async function editorForms() {
  const text = async (path) => {
    const response = await fetch(new URL(path, here), { cache: "no-store" });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.text();
  };
  const template = await Promise.all(TEMPLATE_FILES.map(async (name) => [name, await text(`${TEMPLATE}${name}`)]));
  for (const name of TEMPLATE_OPTIONAL_FILES) {
    const response = await fetch(new URL(`${TEMPLATE}${name}`, here), { cache: "no-store" });
    if (response.ok) template.push([name, await response.text()]);
  }
  return [
    `(progn
      (setq make-backup-files nil auto-save-default nil)
      (unless (file-exists-p ${lispString(`${PROJECT}/app.el`)})
        (make-directory ${lispString(PROJECT)} t)
        ${template.map(([name, content]) => `(write-region ${lispString(content)} nil ${lispString(`${PROJECT}/${name}`)} nil 'silent)`).join("\n        ")}))`,
    `(find-file ${lispString(`${PROJECT}/app.el`)})`,
    // The libraries the project is written with, so that this Emacs can
    // complete, describe and find their functions.  They are files: M-.
    // needs a place to go to.
    `(progn
      (make-directory "/tmp/elisp-studio/" t)
      (write-region ${lispString(await (await fetch(new URL("lisp/react.el", ELISP_REACT), { cache: "no-store" })).text())} nil "/tmp/elisp-studio/react.el" nil 'silent)
      (write-region ${lispString(await text("lisp/app-server.el"))} nil "/tmp/elisp-studio/app-server.el" nil 'silent)
      (load "/tmp/elisp-studio/react.el" nil t)
      (load "/tmp/elisp-studio/app-server.el" nil t))`,
    `(progn
      (write-region ${lispString(await text("lisp/elisp-studio.el"))} nil "/tmp/elisp-studio/elisp-studio.el" nil 'silent)
      (load "/tmp/elisp-studio/elisp-studio.el" nil t))`,
  ];
}

function editorUrl() {
  const url = new URL("app/xterm-atomics-pdump.html", WASMACS);
  url.searchParams.set("embed", "1");
  url.searchParams.set("options", "parent");
  return url.href;
}

// Tell Emacs something: JSON, typed into its terminal between two escape
// sequences (lisp/elisp-studio.el reads it like a bracketed paste).
function tellEditor(message) {
  const json = new TextEncoder().encode(JSON.stringify(message));
  let binary = "";
  for (const byte of json) binary += String.fromCharCode(byte);
  const bytes = [...new TextEncoder().encode(`\x1b[7777~${btoa(binary)}\x1b[7778~`)];
  editorFrame.contentWindow?.postMessage({ type: "wasmacs:input", bytes }, location.origin);
}

// The compiler speaks of the file as the application's Emacs has it; the
// editor has it under its own name.
function editorLog(log, loaded, path) {
  if (!log) return "";
  const inApp = (loaded?.file || "").split("/").pop();
  const inEditor = `${PROJECT}/${path}`;
  return inApp ? log.split(inApp).join(inEditor) : log;
}

// What happened to a change: the status line here, and the same in Emacs
// (with the compiler's messages, where one can jump to their places).
function report(status, summary, log = "") {
  setStatus(summary, status);
  tellEditor({ type: "log", status, summary: `elisp-studio: ${summary}`, log });
}

// ---- the server -----------------------------------------------------------------
// A project with a server.el has a server: a third Emacs in this tab (the
// eval service again) that runs it on lisp/app-server.el.  The application's
// requests to /api/... are answered by it instead of the network.  What it
// keeps (app-server-write, an SQLite database) is saved in IndexedDB.

let server = null;            // { emacs, source, signature } | null
let serverLibrary = null;

// The server's data directory, kept in IndexedDB (it may hold an SQLite
// database): [[file name, base64 of its bytes], ...].
function studioStore(mode, action) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("elisp-studio", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("data", mode);
      const result = action(transaction.objectStore("data"));
      transaction.oncomplete = () => { request.result.close(); resolve(result.result); };
      transaction.onerror = () => { request.result.close(); reject(transaction.error); };
    };
  });
}
const loadServerData = () => studioStore("readonly", (store) => store.get(SERVER_DATA_KEY)).then((data) => data || [], () => []);
const saveServerData = (data) => studioStore("readwrite", (store) => store.put(data, SERVER_DATA_KEY)).catch(() => {});

async function startServer(source) {
  stopServer();
  const { createEmacsEvalService } = await import(new URL("app/src/emacs-eval-client.js", WASMACS).href);
  serverLibrary ??= await (await fetch(new URL("lisp/app-server.el", here), { cache: "no-store" })).text();
  const emacs = createEmacsEvalService({ onOutput: (text) => console.log(`[server] ${text.trimEnd()}`) });
  await withTimeout(emacs.ready, FIRST_START_TIMEOUT_MS, "the server's Emacs");
  await emacs.eval(`${serverLibrary}\n(app-server-use-tab-host)\nnil`);
  await emacs.call("app-server--restore", await loadServerData());
  server = { emacs, source: null, signature: await emacs.call("app-server--signature"), deferred: new Map() };
  await loadServer(source);
}

function stopServer() {
  try { server?.emacs.terminate(); } catch (_) { /* gone already */ }
  server = null;
}

// Evaluate server.el in the server's Emacs (again, when it changed).
async function loadServer(source) {
  await withTimeout(server.emacs.eval(`${source}\nnil`), SERVER_TIMEOUT_MS, "the server");
  server.source = source;
}

// Bring the server in line with the project.  Returns a line for the
// status, or null when nothing changed.
async function syncServer(project) {
  const source = project.get(SERVER_FILE);
  if (source === undefined) {
    if (!server) return null;
    stopServer();
    return "server.el is gone: the server stopped";
  }
  if (server && server.source === source) return null;
  try {
    if (server) {
      await loadServer(source);
      return `server.el updated at ${clock()}: the server keeps its data`;
    }
    await startServer(source);
    return "the server runs";
  } catch (error) {
    if (/did not answer/.test(error.message)) stopServer();
    throw Object.assign(new Error(`server.el: ${error.symbol ? `${error.symbol}: ` : ""}${error.message}`), { server: true });
  }
}

// Keep what the server keeps, when a request changed it.
async function keepServerData(current) {
  const signature = await current.emacs.call("app-server--signature");
  if (signature !== current.signature) {
    current.signature = signature;
    await saveServerData(await current.emacs.call("app-server--dump"));
  }
}

// PBKDF2-HMAC-SHA-256 with Web Crypto: 32 bytes in hex, or null for an
// algorithm the browser does not have.  The same bytes as python3's hashlib
// and app-server.el's own Lisp give for the same request.
async function passwordDigest({ algorithm, parameters, password, salt }) {
  if (algorithm !== "pbkdf2-sha256" || !crypto.subtle) return null;
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", text.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: text.encode(salt), iterations: Number(parameters) }, key, 256);
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The server's Emacs runs only while it answers a call, so this page waits
// in its place.  EVENTS is what a call left behind: answers of deferred
// requests that are complete now, and work the server asks for
// (app-server-after, app-server-fetch), which is reported back when done.
function serverEvents(current, events) {
  for (const [id, status, text, headers] of events.finished || []) {
    current.deferred.get(id)?.([status, text, headers]);
    current.deferred.delete(id);
  }
  for (const [id, command, argument] of events.commands || []) {
    const done = async (ok, value) => {
      if (server !== current) return;
      try {
        serverEvents(current, await withTimeout(
          current.emacs.call("app-server-tab-report", id, ok, value), SERVER_TIMEOUT_MS, "the server"));
        await keepServerData(current);
      } catch (error) {
        report("error", `server.el: ${error.message}`);
      }
    };
    if (command === "kdf") {
      // A password hash: the browser's own code does the arithmetic.  What
      // it cannot compute (scrypt) is answered with null.
      passwordDigest(argument).then((digest) => done(true, digest), () => done(true, null));
    } else if (command === "timeout") {
      setTimeout(() => done(true, null), argument);
    } else if (command === "fetch") {
      fetch(argument.url, {
        method: argument.method,
        headers: argument.headers || undefined,
        body: argument.body ?? undefined,
      }).then(async (response) => done(true, { status: response.status, ok: response.ok, text: await response.text() }),
              (error) => done(false, String(error.message || error)));
    }
  }
}

// The application's requests never reach the browser's network code, so
// its cookies are kept here: what server.el sets comes back with the next
// request, until the studio is reloaded.
const cookies = new Map();
function keepCookie(text) {
  const [pair, ...attributes] = text.split(";").map((part) => part.trim());
  const equals = pair.indexOf("=");
  if (equals < 1) return;
  const gone = attributes.some((attribute) => /^max-age=(0|-\d+)$/i.test(attribute));
  if (gone) cookies.delete(pair.slice(0, equals));
  else cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
}

function toBase64(bytes) {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(text);
}

// The headers of a request, as the plist the server takes: { cookie, ... }.
function requestHeaders(given) {
  const headers = {};
  for (const [name, value] of new Headers(given || {})) headers[name.toLowerCase()] = value;
  if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  return headers;
}

// The fetch of the application: /api/... goes to the server's Emacs.
async function applicationFetch(url, options = {}) {
  const target = new URL(url, "http://application.invalid/");
  if (target.origin !== "http://application.invalid" || !target.pathname.startsWith("/api/")) {
    return fetch(url, options);
  }
  // The answer as a Response.  Set-Cookie is not a header a page may see:
  // the cookies go to the jar that stands in for the browser's.
  // VALUE is text, or { base64, type, name } when server.el answered with a file.
  const lisp = (status, value, headers = []) => {
    const file = typeof value === "string" ? null : value;
    const response = new Headers({ "Content-Type": file ? file.type : "application/x-emacs-lisp; charset=utf-8" });
    if (file?.name) response.set("Content-Disposition", `attachment; filename="${file.name.replace(/[^A-Za-z0-9._ -]/g, "_")}"`);
    for (const [name, text] of headers) {
      if (name.toLowerCase() === "set-cookie") keepCookie(text);
      else response.append(name, text);
    }
    return new Response(file ? Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)) : value, { status, headers: response });
  };
  if (!server) return lisp(404, '"This application has no server.el"');
  try {
    const current = server;
    // A body that is not text (a File the visitor chose) travels as base64:
    // fine for trying an upload out, not for large files.
    const body = options.body ?? "";
    const binary = typeof body === "string" ? null : new Uint8Array(await new Response(body).arrayBuffer());
    if (binary && binary.length > TAB_UPLOAD_LIMIT) return lisp(413, '"The studio takes uploads of up to 32 MB; a native Emacs takes more"');
    const sent = requestHeaders(options.headers);
    if (binary && !sent["content-type"] && body.type) sent["content-type"] = body.type;
    const result = await withTimeout(
      current.emacs.call("app-server-tab-request", options.method || "GET", target.pathname + target.search,
        binary ? "" : body, sent,
        binary ? { base64: toBase64(binary), type: sent["content-type"] || "application/octet-stream" } : null),
      binary ? UPLOAD_TIMEOUT_MS : SERVER_TIMEOUT_MS, "the server");
    // An answer that comes later (app-server-defer) arrives with the
    // events of some later call.
    const later = result.answer ? null : new Promise((resolve) => {
      current.deferred.set(result.pending, resolve);
      setTimeout(() => resolve([504, '"The server did not answer in time"', []]), DEFERRED_TIMEOUT_MS);
    });
    serverEvents(current, result);
    await keepServerData(current);
    const [status, text, headers] = result.answer || await later;
    current.deferred.delete(result.pending);
    return lisp(status, text, headers);
  } catch (error) {
    if (/did not answer/.test(error.message)) {
      // Busy for good (an endless loop in a handler): start a new one.
      const source = server?.source;
      stopServer();
      report("error", "the server did not answer and was started again");
      if (source !== null && source !== undefined) startServer(source).catch(() => {});
      return lisp(504, '"The server did not answer"');
    }
    return lisp(500, JSON.stringify(error.message));
  }
}

// ---- the application --------------------------------------------------------------

let files = new Map();        // the project as the application has it: path -> text
// Files of which the application has a definition that was never saved
// (C-M-x).  When Emacs saves such a file, the application gets the file
// again, even if its text is what the application was given before.
const unsaved = new Set();
const savedAgain = new Set();
let preview = null;           // { frame, app, sources: Map(path -> name), styles: Map(path -> <style>) }
let generation = 0;

// The document of the application: the project's index.html with its
// stylesheets inlined (they are not files a browser could fetch) and its
// Emacs Lisp taken out as sources for elisp-react's host.
function buildDocument(project) {
  const html = project.get("index.html");
  if (!html) throw new Error(`${PROJECT}/index.html is missing`);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const styles = [];
  for (const link of doc.querySelectorAll('link[rel="stylesheet"][href]')) {
    const path = link.getAttribute("href");
    if (!project.has(path)) continue;
    const style = doc.createElement("style");
    style.dataset.studioFile = path;
    style.textContent = project.get(path);
    link.replaceWith(style);
    styles.push(path);
  }
  const sources = [];
  for (const script of doc.querySelectorAll('script[type="text/emacs-lisp"]')) {
    const path = script.getAttribute("src");
    if (path && !project.has(path)) throw new Error(`index.html loads ${path}, which is not in the project`);
    sources.push(path ? { path, name: `elisp-studio:${path}`, text: project.get(path) }
      : { path: null, name: `elisp-studio:inline ${sources.length + 1}`, text: script.textContent });
    script.remove();
  }
  // The studio starts the host itself, inside the frame.
  for (const script of doc.querySelectorAll('script[src*="elisp-react"]')) script.remove();
  doc.documentElement.setAttribute("data-elisp-react-manual", "");
  const bootstrap = doc.createElement("script");
  bootstrap.type = "module";
  bootstrap.textContent = `import { start } from ${JSON.stringify(new URL("js/elisp-react.js", ELISP_REACT).href)};
window.__studio = { start };
window.parent.postMessage({ type: "elisp-studio:preview-ready" }, window.parent.location.origin);`;
  doc.body.append(bootstrap);
  return { html: `<!doctype html>\n${doc.documentElement.outerHTML}`, sources, styles };
}

// Start the application from PROJECT in a new frame.
async function startPreview(project, why) {
  const mine = ++generation;
  if (preview) {
    try { preview.app?.emacs.terminate(); } catch (_) { /* gone already */ }
    preview.frame.remove();
    preview = null;
  }
  showError("");
  setStatus(`${why}: starting the application…`);
  let built;
  try {
    built = buildDocument(project);
  } catch (error) {
    setStatus("the application cannot start", "error");
    showError(error.message);
    return;
  }
  const frame = document.createElement("iframe");
  frame.id = "preview";
  frame.title = "Your application";
  const ready = new Promise((resolve) => {
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow || event.data?.type !== "elisp-studio:preview-ready") return;
      window.removeEventListener("message", onMessage);
      resolve();
    };
    window.addEventListener("message", onMessage);
  });
  frame.srcdoc = built.html;
  previewSlot.replaceChildren(frame);
  const current = { frame, app: null, sources: new Map(), styles: new Map() };
  preview = current;
  try {
    await withTimeout(ready, 30000, "the application's page");
    frame.contentDocument.addEventListener("elisp-react:error", (event) => {
      if (preview !== current) return;
      const error = event.detail;
      const text = `${error?.symbol ? `${error.symbol}: ` : ""}${error?.message || error}`;
      showError(text);
      report("error", "error in the application", text);
    });
    // A link to /api/ (a download that server.el answers) cannot leave this
    // frame as a navigation: ask the server here and hand over the file.
    frame.contentDocument.addEventListener("click", async (event) => {
      const link = event.target.closest?.("a[href]");
      const href = link?.getAttribute("href") || "";
      if (!href.startsWith("/api/")) return;
      event.preventDefault();
      const response = await applicationFetch(href);
      if (!response.ok) return showError(`${href}: ${await response.text()}`);
      const save = document.createElement("a");
      save.href = URL.createObjectURL(await response.blob());
      save.download = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1]
        || link.getAttribute("download") || "download";
      save.click();
      setTimeout(() => URL.revokeObjectURL(save.href), 60000);
    });
    const app = await withTimeout(frame.contentWindow.__studio.start({
      wasmacs: WASMACS.href,
      sources: built.sources.map(({ name, text }) => ({ name, text })),
      fetch: applicationFetch,
    }), startedOnce ? START_TIMEOUT_MS : FIRST_START_TIMEOUT_MS, "the application");
    if (mine !== generation) return;
    startedOnce = true;
    current.app = app;
    for (const source of built.sources) if (source.path) current.sources.set(source.path, source.name);
    for (const path of built.styles) {
      current.styles.set(path, frame.contentDocument.querySelector(`style[data-studio-file="${CSS.escape(path)}"]`));
    }
    const log = app.compileLogs
      .map((entry) => editorLog(entry.log, entry, built.sources.find((source) => source.name === entry.name)?.path))
      .filter(Boolean).join("\n\n");
    report("ok", `${why}: the application runs (Emacs ${app.version}, ${clock()})`, log);
  } catch (error) {
    if (mine !== generation) return;
    // Take the frame away: that also ends an Emacs that is stuck in the
    // program (an endless loop while rendering).  The next change of a file
    // starts a new one.
    frame.remove();
    preview = null;
    showError(error.message || String(error));
    report("error", "the application did not start; it starts again when a file changes",
           `${error.log ? `${error.log}\n\n` : ""}${error.message || error}`);
  }
}

// The editor has NEXT; the application has `files`.  Bring it up to date.
async function applyProject(next) {
  const changed = [...next.keys()].filter((path) => next.get(path) !== files.get(path) || savedAgain.has(path));
  for (const path of changed) {
    unsaved.delete(path);
    savedAgain.delete(path);
  }
  const first = files.size === 0;
  files = next;
  // The server first: the application asks it as soon as it starts.
  let serverNews = null;
  try {
    serverNews = await syncServer(next);
  } catch (error) {
    showError(error.message);
    report("error", "server.el was not applied (the server runs on with the old code)", error.message);
    if (!first) return;
  }
  if (first) return startPreview(next, "project loaded");
  const serverOnly = changed.every((path) => path === SERVER_FILE);
  if (serverNews && serverOnly) {
    showError("");
    return report("ok", serverNews);
  }
  if (changed.length === 0) return;
  if (!preview?.app || changed.includes("index.html")) {
    return startPreview(next, changed.includes("index.html") ? "index.html changed" : `${changed[0]} changed`);
  }
  const done = [];
  const logs = [];
  for (const path of changed) {
    if (preview.styles.has(path)) {
      preview.styles.get(path).textContent = next.get(path);
      done.push(path);
    } else if (preview.sources.has(path)) {
      try {
        const loaded = await withTimeout(preview.app.load(preview.sources.get(path), next.get(path)), LOAD_TIMEOUT_MS, "the application");
        if (loaded.log) logs.push(editorLog(loaded.log, loaded, path));
        done.push(path);
      } catch (error) {
        if (/did not answer/.test(error.message)) {
          // Emacs is busy for good (an endless loop): only a new one helps.
          await startPreview(next, `${path} made the application hang; restarted`);
          return;
        }
        const text = `${error.symbol ? `${error.symbol}: ` : ""}${error.message}`;
        showError(text);
        report("error", `${path}: not applied (the application runs on with the old code)`,
               `${error.log ? `${editorLog(error.log, error, path)}\n\n` : ""}${text}`);
        return;
      }
    }
  }
  if (done.length) {
    showError("");
    report("ok", `${done.join(", ")} updated at ${clock()}: no reload, state kept`, logs.join("\n\n"));
  }
}

// C-M-x in Emacs: one definition, evaluated in the running application.
async function evalInApplication(file, text) {
  if (file === SERVER_FILE) {
    if (!server) return report("error", "the server is not running");
    try {
      await withTimeout(server.emacs.eval(`${text}\nnil`), SERVER_TIMEOUT_MS, "the server");
      unsaved.add(file);
      server.source = null;      // not what the file says any more: a save loads it again
      showError("");
      return report("ok", `a definition of ${file} evaluated in the server at ${clock()} (not saved yet)`);
    } catch (error) {
      const message = `${error.symbol ? `${error.symbol}: ` : ""}${error.message}`;
      showError(message);
      return report("error", `the definition of ${file} was not applied`, message);
    }
  }
  if (!preview?.app) return report("error", "the application is not running");
  if (!preview.sources.has(file)) return report("error", `${file} is not part of the running application`);
  try {
    await withTimeout(preview.app.run(text), LOAD_TIMEOUT_MS, "the application");
    unsaved.add(file);
    showError("");
    report("ok", `a definition of ${file} evaluated at ${clock()}: state kept (not saved yet)`);
  } catch (error) {
    if (/did not answer/.test(error.message)) return startPreview(files, "the application hung; restarted");
    const message = `${error.symbol ? `${error.symbol}: ` : ""}${error.message}`;
    showError(message);
    report("error", `the definition of ${file} was not applied`, message);
  }
}

let editorOptions = [];

// One change after the other.
let queue = Promise.resolve();
function onUserImage(bytes) {
  const next = projectFiles(bytes, PROJECT);
  if (next.size === 0) return;      // the project does not exist yet
  queue = queue.then(() => applyProject(next)).catch((error) => {
    setStatus("studio error", "error");
    showError(error.stack || String(error));
  });
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== editorFrame.contentWindow) return;
  if (event.data?.type === "wasmacs:options-request") {
    editorFrame.contentWindow.postMessage({ type: "wasmacs:options", extraEvals: editorOptions }, location.origin);
  }
  if (event.data?.type === "wasmacs:user-image") onUserImage(new Uint8Array(event.data.bytes));
  if (event.data?.type === "wasmacs:message") onEditorMessage(event.data.text);
});

// What lisp/elisp-studio.el sends.
function onEditorMessage(text) {
  let message;
  try { message = JSON.parse(text); } catch (_) { return; }
  if (message.type === "eval") {
    queue = queue.then(() => evalInApplication(message.file, message.text)).catch(() => {});
  }
  // The file image that follows a save may be the same text as before.
  if (message.type === "saved") {
    queue = queue.then(() => { if (unsaved.has(message.file)) savedAgain.add(message.file); });
  }
}

// The project as one file, ready to run somewhere else: its own files, and
// what makes a native Emacs its web server (run.sh; see tools/project/).
const RUNTIME_FILES = [
  ["run.sh", "tools/project/run.sh", true],
  ["fetch-emacs.sh", "tools/project/fetch-emacs.sh", true],
  ["README.txt", "tools/project/README.txt", false],
  ["server/serve-project.el", "tools/serve-project.el", false],
  ["server/app-server.el", "lisp/app-server.el", false],
  ["server/deploy/Caddyfile", "tools/project/deploy/Caddyfile", false],
  ["server/deploy/nginx.conf", "tools/project/deploy/nginx.conf", false],
  ["server/deploy/app.service", "tools/project/deploy/app.service", false],
];

async function projectZip() {
  const entries = [...files];
  for (const [path, source, executable] of RUNTIME_FILES) {
    if (files.has(path)) continue;        // the project's own file wins
    const response = await fetch(new URL(source, here), { cache: "no-store" });
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    entries.push([path, { content: await response.text(), executable }]);
  }
  return createZip(entries);
}

document.querySelector("#download").addEventListener("click", async () => {
  if (files.size === 0) return;
  let zip;
  try {
    zip = await projectZip();
  } catch (error) {
    setStatus(`the archive could not be made: ${error.message}`, "error");
    return;
  }
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "elisp-studio-app.zip";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("elisp-studio-app.zip: the project and run.sh, which makes Emacs its web server", "ok");
});

document.querySelector("#restart").addEventListener("click", () => {
  if (files.size) queue = queue.then(() => startPreview(files, "restarted"));
});

// For tests and the console.
window.elispStudio = {
  fetch: applicationFetch,
  get preview() { return preview; },
  get files() { return files; },
  get server() { return server; },
  zip: projectZip,
  editor: editorFrame,
};

try {
  if (!window.crossOriginIsolated) {
    setStatus("waiting for cross-origin isolation (the page reloads once)…");
  } else {
    await ensureEditorServiceWorker();
    setStatus("starting Emacs…");
    editorOptions = await editorForms();
    editorFrame.src = editorUrl();
  }
} catch (error) {
  setStatus("the studio did not start", "error");
  showError(error.stack || String(error));
}
