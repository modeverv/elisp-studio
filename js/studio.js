// elisp-studio: write a web application in the browser and watch it change.
// Copyright (c) 2026 modeverv
// SPDX-License-Identifier: MIT
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
//
// With ?project=local, on one's own machine (tools/studio.mjs DIRECTORY),
// there is no editor in the page: the project is a directory, edited with
// whatever one edits with, and tools/serve.mjs reports its files.
import { projectFiles } from "./tar.js";
import { createZip } from "./zip.js";

const here = new URL("../", import.meta.url);                 // .../elisp-studio/
// The sibling sites, on the same origin (GitHub Pages: modeverv.github.io/...).
const WASMACS = new URL("../wasmacs/", here);
const ELISP_REACT = new URL("../elisp-react/", here);
let PROJECT = "/home/user/elisp-studio/app";
// A project in a directory of this machine: only a server of this machine
// can have one.
const LOCAL = new URLSearchParams(location.search).get("project") === "local"
  && ["127.0.0.1", "localhost"].includes(location.hostname);
// What a new project starts with: template/, or with ?example=NAME one of
// examples/.  server.el is optional.  (A project that exists is left alone.)
const example = new URLSearchParams(location.search).get("example");
const TEMPLATE = /^[a-z0-9-]+$/.test(example || "") ? `examples/${example}/` : "template/";
const TEMPLATE_FILES = ["index.html", "app.el", "style.css"];
const TEMPLATE_OPTIONAL_FILES = ["server.el", "test/app-test.el"];
const SERVER_FILE = "server.el";
// The server's data in IndexedDB.  A studio of this machine opens one
// directory after another on the same address, so there each has its own.
const serverDataKey = () => (LOCAL ? `server-data:${PROJECT}` : "server-data");
const TAB_UPLOAD_LIMIT = 32 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60000;
const DEFERRED_TIMEOUT_MS = 30000;   // as app-server-deferred-timeout
const SERVER_TIMEOUT_MS = 8000;
const LOAD_TIMEOUT_MS = 8000;
// Starting the application: the first time Emacs has to be downloaded
// (the editor's, 150 MB; the application's own is small); after that it
// comes from the browser's cache.
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
    // A project exists when it has an index.html (its Lisp need not be
    // app.el): then nothing is written.  A new one gets the template's
    // files, never over a file that is there.
    `(progn
      (setq make-backup-files nil auto-save-default nil)
      (unless (file-exists-p ${lispString(`${PROJECT}/index.html`)})
        (make-directory ${lispString(PROJECT)} t)
        ${template.map(([name, content]) => `(unless (file-exists-p ${lispString(`${PROJECT}/${name}`)})
          (make-directory ${lispString(`${PROJECT}/${name}`.replace(/[^/]*$/, ""))} t)
          (write-region ${lispString(content)} nil ${lispString(`${PROJECT}/${name}`)} nil 'silent))`).join("\n        ")}))`,
    // The first Lisp file index.html loads, or app.el.
    String.raw`(find-file
      (let ((index ` + lispString(`${PROJECT}/index.html`) + String.raw`) (found nil))
        (when (file-exists-p index)
          (with-temp-buffer
            (insert-file-contents index)
            (goto-char (point-min))
            (while (and (not found) (re-search-forward "<script[^>]*>" nil t))
              (let ((tag (match-string 0)))
                (when (and (string-match-p "text/emacs-lisp" tag)
                           (string-match "src=[\"']\\([^\"']+\\)" tag))
                  (setq found (expand-file-name (match-string 1 tag) ` + lispString(PROJECT) + String.raw`)))))))
        (or found ` + lispString(`${PROJECT}/app.el`) + `)))`,
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
  if (LOCAL) {
    // The editor is somewhere on this machine; the server passes it on.
    fetch("/__project/report", { method: "POST", body: JSON.stringify({ status, summary: `elisp-studio: ${summary}`, log }) })
      .catch(() => {});
    return;
  }
  tellEditor({ type: "log", status, summary: `elisp-studio: ${summary}`, log });
}

// ---- the server -----------------------------------------------------------------
// A project with a server.el has a server: a third Emacs in this tab (the
// eval service again) that runs it on lisp/app-server.el.  The application's
// requests to /api/... are answered by it instead of the network.  What it
// keeps (app-server-write, an SQLite database) is saved in IndexedDB.  It
// has a copy of the project's text files in /project/, for server.el to
// load what it shares with the page.
//
// A project in a directory may have its server.el run by a native Emacs
// instead (tools/studio.mjs DIR --native-server): then /api/ goes to it.

let server = null;            // { emacs, source, copies, signature, deferred } | null
let serverLibrary = null;
let nativeServer = false;
const SERVER_PROJECT = "/project/";

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
const loadServerData = () => studioStore("readonly", (store) => store.get(serverDataKey())).then((data) => data || [], () => []);
const saveServerData = (data) => studioStore("readwrite", (store) => store.put(data, serverDataKey())).catch(() => {});

async function startServer(source, project) {
  stopServer();
  const { createEmacsEvalService } = await import(new URL("app/src/emacs-eval-client.js", WASMACS).href);
  serverLibrary ??= await (await fetch(new URL("lisp/app-server.el", here), { cache: "no-store" })).text();
  const emacs = createEmacsEvalService({ onOutput: (text) => console.log(`[server] ${text.trimEnd()}`) });
  await withTimeout(emacs.ready, FIRST_START_TIMEOUT_MS, "the server's Emacs");
  await emacs.eval(`${serverLibrary}\n(app-server-use-tab-host)\n(app-server-use-project ${lispString(SERVER_PROJECT)})\nnil`);
  await emacs.call("app-server--restore", await loadServerData());
  server = { emacs, source: null, copies: new Map(), signature: await emacs.call("app-server--signature"), deferred: new Map() };
  await copyToServer(project);
  await loadServer(source);
}

// Bring the server's copy of the project's text files (all but server.el,
// which is evaluated) in line with PROJECT.  Returns the files it loaded
// again, having loaded them before.
async function copyToServer(project) {
  const next = new Map([...project].filter(([path, content]) => typeof content === "string" && path !== SERVER_FILE));
  const changed = [...next].filter(([path, text]) => server.copies.get(path) !== text);
  const removed = [...server.copies.keys()].filter((path) => !next.has(path));
  server.copies = next;
  if (!changed.length && !removed.length) return [];
  return withTimeout(server.emacs.call("app-server-tab-files", changed, removed), SERVER_TIMEOUT_MS, "the server");
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
  if (source === undefined || nativeServer) {
    if (!server) return null;
    stopServer();
    return nativeServer ? null : "server.el is gone: the server stopped";
  }
  try {
    if (server) {
      const again = await copyToServer(project);
      if (server.source !== source) {
        await loadServer(source);
        return `server.el updated at ${clock()}: the server keeps its data`;
      }
      return again.length ? `${again.join(", ")} loaded again in the server at ${clock()}` : null;
    }
    await startServer(source, project);
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
  if (target.origin !== "http://application.invalid") return fetch(url, options);
  if (!target.pathname.startsWith("/api/")) {
    // A file of the project (data.json): from the project, not from the
    // studio's own site, which relative URLs would reach from here.
    const path = decodeURIComponent(target.pathname.slice(1));
    if (files.has(path)) {
      const content = files.get(path);
      const type = /\.json$/.test(path) ? "application/json" : typeof content === "string" ? "text/plain; charset=utf-8" : "application/octet-stream";
      return new Response(content, { headers: { "Content-Type": type } });
    }
    if (LOCAL) return fetch(new URL(target.pathname.slice(1) + target.search, `${location.origin}/__project/files/`), options);
    return new Response(`"${path} is not a file of the project"`, { status: 404 });
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
  // A native Emacs: the request goes there as it is, cookies and all.
  if (nativeServer) return fetch(new URL(target.pathname + target.search, location.origin), options);
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
      if (source !== null && source !== undefined) startServer(source, files).catch(() => {});
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
// Files that a failed change left unloaded (the one that failed, those after
// it): the next change loads them again, even if their text is the same.
const retry = new Set();
let preview = null;           // { frame, app, sources: Map(path -> name), styles: Map(path -> <style>) }
let generation = 0;

// The document of the application: the project's index.html with its
// stylesheets inlined (they are not files a browser could fetch) and its
// Emacs Lisp taken out as sources for elisp-react's host.
function buildDocument(project) {
  const html = project.get("index.html");
  if (!html) throw new Error(`${PROJECT}/index.html is missing`);
  const doc = new DOMParser().parseFromString(html, "text/html");
  // On this machine the server has the project's files: relative URLs
  // (an <img src>, a data file) resolve there, not to the studio's page.
  if (LOCAL) {
    const base = doc.createElement("base");
    base.href = `${location.origin}/__project/files/`;
    doc.head.prepend(base);
  }
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
      // The application's localStorage values (react-storage-set): the
      // frame is "srcdoc" for every project, and a studio of this machine
      // shows one directory after another on the same address.  A page
      // that names its own (<meta name="elisp-react:storage">) keeps it.
      ...(LOCAL && !frame.contentDocument.querySelector('meta[name="elisp-react:storage"]') ? { storage: PROJECT } : {}),
      // "restart app" is a start from the files as they are: no compiled
      // code kept from an earlier start (it may have been compiled against
      // another version of a file's macros).
      cache: why !== "restarted",
    }), startedOnce ? START_TIMEOUT_MS : FIRST_START_TIMEOUT_MS, "the application");
    if (mine !== generation) return;
    startedOnce = true;
    current.app = app;
    connectAddress(current);
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

// The address bar: the application's address, which elisp-react keeps in
// memory in the preview, followed and set from here.
const addressField = document.querySelector("#address");
function connectAddress(current) {
  const show = (described) => { if (preview === current && described) addressField.value = described.href; };
  current.frame.contentDocument.addEventListener("elisp-react:location", (event) => show(event.detail));
  show(current.app.location?.current);
}
document.querySelector("#back").addEventListener("click", () => preview?.app?.location?.go(-1));
document.querySelector("#forward").addEventListener("click", () => preview?.app?.location?.go(1));
addressField.addEventListener("keydown", (event) => {
  if (event.key === "Enter") preview?.app?.location?.navigate(addressField.value.trim() || "/");
});

// Definitions that a change took out of its file, but that the running
// application still has: a renamed function, a removed component.  They
// would go on working until the next fresh start, and fail there.  The
// application's Emacs reads the files' top-level forms, takes away what
// no current source defines any more, and says which other files still
// name it.
const DEFINITIONS = `(defun elisp-studio--defined (text)
  (with-temp-buffer
    (insert text) (goto-char (point-min))
    (let (names)
      (condition-case nil
          (while t
            (let ((form (read (current-buffer))))
              (when (consp form)
                (pcase form
                  (\`(,(or 'defun 'defmacro 'defsubst 'cl-defun 'cl-defmacro 'define-inline 'defalias) ,(and name (pred symbolp)) . ,_)
                   (push (list "function" name) names))
                  (\`(defalias (quote ,name) . ,_) (push (list "function" name) names))
                  (\`(,(or 'defvar 'defconst 'defcustom 'defvar-local) ,(and name (pred symbolp)) . ,_)
                   (push (list "variable" name) names))
                  (\`(react-define-component (quote ,name) . ,_) (push (list "component" name) names))))))
        (error nil))
      names)))
(defun elisp-studio--forget (old current)
  (let (gone)
    (dolist (entry (apply #'append (mapcar #'elisp-studio--defined old)))
      (unless (or (member entry (apply #'append (mapcar #'elisp-studio--defined current))) (member entry gone))
        (push entry gone)
        (pcase (car entry)
          ("function" (fmakunbound (cadr entry)))
          ("variable" (makunbound (cadr entry)))
          ("component" (put (cadr entry) 'react-component nil)))))
    (vconcat (mapcar (lambda (entry) (vector (car entry) (symbol-name (cadr entry)))) gone))))`;

async function forgetRemoved(app, oldTexts, currentTexts) {
  const vector = (texts) => `(list ${texts.map((text) => lispString(text)).join(" ")})`;
  return app.emacs.eval(`${DEFINITIONS}\n(elisp-studio--forget ${vector(oldTexts)} ${vector(currentTexts)})`);
}

// The editor has NEXT; the application has `files`.  Bring it up to date.
async function applyProject(next) {
  const same = (a, b) => a === b || (a instanceof Uint8Array && b instanceof Uint8Array
    && a.length === b.length && a.every((byte, i) => byte === b[i]));
  const changed = [...next.keys()].filter((path) => !same(next.get(path), files.get(path)) || savedAgain.has(path) || retry.has(path));
  for (const path of changed) {
    unsaved.delete(path);
    savedAgain.delete(path);
    retry.delete(path);
  }
  const first = files.size === 0;
  const before = files;
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
  // Changed: server.el, or files that only the server uses.
  const forPage = (path) => path === "index.html" || preview.sources.has(path) || preview.styles.has(path);
  const serverOnly = changed.every((path) => path === SERVER_FILE || (preview?.app && !forPage(path)));
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
  // Stylesheets first; then the Lisp files in the order index.html loads
  // them, which is the order they depend on each other in.
  const order = [...preview.sources.keys()];
  const sources = changed.filter((path) => preview.sources.has(path)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const path of [...changed.filter((path) => preview.styles.has(path)), ...sources]) {
    if (preview.styles.has(path)) {
      preview.styles.get(path).textContent = next.get(path);
      done.push(path);
    } else if (preview.sources.has(path)) {
      try {
        const loaded = await withTimeout(preview.app.load(preview.sources.get(path), next.get(path)), LOAD_TIMEOUT_MS, "the application");
        if (loaded.log) logs.push(editorLog(loaded.log, loaded, path));
        if (loaded.renderError) {
          // The definitions are in; the render that followed failed: that
          // is what to say, with the component it failed in.
          const error = loaded.renderError;
          const text = `${error.symbol ? `${error.symbol}: ` : ""}${error.message}`;
          showError(text);
          report("error", `${path}: loaded, but the application failed to render`, [...logs, text].join("\n\n"));
          return;
        }
        done.push(path);
      } catch (error) {
        if (/did not answer/.test(error.message)) {
          // Emacs is busy for good (an endless loop): only a new one helps.
          await startPreview(next, `${path} made the application hang; restarted`);
          return;
        }
        const text = `${error.symbol ? `${error.symbol}: ` : ""}${error.message}`;
        // This file and the ones after it were not loaded: the next change
        // loads them again.
        const left = sources.slice(sources.indexOf(path));
        for (const each of left) retry.add(each);
        const skipped = left.slice(1);
        showError(text);
        report("error", `${path}: not applied (the application runs on with the old code)${skipped.length ? `; not loaded after it: ${skipped.join(", ")}` : ""}`,
               `${error.log ? `${editorLog(error.log, error, path)}\n\n` : ""}${text}`);
        return;
      }
    }
  }
  // A change of helpers or data (a defconst) redefines no component, so
  // nothing would render: every component renders again, with its state,
  // after the application's own functions have had a look
  // (elisp-studio-after-load-functions, with the files' names).
  const loadedLisp = sources.filter((path) => done.includes(path));
  if (loadedLisp.length) {
    try {
      await withTimeout(preview.app.run(`(progn
        (defvar elisp-studio-after-load-functions nil
          "Functions called with the files a save loaded, before everything renders again.")
        (run-hook-with-args 'elisp-studio-after-load-functions '(${loadedLisp.map((path) => lispString(path)).join(" ")}))
        (react-refresh))`), LOAD_TIMEOUT_MS, "the application");
    } catch (_) { /* an older elisp-react without react-refresh: as before */ }
  }
  // What the change took out of its files is taken out of the application.
  const loadedSources = sources.filter((path) => done.includes(path) && before.has(path));
  let removed = "";
  if (loadedSources.length) {
    try {
      const current = [...preview.sources.keys()].filter((path) => next.has(path)).map((path) => next.get(path));
      const gone = await forgetRemoved(preview.app, loadedSources.map((path) => before.get(path)), current);
      if (gone.length) {
        // The files that still name it, as a whole symbol.
        const symbol = (name) => new RegExp(`(^|[\\s('#,])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s()])`, "m");
        const users = (name) => [...preview.sources.keys()].filter((path) => typeof next.get(path) === "string"
          && symbol(name).test(next.get(path)));
        removed = gone.map(([kind, name]) => {
          const still = users(name);
          return `${kind} ${name} is gone${still.length ? `, but ${still.join(", ")} still use${still.length === 1 ? "s" : ""} it` : ""}`;
        }).join("; ");
      }
    } catch (_) { /* reading the definitions failed: nothing taken away */ }
  }
  if (done.length) {
    showError("");
    report(removed && /still use/.test(removed) ? "error" : "ok",
           `${done.join(", ")} updated at ${clock()}: no reload, state kept${removed ? `; ${removed}` : ""}${serverNews ? `; ${serverNews}` : ""}`,
           logs.join("\n\n"));
  }
}

// An expression, evaluated in the running application, with its value
// printed (depth and length bounded): what the editor's M-: would give,
// for an editor on this machine and for the console.  (react-inspect)
// shows the components with their props and state.
async function evaluate(text) {
  if (!preview?.app) return { error: "the application is not running" };
  try {
    const answer = await withTimeout(preview.app.emacs.eval(
      `(let ((value (progn ${text}\n))) (let ((print-length 60) (print-level 8)) (prin1-to-string value)))`,
      { detailed: true }), LOAD_TIMEOUT_MS, "the application");
    await preview.app.run("nil");          // render what it changed
    return { value: answer.value, output: answer.output || "" };
  } catch (error) {
    return { error: `${error.symbol ? `${error.symbol}: ` : ""}${error.message}` };
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
// what makes a native Emacs its web server (run.sh; see tools/project/),
// keeps it in git (.gitignore) and checks it (test/run.sh, also in CI).
// tools/studio.mjs gives a new project of a directory the same (SCAFFOLD).
const RUNTIME_FILES = [
  [".gitignore", "tools/project/gitignore", false],
  ["test/run.sh", "tools/project/test/run.sh", true],
  [".github/workflows/test.yml", "tools/project/test.yml", false],
  ["run.sh", "tools/project/run.sh", true],
  ["fetch-emacs.sh", "tools/project/fetch-emacs.sh", true],
  ["backup.sh", "tools/project/backup.sh", true],
  ["README.txt", "tools/project/README.txt", false],
  ["server/serve-project.el", "tools/serve-project.el", false],
  ["server/app-server.el", "lisp/app-server.el", false],
  ["server/LICENSE", "LICENSE", false],          // of the two files above (MIT)
  ["server/deploy/Caddyfile", "tools/project/deploy/Caddyfile", false],
  ["server/deploy/nginx.conf", "tools/project/deploy/nginx.conf", false],
  ["server/deploy/app.service", "tools/project/deploy/app.service", false],
  ["Dockerfile", "tools/project/Dockerfile", false],
  ["docker-compose.yml", "tools/project/docker-compose.yml", false],
  [".dockerignore", "tools/project/dockerignore", false],
  ["server/deploy/docker-start.sh", "tools/project/deploy/docker-start.sh", true],
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
  evaluate,
};

// The project in a directory: the server says what its files are, now and
// whenever one changed, and passes on what an editor wants evaluated.
function listenToDirectory() {
  document.body.classList.add("local");
  setStatus("waiting for the project's files…");
  const events = new EventSource("/__project/events");
  events.addEventListener("files", (event) => {
    const { directory, files: given, server: native } = JSON.parse(event.data);
    PROJECT = directory;
    nativeServer = Boolean(native);
    document.querySelector("#project").textContent = directory;
    document.title = `${directory.split("/").filter(Boolean).pop()} · elisp-studio`;
    const next = new Map(Object.entries(given));
    queue = queue.then(() => applyProject(next)).catch((error) => {
      setStatus("studio error", "error");
      showError(error.stack || String(error));
    });
  });
  events.addEventListener("value", (event) => {
    const { id, text } = JSON.parse(event.data);
    queue = queue.then(async () => {
      const answer = await evaluate(text);
      await fetch("/__project/value-answer", { method: "POST", body: JSON.stringify({ id, ...answer }) }).catch(() => {});
    });
  });
  events.addEventListener("eval", (event) => {
    const { file, text } = JSON.parse(event.data);
    queue = queue.then(() => evalInApplication(file, text)).catch(() => {});
  });
  // The native Emacs of server.el (--native-server): started, started
  // again after a change, or failed.
  events.addEventListener("server", (event) => {
    const { status, summary, log } = JSON.parse(event.data);
    queue = queue.then(() => {
      if (status === "error") showError(log || summary);
      report(status, summary, log || "");
    });
  });
  events.onerror = () => setStatus("the studio's server does not answer (tools/studio.mjs); waiting for it…", "error");
}

try {
  if (LOCAL) {
    listenToDirectory();
  } else if (!window.crossOriginIsolated) {
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
