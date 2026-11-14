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

const here = new URL("../", import.meta.url);                 // .../elisp-studio/
// The sibling sites, on the same origin (GitHub Pages: modeverv.github.io/...).
const WASMACS = new URL("../wasmacs/", here);
const ELISP_REACT = new URL("../elisp-react/", here);
const PROJECT = "/home/user/elisp-studio/app";
const TEMPLATE_FILES = ["index.html", "app.el", "style.css"];
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

// Emacs creates the project from the template the first time, and visits
// app.el.  The forms travel as --eval arguments in the editor's URL.
async function editorUrl() {
  const template = await Promise.all(TEMPLATE_FILES.map(async (name) => {
    const response = await fetch(new URL(`template/${name}`, here), { cache: "no-store" });
    if (!response.ok) throw new Error(`template/${name}: HTTP ${response.status}`);
    return [name, await response.text()];
  }));
  const url = new URL("app/xterm-atomics-pdump.html", WASMACS);
  url.searchParams.set("embed", "1");
  url.searchParams.append("extra-eval", `(progn
    (setq make-backup-files nil auto-save-default nil)
    (unless (file-exists-p ${lispString(`${PROJECT}/app.el`)})
      (make-directory ${lispString(PROJECT)} t)
      ${template.map(([name, text]) => `(write-region ${lispString(text)} nil ${lispString(`${PROJECT}/${name}`)} nil 'silent)`).join("\n      ")}))`);
  url.searchParams.append("extra-eval", `(find-file ${lispString(`${PROJECT}/app.el`)})`);
  return url.href;
}

// ---- the application --------------------------------------------------------------

let files = new Map();        // the project as the application has it: path -> text
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
      setStatus("error in the application", "error");
      showError(`${error?.symbol ? `${error.symbol}: ` : ""}${error?.message || error}`);
    });
    const app = await withTimeout(frame.contentWindow.__studio.start({
      wasmacs: WASMACS.href,
      sources: built.sources.map(({ name, text }) => ({ name, text })),
    }), startedOnce ? START_TIMEOUT_MS : FIRST_START_TIMEOUT_MS, "the application");
    if (mine !== generation) return;
    startedOnce = true;
    current.app = app;
    for (const source of built.sources) if (source.path) current.sources.set(source.path, source.name);
    for (const path of built.styles) {
      current.styles.set(path, frame.contentDocument.querySelector(`style[data-studio-file="${CSS.escape(path)}"]`));
    }
    setStatus(`${why}: the application runs (Emacs ${app.version}, ${clock()})`, "ok");
  } catch (error) {
    if (mine !== generation) return;
    // Take the frame away: that also ends an Emacs that is stuck in the
    // program (an endless loop while rendering).  The next change of a file
    // starts a new one.
    frame.remove();
    preview = null;
    setStatus("the application did not start; it starts again when a file changes", "error");
    showError(error.message || String(error));
  }
}

// The editor has NEXT; the application has `files`.  Bring it up to date.
async function applyProject(next) {
  const changed = [...next.keys()].filter((path) => next.get(path) !== files.get(path));
  const first = files.size === 0;
  files = next;
  if (first) return startPreview(next, "project loaded");
  if (changed.length === 0) return;
  if (!preview?.app || changed.includes("index.html")) {
    return startPreview(next, changed.includes("index.html") ? "index.html changed" : `${changed[0]} changed`);
  }
  const done = [];
  for (const path of changed) {
    if (preview.styles.has(path)) {
      preview.styles.get(path).textContent = next.get(path);
      done.push(path);
    } else if (preview.sources.has(path)) {
      try {
        await withTimeout(preview.app.load(preview.sources.get(path), next.get(path)), LOAD_TIMEOUT_MS, "the application");
        done.push(path);
      } catch (error) {
        if (/did not answer/.test(error.message)) {
          // Emacs is busy for good (an endless loop): only a new one helps.
          await startPreview(next, `${path} made the application hang; restarted`);
          return;
        }
        setStatus(`${path}: not applied (the application runs on with the old code)`, "error");
        showError(`${error.symbol ? `${error.symbol}: ` : ""}${error.message}`);
        return;
      }
    }
  }
  if (done.length) {
    showError("");
    setStatus(`${done.join(", ")} updated at ${clock()}: no reload, state kept`, "ok");
  }
}

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
  if (event.data?.type === "wasmacs:user-image") onUserImage(new Uint8Array(event.data.bytes));
});

document.querySelector("#restart").addEventListener("click", () => {
  if (files.size) queue = queue.then(() => startPreview(files, "restarted"));
});

// For tests and the console.
window.elispStudio = {
  get preview() { return preview; },
  get files() { return files; },
  editor: editorFrame,
};

try {
  if (!window.crossOriginIsolated) {
    setStatus("waiting for cross-origin isolation (the page reloads once)…");
  } else {
    await ensureEditorServiceWorker();
    setStatus("starting Emacs…");
    editorFrame.src = await editorUrl();
  }
} catch (error) {
  setStatus("the studio did not start", "error");
  showError(error.stack || String(error));
}
