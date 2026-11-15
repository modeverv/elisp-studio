// A project that lies in a directory of this machine, for the studio in
// "local" mode (tools/studio.mjs DIRECTORY).
//
// On GitHub Pages the project lives inside the page, in the file system of
// the Emacs that runs there.  Here it is a directory: you edit it with the
// Emacs you have (or anything else), and the studio's page, which shows the
// application, is told when a file changed and what the files are now.  It
// does with them what it does with a save in the editor of the page: a
// changed .el file is evaluated in the running application, whose state
// stays.  What happened goes back the same way, for the editor to show.
//
//   GET  /__project/events           the page listens (server-sent events):
//                                    "files" { directory, files: { name: text } }
//                                    "eval"  { file, text }
//   POST /__project/report           the page says what happened to a change
//                                    { status, summary, log }
//   GET  /__project/state            { directory, report: N }
//   GET  /__project/report?after=N   the next report after number N, waiting
//                                    up to &wait=SECONDS for it: for the editor
//   POST /__project/eval             { file, text }: evaluate TEXT in the
//                                    running application, as C-M-x does
//   POST /__project/value            { text }: evaluate TEXT in the running
//                                    application and answer with its value:
//                                    { value, output } or { error }
//   GET  /__project/files/PATH       a file of the project, for the
//                                    application (images, data): not hidden
//                                    files, server*, *.sh or .data/
//   *    /api/...                    with { nativeServer: true }: passed to
//                                    the native Emacs that runs server.el
//                                    (tools/serve-project.sh), which is
//                                    started again when server.el or a file
//                                    it loaded changes.  The page hears of
//                                    it as "server" { status, summary, log }
//
// lisp/elisp-studio-local.el is the Emacs side of the last three.
//
// These requests show and change what is in the directory's application,
// so they are for this machine's own programs: a request under another name
// than this server's (a page elsewhere that points its domain here) or from
// a page of another site is refused.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SERVE_PROJECT = fileURLToPath(new URL("serve-project.sh", import.meta.url));

const TEXT = /\.(?:html|el|css|js|mjs|json|txt|md|svg|eld)$/i;
// What a downloaded project carries besides itself (./fetch-emacs.sh
// fills vendor/wasmacs and vendor/elisp-react), and what tools leave.
// Third-party Lisp of the project's own (lib/, vendor/NAME/) is the project.
const NOT_THE_PROJECT = new Set(["vendor/wasmacs", "vendor/elisp-react", "server", "node_modules"]);
const LARGEST = 1024 * 1024;
const FILE_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".el": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".pdf": "application/pdf",
};

/** May the application see PATH (relative, with /)?  As the project server
    has it: no hidden files, nothing of the server, no scripts to run. */
export function servable(path) {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  return parts.every((part) => part && !part.startsWith(".")) && !base.startsWith("server")
    && parts[0] !== "server" && !base.endsWith(".sh") && !base.endsWith("~");
}
const LOOK_EVERY_MS = 150;

/** The text files of DIRECTORY: { files: { name: text }, stamp }. */
export function readProject(directory) {
  const files = {};
  const stamps = [];
  (function walk(relative) {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = entry.name;
      // Hidden files, and what editors leave next to a file: backups,
      // auto-saves, compiled files.
      if (name.startsWith(".") || name.endsWith("~") || name.startsWith("#") || name.endsWith(".elc")) continue;
      const path = relative ? `${relative}/${name}` : name;
      if (entry.isDirectory()) {
        if (NOT_THE_PROJECT.has(path)) continue;
        walk(path);
      } else if (entry.isFile() && TEXT.test(name)) {
        const info = statSync(join(directory, path));
        if (info.size > LARGEST) continue;
        stamps.push(`${path}:${info.size}:${info.mtimeMs}`);
        files[path] = readFileSync(join(directory, path), "utf8");
      }
    }
  })("");
  return { files, stamp: stamps.sort().join("\n") };
}

/** A port of 127.0.0.1 that nothing listens on. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

/**
 * Serve the project in DIRECTORY.  Returns { handle(request, response, url),
 * proxy(request, response), useNativeServer(port), close() }; handle
 * answers a request to /__project/..., proxy one to /api/... .
 */
export function localProject(directory, { nativeServer = false } = {}) {
  directory = resolve(directory);
  const listeners = new Set();            // the pages that listen
  let current = readProject(directory);
  let seen = current.stamp;               // what the last look found
  let report = { n: 0 };
  let waiting = [];                       // editors that wait for the next report
  let nextValue = 0;
  const values = new Map();               // id -> answer function, for /__project/value

  const send = (response, event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const filesEvent = () => ({ directory, files: current.files, ...(nativeServer ? { server: "native" } : {}) });

  // server.el in a native Emacs.  STUDIO is this server's port: pages of
  // it are the native server's own (PUBLIC_ORIGIN), as behind a proxy.
  let studio = null;
  let native = null;          // { child, port, ready, uses: [file], log: [line] }
  let serverNews = null;      // the last "server" event, for a page that comes later
  const tell = (news) => {
    serverNews = news;
    for (const listener of listeners) send(listener, "server", news);
  };
  function stopNative() {
    if (!native) return;
    native.stopped = true;
    native.child.kill("SIGTERM");
    native = null;
  }
  async function startNative(why) {
    stopNative();
    if (!studio || !("server.el" in current.files)) {
      if (why) tell({ status: "ok", summary: "server.el is gone: the native server stopped" });
      return;
    }
    const port = await freePort();
    const child = spawn("bash", [SERVE_PROJECT, directory, String(port)], {
      env: { ...process.env, WORKERS: "1", PUBLIC_ORIGIN: `http://localhost:${studio},http://127.0.0.1:${studio}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const self = { child, port, uses: ["server.el"], log: [], stopped: false };
    native = self;
    let started, failed;
    self.ready = new Promise((done, fail) => { started = done; failed = fail; });
    self.ready.catch(() => {});
    const timeout = setTimeout(() => failed(new Error("the native server did not start within 30 s")), 30_000);
    let rest = "";
    const read = (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        console.log(`[server] ${line}`);
        self.log.push(line);
        if (self.log.length > 40) self.log.shift();
        const loaded = /^serve-project: server\.el loaded (.*)$/.exec(line);
        if (loaded) self.uses.push(...loaded[1].split(", "));
        if (line.startsWith(`serve-project: http://127.0.0.1:${port}/`)) {
          clearTimeout(timeout);
          started();
          tell({ status: "ok", summary: `${why || "server.el runs"} in a native Emacs (127.0.0.1:${port})` });
        }
      }
    };
    child.stdout.setEncoding("utf8").on("data", read);
    child.stderr.setEncoding("utf8").on("data", read);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      failed(new Error("the native server ended"));
      if (self.stopped) return;
      if (native === self) native = null;
      tell({ status: "error", summary: `server.el: the native Emacs ended (${signal || `exit ${code}`})`, log: self.log.join("\n") });
    });
  }
  const onExit = () => stopNative();
  process.once("exit", onExit);

  // A file is told of when it has stopped changing: an editor may be in
  // the middle of writing it.
  const timer = setInterval(() => {
    let next;
    try { next = readProject(directory); } catch (_) { return; }   // a file went away while it was read
    if (next.stamp !== seen) { seen = next.stamp; return; }
    if (next.stamp === current.stamp) return;
    const before = current;
    current = next;
    for (const listener of listeners) send(listener, "files", filesEvent());
    // The native server again, when what it runs changed.
    if (studio) {
      const uses = native ? native.uses : ["server.el"];
      const changed = uses.filter((file) => before.files[file] !== current.files[file]);
      if (changed.length) startNative(`${changed.join(", ")} changed: server.el started again`).catch(() => {});
    }
  }, LOOK_EVERY_MS);
  timer.unref();

  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
  };
  const body = (request) => new Promise((done, fail) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; if (text.length > 4 * LARGEST) request.destroy(); });
    request.on("end", () => { try { done(JSON.parse(text)); } catch (error) { fail(error); } });
    request.on("error", fail);
  });

  async function handle(request, response, url) {
    // This server's own name, and no page of another site.
    const host = request.headers.host || "";
    const own = new Set([`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`]);
    const origin = request.headers.origin;
    if (!own.has(host) || (origin && !own.has(origin.replace(/^http:\/\//, "")))
        || request.headers["sec-fetch-site"] === "cross-site") {
      return json(response, 403, { error: "the project is for this machine's own programs" });
    }
    const what = `${request.method} ${url.pathname}`;
    if (what === "GET /__project/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      send(response, "files", filesEvent());
      if (serverNews) send(response, "server", serverNews);
      listeners.add(response);
      request.on("close", () => listeners.delete(response));
      return;
    }
    if (what === "GET /__project/state") {
      return json(response, 200, { directory, report: report.n, listening: listeners.size });
    }
    if (what === "POST /__project/report") {
      const given = await body(request);
      report = { n: report.n + 1, status: String(given.status || ""), summary: String(given.summary || ""), log: String(given.log || "") };
      for (const answer of waiting) answer();
      waiting = [];
      return json(response, 200, { n: report.n });
    }
    if (what === "GET /__project/report") {
      const after = Number(url.searchParams.get("after") || 0);
      const wait = Math.min(Number(url.searchParams.get("wait") || 0), 60) * 1000;
      if (report.n <= after && wait > 0) {
        await new Promise((done) => {
          const timeout = setTimeout(done, wait);
          waiting.push(() => { clearTimeout(timeout); done(); });
          request.on("close", done);
        });
      }
      return json(response, 200, report.n > after ? report : { n: report.n });
    }
    if (request.method === "GET" && url.pathname.startsWith("/__project/files/")) {
      const relative = decodeURIComponent(url.pathname.slice("/__project/files/".length));
      const file = resolve(directory, relative);
      if (!servable(relative) || !file.startsWith(directory + sep) || !existsSync(file) || !statSync(file).isFile()) {
        return json(response, 404, { error: "not a file of the project" });
      }
      response.writeHead(200, { "Content-Type": FILE_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
                                "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" });
      createReadStream(file).pipe(response);
      return;
    }
    if (what === "POST /__project/value") {
      const given = await body(request);
      if (typeof given.text !== "string") return json(response, 400, { error: "text" });
      if (listeners.size === 0) return json(response, 200, { error: "the studio's window is not open" });
      const id = ++nextValue;
      const answer = await new Promise((done) => {
        const timeout = setTimeout(() => done({ error: "the application did not answer within 15 s" }), 15000);
        values.set(id, (value) => { clearTimeout(timeout); done(value); });
        for (const listener of listeners) send(listener, "value", { id, text: given.text });
      });
      values.delete(id);
      return json(response, 200, answer);
    }
    if (what === "POST /__project/value-answer") {
      const given = await body(request);
      values.get(given.id)?.({ value: given.value ?? null, output: given.output ?? "", error: given.error ?? null });
      return json(response, 200, {});
    }
    if (what === "POST /__project/eval") {
      const given = await body(request);
      if (typeof given.file !== "string" || typeof given.text !== "string") return json(response, 400, { error: "file and text" });
      for (const listener of listeners) send(listener, "eval", { file: given.file, text: given.text });
      return json(response, 200, { listening: listeners.size, report: report.n });
    }
    return json(response, 404, { error: "no such request" });
  }

  // A request of the application to /api/: to the native server as it is.
  async function proxy(request, response) {
    const lisp = (status, text) => {
      response.writeHead(status, { "Content-Type": "application/x-emacs-lisp; charset=utf-8", "Cache-Control": "no-store" });
      response.end(text);
    };
    if (!native) return lisp(404, `"${"server.el" in current.files ? "The native server does not run" : "This application has no server.el"}"`);
    const { port, ready } = native;
    try { await ready; } catch (error) { return lisp(502, JSON.stringify(error.message)); }
    const headers = { ...request.headers, "x-forwarded-for": request.socket.remoteAddress || "127.0.0.1", "x-forwarded-proto": "http" };
    const forward = httpRequest({ host: "127.0.0.1", port, method: request.method, path: request.url, headers }, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    forward.on("error", (error) => {
      if (!response.headersSent) lisp(502, JSON.stringify(`the native server: ${error.message}`));
      else response.destroy();
    });
    request.pipe(forward);
  }

  return {
    directory,
    handle: (request, response, url) => handle(request, response, url).catch((error) => {
      if (!response.headersSent) json(response, 400, { error: String(error.message || error) });
    }),
    proxy,
    /** Start server.el in a native Emacs, for pages of 127.0.0.1:PORT. */
    useNativeServer(port) {
      if (!nativeServer) return Promise.resolve();
      studio = port;
      return startNative(null);
    },
    close() {
      stopNative();
      process.removeListener("exit", onExit);
      clearInterval(timer);
      for (const listener of listeners) listener.end();
      for (const answer of waiting) answer();
    },
  };
}
