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
//
// lisp/elisp-studio-local.el is the Emacs side of the last three.
//
// These requests show and change what is in the directory's application,
// so they are for this machine's own programs: a request under another name
// than this server's (a page elsewhere that points its domain here) or from
// a page of another site is refused.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const TEXT = /\.(?:html|el|css|js|mjs|json|txt|md|svg|eld)$/i;
// What a downloaded project carries besides itself, and what tools leave.
const NOT_THE_PROJECT = new Set(["vendor", "server", "node_modules"]);
const LARGEST = 1024 * 1024;
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
        if (!relative && NOT_THE_PROJECT.has(name)) continue;
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

/**
 * Serve the project in DIRECTORY.  Returns { handle(request, response, url),
 * close() }; handle answers a request to /__project/... .
 */
export function localProject(directory) {
  directory = resolve(directory);
  const listeners = new Set();            // the pages that listen
  let current = readProject(directory);
  let seen = current.stamp;               // what the last look found
  let report = { n: 0 };
  let waiting = [];                       // editors that wait for the next report

  const send = (response, event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const filesEvent = () => ({ directory, files: current.files });
  // A file is told of when it has stopped changing: an editor may be in
  // the middle of writing it.
  const timer = setInterval(() => {
    let next;
    try { next = readProject(directory); } catch (_) { return; }   // a file went away while it was read
    if (next.stamp !== seen) { seen = next.stamp; return; }
    if (next.stamp === current.stamp) return;
    current = next;
    for (const listener of listeners) send(listener, "files", filesEvent());
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
    if (what === "POST /__project/eval") {
      const given = await body(request);
      if (typeof given.file !== "string" || typeof given.text !== "string") return json(response, 400, { error: "file and text" });
      for (const listener of listeners) send(listener, "eval", { file: given.file, text: given.text });
      return json(response, 200, { listening: listeners.size, report: report.n });
    }
    return json(response, 404, { error: "no such request" });
  }

  return {
    directory,
    handle: (request, response, url) => handle(request, response, url).catch((error) => {
      if (!response.headersSent) json(response, 400, { error: String(error.message || error) });
    }),
    close() {
      clearInterval(timer);
      for (const listener of listeners) listener.end();
      for (const answer of waiting) answer();
    },
  };
}
