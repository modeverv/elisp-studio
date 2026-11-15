// A project out of the studio, served by a native Emacs: the same server.el
// that ran in the browser tab answers real HTTP requests.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, pbkdf2Sync, scryptSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Agent, createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

async function startServer(directory, environment = {}) {
  const port = await freePort();
  const child = spawn(join(root, "tools/serve-project.sh"), [directory, String(port)],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...environment } });
  let log = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { log += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${origin}/`);
      break;
    } catch (error) {
      if (attempt > 100) throw new Error(`the server did not start: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  // (A server that ended by itself has no "exit" to wait for any more.)
  let exited = null;
  child.once("exit", (code, signal) => { exited = signal || code; });
  return { origin, port, log: () => log, exited: () => exited,
           stop: () => new Promise((resolve) => { if (exited !== null) resolve(); else { child.once("exit", resolve); child.kill("SIGTERM"); } }) };
}

test("server.el's headers replace the server's own: on /api/ answers, and on files by app-server-file-headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-project-headers-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets/logo.svg"), "<svg/>");
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(setq app-server-file-headers
      '(("\\\\.svg\\\\'" ("Cache-Control" . "public, max-age=60"))
        ("\\\\\`/assets/" ("Cache-Control" . "public, max-age=31536000, immutable") ("X-Frame-Options" . "DENY"))))
(defun app-server-handle (method path _body)
  (pcase (list method path)
    ('("GET" "/api/cached")
     (app-server-set-header "Cache-Control" "public, max-age=900")
     (app-server-set-header "Referrer-Policy" "no-referrer")
     "kept")
    ('("GET" "/api/plain") "plain")
    (_ (signal 'file-missing (list "No such API" path)))))
`);
  const server = await startServer(directory);
  try {
    // One of each header, server.el's where it gave one.  (fetch joins
    // two headers of one name with ", ".)
    const cached = (await fetch(`${server.origin}/api/cached`)).headers;
    assert.equal(cached.get("cache-control"), "public, max-age=900");
    assert.equal(cached.get("referrer-policy"), "no-referrer");
    assert.equal(cached.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(cached.get("x-frame-options"), "SAMEORIGIN");
    const plain = (await fetch(`${server.origin}/api/plain`)).headers;
    assert.equal(plain.get("cache-control"), "no-store");
    assert.equal(plain.get("referrer-policy"), "strict-origin-when-cross-origin");
    // Files: the matching entries, the later one winning; others as ever.
    const logo = await fetch(`${server.origin}/assets/logo.svg`);
    assert.equal(logo.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(logo.headers.get("x-frame-options"), "DENY");
    assert.ok(logo.headers.get("etag"));
    const notChanged = await fetch(`${server.origin}/assets/logo.svg`, { headers: { "If-None-Match": logo.headers.get("etag") } });
    assert.equal(notChanged.status, 304);
    assert.equal(notChanged.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const style = (await fetch(`${server.origin}/style.css`)).headers;
    assert.equal(style.get("cache-control"), "no-cache");
    assert.equal(style.get("x-frame-options"), "SAMEORIGIN");
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CORS_ORIGINS: pages of the named sites use /api/, without cookies unless CORS_CREDENTIALS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-project-cors-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/who") (list :cookie (app-server-header "cookie") :auth (app-server-header "authorization")))
    ('("POST" "/api/echo") (app-server-data body))
    (_ (signal 'file-missing (list "No such API" path)))))
`);
  const front = "https://front.example.test";
  const crossSite = { Origin: front, "Sec-Fetch-Site": "cross-site" };
  for (const credentials of [false, true]) {
    const server = await startServer(directory, { CORS_ORIGINS: `${front}/, https://other-front.example.test`,
                                                  ...(credentials ? { CORS_CREDENTIALS: "yes" } : {}) });
    try {
      // The preflight is answered by the server itself.
      const preflight = await fetch(`${server.origin}/api/echo`, { method: "OPTIONS", headers: {
        ...crossSite, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, authorization" } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), front);
      assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, PUT, PATCH, DELETE");
      assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type, authorization");
      assert.equal(preflight.headers.get("access-control-allow-credentials"), credentials ? "true" : null);
      assert.equal(preflight.headers.get("content-length"), null);
      // The request reaches server.el; the answer may be read by that page.
      const posted = await fetch(`${server.origin}/api/echo`, { method: "POST", headers: crossSite, body: '"hello"' });
      assert.deepEqual([posted.status, await posted.text()], [200, '"hello"']);
      assert.equal(posted.headers.get("access-control-allow-origin"), front);
      assert.equal(posted.headers.get("vary"), "Origin");
      // Cookies only with CORS_CREDENTIALS; a token in a header always.
      const who = await fetch(`${server.origin}/api/who`, { headers: { ...crossSite, Cookie: "session=s1", Authorization: "Bearer t1" } });
      assert.equal(await who.text(), credentials ? '(:cookie "session=s1" :auth "Bearer t1")' : '(:cookie nil :auth "Bearer t1")');
      // Another site is refused as ever, its preflight too; the server's
      // own pages get no CORS headers.
      const other = { Origin: "https://evil.example.test", "Sec-Fetch-Site": "cross-site" };
      assert.equal((await fetch(`${server.origin}/api/who`, { headers: other })).status, 403);
      assert.equal((await fetch(`${server.origin}/api/echo`, { method: "OPTIONS", headers: { ...other, "Access-Control-Request-Method": "POST" } })).status, 403);
      assert.equal((await fetch(`${server.origin}/api/who`, { headers: { Origin: server.origin } })).headers.get("access-control-allow-origin"), null);
      // The project's files are not for other sites.
      assert.equal((await fetch(`${server.origin}/`, { headers: crossSite })).headers.get("access-control-allow-origin"), null);
    } finally {
      await server.stop();
    }
  }
  await rm(directory, { recursive: true, force: true });
});

test("app-server-page-function fills index.html in for the page and the application's routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "serve-project-pages-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await writeFile(join(directory, "index.html"), `<!doctype html>
<html>
  <head>
    <title>My app</title>
    <meta name="description" content="Everything">
  </head>
  <body>
    <div id="app"><div class="boot">Loading Emacs…</div></div>
    <footer><div>after</div></footer>
  </body>
</html>
`);
  // react.el where ./fetch-emacs.sh puts it: this checkout's sibling, or
  // the published one.
  const sibling = join(root, "../elisp-react/lisp/react.el");
  await mkdir(join(directory, "vendor/elisp-react/lisp"), { recursive: true });
  await writeFile(join(directory, "vendor/elisp-react/lisp/react.el"), existsSync(sibling)
    ? await readFile(sibling, "utf8")
    : await (await fetch("https://modeverv.github.io/elisp-react/lisp/react.el")).text());
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(require 'react)
(react-define-component 'Video
  :render (lambda (self) (jsx (p (:class "video") (format "Video %s & more" (react-props self :id))))))
(setq app-server-page-function
      (lambda (path)
        (cond
         ((equal path "/")
          (list :title "Home <1>" :meta '(("description" . "The \\"home\\" page") ("og:title" . "Home"))))
         ((string-match "\\\\\`/watch/\\\\([0-9]+\\\\)\\\\'" path)
          (let ((id (match-string 1 path)))
            (list :title (format "Video %s" id)
                  :html (react-render-to-string (jsx (Video (:id id)))))))
         ((equal path "/gone") (list :status 404 :title "Not here"))
         ((equal path "/broken") (car 1)))))
(defun app-server-handle (_method path _body)
  (signal 'file-missing (list "No such API" path)))
`);
  const server = await startServer(directory);
  try {
    const page = async (path) => { const response = await fetch(`${server.origin}${path}`); return [response.status, await response.text(), response.headers]; };
    // The page itself: title replaced, the description replaced, og: added.
    const [status, home, headers] = await page("/");
    assert.equal(status, 200);
    assert.match(headers.get("content-type"), /^text\/html/);
    assert.match(home, /<title>Home &lt;1&gt;<\/title>/);
    assert.match(home, /<meta name="description" content="The &quot;home&quot; page">/);
    assert.doesNotMatch(home, /Everything/);
    assert.match(home, /<meta property="og:title" content="Home">\n\s*<\/head>/);
    assert.match(home, /<div class="boot">Loading Emacs…<\/div>/);
    // A route: index.html with the component rendered into #app, and the
    // elements after it as they were.
    const [watchStatus, watch] = await page("/watch/42");
    assert.equal(watchStatus, 200);
    assert.match(watch, /<title>Video 42<\/title>/);
    assert.match(watch, /<div id="app"><p class="video">Video 42 &amp; more<\/p><\/div>\n\s*<footer><div>after<\/div><\/footer>/);
    // Its own status; no page for other paths; files as ever.
    assert.equal((await page("/gone"))[0], 404);
    assert.match((await page("/gone"))[1], /<title>Not here<\/title>/);
    assert.equal((await page("/watch/x"))[0], 404);
    assert.equal((await page("/style.css"))[0], 200);
    assert.doesNotMatch((await page("/style.css"))[1], /<title>/);
    // A function that fails: the page as it is, and the server goes on.
    const [brokenStatus] = await page("/broken");
    assert.equal(brokenStatus, 404);
    assert.match(server.log(), /app-server-page-function at \/broken: Wrong type argument/);
    assert.match((await page("/index.html"))[1], /<title>My app<\/title>/);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the template project runs under a native Emacs: files, server.el, kept data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-project-"));
  await cp(join(root, "template"), directory, { recursive: true });
  let server = await startServer(directory);
  try {
    const text = async (path, options) => {
      const response = await fetch(`${server.origin}${path}`, options);
      return [response.status, await response.text()];
    };
    assert.deepEqual(await text("/api/messages"), [200, '("Hello from the server\'s Emacs")']);
    assert.deepEqual(await text("/api/messages", { method: "POST", body: '"  from a real request "' }),
      [200, '("Hello from the server\'s Emacs" "from a real request")']);
    assert.deepEqual(await text("/api/messages", { method: "POST", body: '""' }), [400, '"A message needs some text"']);
    assert.equal((await text("/api/messages", { method: "POST", body: "(kill-emacs)" }))[0], 400);
    assert.equal((await text("/api/nothing"))[0], 404);
    assert.equal((await text("/api/messages", { headers: { Origin: "https://example.com" } }))[0], 403);

    const [status, page] = await text("/");
    assert.equal(status, 200);
    assert.match(page, /<script type="text\/emacs-lisp" src="app\.el">/);
    assert.equal((await text("/app.el"))[1], await readFile(join(directory, "app.el"), "utf8"));
    assert.equal((await text("/server.el"))[0], 404);          // not for download
    assert.equal((await text("/.data/messages.eld"))[0], 404);  // nor the data
    // Nothing outside the project: not by "..", not by a symbolic link.
    await writeFile(join(directory, "..", "elisp-studio-outside.txt"), "outside");
    await symlink(join(directory, "..", "elisp-studio-outside.txt"), join(directory, "link.txt"));
    await symlink(join(directory, ".."), join(directory, "up"));
    await symlink(join(directory, "app.el"), join(directory, "inside.el"));
    assert.equal((await raw(server.port, "GET /../elisp-studio-outside.txt HTTP/1.0\r\n\r\n")).received.slice(9, 12), "404");
    assert.equal((await raw(server.port, "GET /%2e%2e/elisp-studio-outside.txt HTTP/1.0\r\n\r\n")).received.slice(9, 12), "404");
    assert.equal((await text("/link.txt"))[0], 404);
    assert.equal((await text("/up/elisp-studio-outside.txt"))[0], 404);
    assert.equal((await text("/inside.el"))[0], 200);
    await rm(join(directory, "..", "elisp-studio-outside.txt"));
    // A file is not a directory: its name with a slash after it names
    // nothing (it was an internal error; ZAP found it on 2026-11-15).
    for (const path of ["/app.el/", "/app.el//", "/app.el/index.html", "/style.css/", "/index.html/"]) {
      assert.equal((await text(path))[0], 404, path);
    }

    // A burst: many requests at once are all answered (Emacs's default
    // queue of five waiting connections would turn some of them away).
    const burst = await Promise.all(Array.from({ length: 100 }, () => fetch(`${server.origin}/api/messages`).then((response) => response.status)));
    assert.deepEqual([...new Set(burst)], [200]);
    // server.el runs byte-compiled.
    assert.equal(existsSync(join(directory, ".data/server.elc")), true);

    // Another server process finds what the first one kept.
    await server.stop();
    server = await startServer(directory);
    assert.deepEqual(await text("/api/messages"), [200, '("Hello from the server\'s Emacs" "from a real request")']);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a part of a file: the browser's Emacs reads its Lisp files as ranges of one large file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-range-"));
  await cp(join(root, "template"), directory, { recursive: true });
  // Larger than the pieces the server sends files in (1 MB), and not regular.
  const big = Buffer.alloc(2_500_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8) * 7) & 0xff;
  await writeFile(join(directory, "big.bin"), big);
  await writeFile(join(directory, "small.txt"), "0123456789");
  const server = await startServer(directory);
  try {
    const part = async (path, range, method = "GET") => {
      const response = await fetch(`${server.origin}${path}`, { method, headers: range ? { Range: range } : {} });
      return { status: response.status, range: response.headers.get("content-range"),
               length: response.headers.get("content-length"), body: Buffer.from(await response.arrayBuffer()) };
    };
    const first = await part("/big.bin", "bytes=0-0");
    assert.deepEqual([first.status, first.range, first.length], [206, "bytes 0-0/2500000", "1"]);
    assert.deepEqual(first.body, big.subarray(0, 1));
    // Across the server's own pieces, and to the end of the file.
    const across = await part("/big.bin", "bytes=1048000-2100099");
    assert.deepEqual([across.status, across.range], [206, "bytes 1048000-2100099/2500000"]);
    assert.equal(across.body.equals(big.subarray(1048000, 2100100)), true);
    const tail = await part("/big.bin", "bytes=2499990-");
    assert.deepEqual([tail.status, tail.range], [206, "bytes 2499990-2499999/2500000"]);
    assert.deepEqual(tail.body, big.subarray(2499990));
    const beyond = await part("/big.bin", "bytes=2499990-9999999");
    assert.deepEqual([beyond.status, beyond.range, beyond.body.length], [206, "bytes 2499990-2499999/2500000", 10]);
    const small = await part("/small.txt", "bytes=2-5");
    assert.deepEqual([small.status, small.range, small.body.toString()], [206, "bytes 2-5/10", "2345"]);
    const head = await part("/big.bin", "bytes=10-19", "HEAD");
    assert.deepEqual([head.status, head.range, head.length, head.body.length], [206, "bytes 10-19/2500000", "10", 0]);
    // No such part; and what is not one range of bytes gets the whole file.
    const none = await part("/big.bin", "bytes=2500000-2500001");
    assert.deepEqual([none.status, none.range], [416, "bytes */2500000"]);
    for (const range of ["bytes=5-2", "bytes=-5", "bytes=0-1,4-5", "lines=1-2", null]) {
      const whole = await part("/small.txt", range);
      assert.deepEqual([whole.status, whole.range, whole.body.toString()], [200, null, "0123456789"], String(range));
    }
    assert.equal((await part("/big.bin", null)).body.equals(big), true);
    // Not of what is not served at all.
    assert.equal((await part("/server.el", "bytes=0-9")).status, 404);
    // The connection is kept for the next request, as for whole files.
    const host = `Host: 127.0.0.1:${server.port}`;
    const kept = await raw(server.port, `GET /small.txt HTTP/1.1\r\n${host}\r\nRange: bytes=0-1\r\n\r\n`
      + `GET /small.txt HTTP/1.1\r\n${host}\r\nRange: bytes=8-9\r\nConnection: close\r\n\r\n`);
    assert.deepEqual(kept.received.match(/HTTP\/1\.1 206|\r\n\r\n(01|89)/g), ["HTTP/1.1 206", "\r\n\r\n01", "HTTP/1.1 206", "\r\n\r\n89"]);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a compressed copy next to a file is sent to a browser that takes gzip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-packed-"));
  await cp(join(root, "template"), directory, { recursive: true });
  // As fetch-emacs.sh leaves the browser's Emacs: NAME and NAME.gz.
  const big = Buffer.from(Array.from({ length: 60000 }, (_, i) => `line ${i} of a file that compresses well\n`).join(""));
  assert.equal(big.length > 1024 * 1024, true);
  await writeFile(join(directory, "big.pdmp"), big);
  await writeFile(join(directory, "big.pdmp.gz"), gzipSync(big));
  await writeFile(join(directory, "small.json"), '{"a":1}');
  await writeFile(join(directory, "small.json.gz"), gzipSync('{"a":1}'));
  await writeFile(join(directory, "alone.txt"), "no copy");
  const server = await startServer(directory);
  try {
    // Node's fetch takes gzip and unpacks it, like a browser; raw() shows
    // what went over the wire.
    const get = async (path, headers = {}, method = "GET") => {
      const response = await fetch(`${server.origin}${path}`, { method, headers });
      return { status: response.status, encoding: response.headers.get("content-encoding"), vary: response.headers.get("vary"),
               length: Number(response.headers.get("content-length")), tag: response.headers.get("etag"),
               type: response.headers.get("content-type"), body: Buffer.from(await response.arrayBuffer()) };
    };
    const packed = await get("/big.pdmp");
    assert.deepEqual([packed.status, packed.encoding, packed.vary, packed.type], [200, "gzip", "Accept-Encoding", "application/octet-stream"]);
    assert.equal(packed.body.equals(big), true);
    assert.equal(packed.length, gzipSync(big).length);
    assert.equal(packed.length < big.length / 5, true);
    const small = await get("/small.json");
    assert.deepEqual([small.encoding, small.type, small.body.toString()], ["gzip", "application/json", '{"a":1}']);
    const head = await get("/big.pdmp", {}, "HEAD");
    assert.deepEqual([head.status, head.encoding, head.length, head.body.length], [200, "gzip", packed.length, 0]);

    // Who does not take gzip gets the file; either way a cache is told
    // that the answer depends on that.
    for (const accept of ["identity", "br", "gzip;q=0, br"]) {
      const plain = await get("/big.pdmp", { "Accept-Encoding": accept });
      assert.deepEqual([plain.status, plain.encoding, plain.vary, plain.length], [200, null, "Accept-Encoding", big.length], accept);
      assert.equal(plain.body.equals(big), true);
      assert.notEqual(plain.tag, packed.tag);
    }
    // The two have different validators, and each is found unchanged.
    assert.equal((await get("/big.pdmp", { "If-None-Match": packed.tag })).status, 304);
    assert.equal((await get("/big.pdmp", { "If-None-Match": packed.tag, "Accept-Encoding": "identity" })).status, 200);
    // A part is a part of the file, not of the copy.
    const part = await get("/big.pdmp", { Range: "bytes=1000000-1000099" });
    assert.deepEqual([part.status, part.encoding], [206, null]);
    assert.deepEqual(part.body, big.subarray(1000000, 1000100));
    // A file without a copy is as before; the copy itself is a file like another.
    const alone = await get("/alone.txt");
    assert.deepEqual([alone.encoding, alone.vary, alone.body.toString()], [null, null, "no copy"]);
    const copy = await get("/small.json.gz", { "Accept-Encoding": "identity" });
    assert.deepEqual([copy.status, copy.encoding], [200, null]);
    assert.deepEqual(gunzipSync(copy.body).toString(), '{"a":1}');

    // A copy that is older than its file is not the file's any more.
    await writeFile(join(directory, "small.json"), '{"a":2}');
    const { utimes } = await import("node:fs/promises");
    await utimes(join(directory, "small.json.gz"), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const changed = await get("/small.json");
    assert.deepEqual([changed.encoding, changed.body.toString()], [null, '{"a":2}']);
    // A copy is a file of the project or nothing: not a link out of it,
    // not the copy of something else that happens to have the name.
    await writeFile(join(directory, "..", "elisp-studio-outside.gz"), gzipSync("outside"));
    await writeFile(join(directory, "note.txt"), "inside");
    await symlink(join(directory, "..", "elisp-studio-outside.gz"), join(directory, "note.txt.gz"));
    const linked = await get("/note.txt");
    assert.deepEqual([linked.status, linked.encoding, linked.body.toString()], [200, null, "inside"]);
    await rm(join(directory, "..", "elisp-studio-outside.gz"));
    await mkdir(join(directory, "sub"));
    await writeFile(join(directory, "sub/index.html"), "<p>the page of sub</p>");
    await writeFile(join(directory, "sub.gz"), gzipSync("not that page"));
    const index = await get("/sub");
    assert.deepEqual([index.status, index.encoding, index.body.toString()], [200, null, "<p>the page of sub</p>"]);
    // What is not served has no copy either.
    await writeFile(join(directory, "server.el.gz"), gzipSync("(secret)"));
    assert.equal((await get("/server.el")).status, 404);
    assert.equal((await get("/server.el.gz")).status, 404);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a handler can answer later, and the server goes on meanwhile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-later-"));
  await cp(join(root, "template"), directory, { recursive: true });
  // A service that takes its time, for the server to ask.
  const slow = createHttpServer((request, response) => setTimeout(() => response.end("slow answer"), 300));
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/quick") "quick")
    ('("GET" "/api/later")
     (app-server-defer (lambda (respond _fail) (app-server-after 0.3 (lambda () (funcall respond "later"))))))
    ('("GET" "/api/at-once") (app-server-defer (lambda (respond _fail) (funcall respond "at once") (funcall respond "twice"))))
    ('("GET" "/api/elsewhere")
     (app-server-defer
      (lambda (respond _fail)
        (app-server-fetch "http://127.0.0.1:${slow.address().port}/"
                          :then (lambda (response) (funcall respond (list (plist-get response :status) (plist-get response :text))))))))
    ('("GET" "/api/nowhere")
     (app-server-defer (lambda (respond _fail) (app-server-fetch "http://127.0.0.1:1/" :then respond))))
    ('("POST" "/api/program")
     (app-server-defer
      (lambda (respond _fail)
        (app-server-run '("tr" "a-z" "A-Z") :input body :then respond))))
    ('("GET" "/api/refused") (app-server-defer (lambda (_respond fail) (app-server-after 0.05 (lambda () (funcall fail "Not for you" 404))))))
    ('("GET" "/api/broken") (app-server-defer (lambda (_respond _fail) (app-server-after 0.05 (lambda () (error "Broke later"))))))
    ('("GET" "/api/broken-now") (app-server-defer (lambda (_respond _fail) (error "Broke at once"))))
    ('("GET" "/api/never") (app-server-defer #'ignore))
    ('("GET" "/api/nested") (sleep-for 0.3) "nested")
    (_ (signal 'file-missing (list "No such API" path)))))
(setq app-server-deferred-timeout 1)
`);
  const server = await startServer(directory);
  try {
    const text = async (path, options) => {
      const started = performance.now();
      const response = await fetch(`${server.origin}${path}`, options);
      return [response.status, await response.text(), performance.now() - started];
    };
    const answer = async (path, options) => (await text(path, options)).slice(0, 2);
    assert.deepEqual(await answer("/api/later"), [200, '"later"']);
    assert.deepEqual(await answer("/api/at-once"), [200, '"at once"']);
    assert.deepEqual(await answer("/api/elsewhere"), [200, '(200 "slow answer")']);
    assert.equal((await answer("/api/nowhere"))[0], 400);
    assert.deepEqual(await answer("/api/program", { method: "POST", body: "shout" }), [200, '(:status 0 :output "SHOUT")']);
    assert.deepEqual(await answer("/api/refused"), [404, '"Not for you"']);
    assert.deepEqual(await answer("/api/broken"), [400, '"Broke later"']);
    assert.deepEqual(await answer("/api/broken-now"), [400, '"Broke at once"']);
    assert.deepEqual(await answer("/api/never"), [504, '"The server did not answer in time"']);

    // Fifty requests that each wait 300 ms take about 300 ms together, and
    // a quick request among them is not held up.
    const started = performance.now();
    const [quick, ...waiting] = await Promise.all([
      new Promise((resolve) => setTimeout(resolve, 50)).then(() => text("/api/quick")),
      ...Array.from({ length: 50 }, () => text("/api/later")),
    ]);
    const elapsed = performance.now() - started;
    assert.deepEqual([...new Set(waiting.map(([status, body]) => `${status} ${body}`))], ['200 "later"']);
    assert.ok(elapsed < 1500, `fifty waits overlap (${Math.round(elapsed)} ms)`);
    assert.ok(quick[2] < 250, `a quick request is answered while the others wait (${Math.round(quick[2])} ms)`);

    // Handlers that wait inside Emacs run inside one another; beyond a
    // depth the server turns requests away instead of falling over.
    const nested = await Promise.all(Array.from({ length: 80 }, () => answer("/api/nested").catch(() => [0, ""])));
    assert.ok(nested.some(([status]) => status === 200) && nested.some(([status]) => status === 503), "200s and 503s");
    assert.deepEqual(await answer("/api/quick"), [200, '"quick"']);
  } finally {
    await server.stop();
    slow.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// What one connection gets back for the bytes it sends.  Resolves when the
// server closes the connection, or after WAIT ms (the connection stays open).
const raw = (port, chunks, wait = 400) => new Promise((resolve, reject) => {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  const timer = setTimeout(() => { socket.destroy(); resolve({ received, closed: false }); }, wait);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { received += chunk; });
  socket.on("close", () => { clearTimeout(timer); resolve({ received, closed: true }); });
  socket.on("error", reject);
  socket.on("connect", async () => {
    for (const chunk of [].concat(chunks)) {
      if (typeof chunk === "number") await new Promise((next) => setTimeout(next, chunk));
      else socket.write(chunk);
    }
  });
});

test("behind a reverse proxy: the public origin, forwarded headers, cookies, kept connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-proxy-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(defvar app-sessions (make-hash-table :test 'equal) "Session name -> visitor.")
(defun app-visitor ()
  (or (gethash (or (app-server-cookie "session") "") app-sessions)
      (app-server-refuse "Sign in first" 401)))
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("POST" "/api/login")
     (let ((name (app-server-data body)) (session (app-server-token)))
       (unless (equal name "ada") (app-server-refuse "Who are you?" 403))
       (puthash session name app-sessions)
       (app-server-set-cookie "session" session :max-age 3600)
       (app-server-set-header "X-Greeting" "hello")
       name))
    ('("GET" "/api/me") (app-visitor))
    ('("GET" "/api/me-later")
     (app-server-defer (lambda (respond _fail)
       (app-server-after 0.05 (lambda ()
         (app-server-set-header "X-Later" "yes")
         (funcall respond (list (app-visitor) (app-server-parameter "greeting"))))))))
    ('("POST" "/api/logout")
     (remhash (app-server-cookie "session") app-sessions)
     (app-server-delete-cookie "session")
     t)
    ('("GET" "/api/visitor") (list (app-server-header "x-forwarded-for") (app-server-header "X-Forwarded-Proto")))
    ('("POST" "/api/length") (length body))
    ('("POST" "/api/hash")
     (app-server-defer (lambda (respond _fail) (app-server-password-hash-later (app-server-data body) respond))))
    ('("POST" "/api/hash-scrypt")
     (app-server-defer (lambda (respond _fail)
       (let ((app-server-password-algorithm 'scrypt) (app-server-password-scrypt "ln=14,r=8,p=1"))
         (app-server-password-hash-later (app-server-data body) respond)))))
    ('("POST" "/api/check")
     (let* ((sent (app-server-data body)) (password (car sent)) (hash (cadr sent)))
       (app-server-defer (lambda (respond fail)
         (app-server-password-check-later
          password hash (lambda (right) (if right (funcall respond t) (funcall fail "Wrong password" 401))))))))
    ('("POST" "/api/split") (app-server-set-header "X-Evil" (app-server-data body)) t)
    (_ (signal 'file-missing (list "No such API" path)))))
(setq serve-project-request-timeout 1 serve-project-idle-timeout 2 serve-project-max-body 2000
      app-server-password-rounds 300000 app-server-password-jobs 2)
`);
  const server = await startServer(directory, { PUBLIC_ORIGIN: "https://app.example/" });
  // The proxy: one kept connection to the server, and the headers a proxy adds.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set();
  const proxy = createHttpServer((request, response) => {
    const upstream = httpRequest({
      host: "127.0.0.1", port: server.port, agent, method: request.method, path: request.url,
      // (As the shipped configurations do: the public name as Host, the visitor's address and scheme.)
      headers: { ...request.headers, host: "app.example", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" },
    }, (answer) => {
      sockets.add(answer.socket);
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const published = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const ask = async (path, options = {}) => {
      const response = await fetch(`${published}${path}`, options);
      return [response.status, await response.text(), response.headers];
    };
    const ours = { Origin: "https://app.example" };

    // Pages of the public origin are the application's own; others are not.
    assert.deepEqual((await ask("/api/visitor", { headers: ours })).slice(0, 2), [200, '("203.0.113.7" "https")']);
    assert.equal((await ask("/api/visitor", { headers: { Origin: "https://evil.example" } }))[0], 403);
    assert.equal((await ask("/api/login", { method: "POST", body: '"ada"', headers: { Origin: "https://evil.example" } }))[0], 403);

    // Signing in: a session cookie, safe by default, Secure because the visitor came over HTTPS.
    assert.deepEqual((await ask("/api/me", { headers: ours })).slice(0, 2), [401, '"Sign in first"']);
    assert.deepEqual((await ask("/api/login", { method: "POST", body: '"eve"', headers: ours })).slice(0, 2), [403, '"Who are you?"']);
    const [status, name, headers] = await ask("/api/login", { method: "POST", body: '"ada"', headers: ours });
    assert.deepEqual([status, name, headers.get("x-greeting")], [200, '"ada"', "hello"]);
    const cookie = headers.get("set-cookie");
    assert.match(cookie, /^session=[0-9a-f]{64}; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$/);
    const signedIn = { ...ours, Cookie: cookie.split(";")[0] };
    assert.deepEqual((await ask("/api/me", { headers: signedIn })).slice(0, 2), [200, '"ada"']);
    // A deferred answer still knows its request: cookies, parameters, headers to set.
    const later = await ask("/api/me-later?greeting=hi", { headers: signedIn });
    assert.deepEqual([later[0], later[1], later[2].get("x-later")], [200, '("ada" "hi")', "yes"]);
    const out = await ask("/api/logout", { method: "POST", headers: signedIn });
    assert.match(out[2].get("set-cookie"), /^session=; Path=\/; Max-Age=0;/);
    assert.equal((await ask("/api/me", { headers: signedIn }))[0], 401);
    // Without a proxy that says HTTPS, the cookie is not marked Secure.
    const direct = await fetch(`${server.origin}/api/login`, { method: "POST", body: '"ada"' });
    assert.doesNotMatch(direct.headers.get("set-cookie"), /Secure/);

    // Passwords: a slow hash, made in another process while this one goes on answering.
    const hashing = ask("/api/hash", { method: "POST", body: '"correct horse"', headers: ours });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const meanwhile = performance.now();
    // (Asked directly: the proxy here has one connection, which the hashing holds.)
    assert.equal((await fetch(`${server.origin}/api/visitor`)).status, 200);
    const waited = performance.now() - meanwhile;
    const [hashStatus, hashText] = await hashing;
    assert.equal(hashStatus, 200);
    assert.match(hashText, /^"pbkdf2-sha256\$300000\$[0-9a-f]{32}\$[0-9a-f]{64}"$/);
    assert.ok(waited < 300, `a request during the hashing is not held up (${Math.round(waited)} ms)`);
    const check = (password) => ask("/api/check", { method: "POST", body: `(${JSON.stringify(password)} ${hashText})`, headers: ours });
    assert.deepEqual((await check("correct horse")).slice(0, 2), [200, "t"]);
    assert.deepEqual((await check("correct horsf")).slice(0, 2), [401, '"Wrong password"']);
    assert.deepEqual((await check("correct horse")).slice(0, 2).map(String), ["200", "t"]);
    assert.equal((await ask("/api/check", { method: "POST", body: '("x" "no hash at all")', headers: ours }))[0], 401);
    // More at once than may run at once (two here): they wait their turn and all get an answer.
    const many = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      fetch(`${server.origin}/api/hash`, { method: "POST", body: JSON.stringify(`password ${index}`) }).then((response) => response.status)));
    assert.deepEqual(many, Array(7).fill(200));
    // scrypt, where the server's python3 has it; a hash says how it was made, so the same check verifies it.
    const scrypt = await ask("/api/hash-scrypt", { method: "POST", body: '"correct horse"', headers: ours });
    if (pythonHas("scrypt")) {
      assert.match(scrypt[1], /^"scrypt\$ln=14,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{64}"$/);
      const scryptCheck = (password) => ask("/api/check", { method: "POST", body: `(${JSON.stringify(password)} ${scrypt[1]})`, headers: ours });
      assert.deepEqual((await scryptCheck("correct horse")).slice(0, 2), [200, "t"]);
      assert.equal((await scryptCheck("correct horsf"))[0], 401);
    } else {
      assert.deepEqual(scrypt.slice(0, 2), [400, '"This server cannot make scrypt hashes"']);
    }
    assert.match(server.log(), /passwords are hashed by .*(python3|a second Emacs)/);

    // A header value cannot smuggle in another header.
    const split = await ask("/api/split", { method: "POST", body: JSON.stringify("a\r\nSet-Cookie: session=stolen"), headers: ours });
    assert.deepEqual([split[0], split[2].get("set-cookie")], [400, null]);

    // All of that went over one connection, which the server kept open.
    assert.equal(sockets.size, 1);

    // Files: the browser may keep them and asks whether they changed.
    const page = await ask("/app.el");
    assert.equal(page[2].get("cache-control"), "no-cache");
    assert.equal(page[2].get("x-content-type-options"), "nosniff");
    const again = await ask("/app.el", { headers: { "If-None-Match": page[2].get("etag") } });
    assert.deepEqual([again[0], again[1]], [304, ""]);
    await writeFile(join(directory, "app.el"), ";; changed\n");
    assert.deepEqual((await ask("/app.el", { headers: { "If-None-Match": page[2].get("etag") } })).slice(0, 2), [200, ";; changed\n"]);

    // What a connection may and may not send.
    const get = (path, more = "") => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n${more}\r\n`;
    const statuses = (text) => [...text.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((match) => Number(match[1]));
    // Two requests sent at once are answered in order; the connection stays open.
    const two = await raw(server.port, get("/api/visitor") + get("/api/nothing"));
    assert.deepEqual([statuses(two.received), two.closed], [[200, 404], false]);
    // HTTP/1.0, or "Connection: close": one answer, then the server closes.
    assert.equal((await raw(server.port, "GET /api/visitor HTTP/1.0\r\n\r\n")).closed, true);
    assert.equal((await raw(server.port, get("/api/visitor", "Connection: close\r\n"))).closed, true);
    // HEAD: the headers of the answer, no body.
    const head = await raw(server.port, "HEAD /app.el HTTP/1.1\r\nConnection: close\r\n\r\n");
    assert.match(head.received, /Content-Length: 11\r\n[^]*\r\n\r\n$/);
    // A sender that waits for "100 Continue" gets it, then its answer.
    const expect = await raw(server.port, ["POST /api/length HTTP/1.1\r\nContent-Length: 5\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n", 150, "12345"]);
    assert.deepEqual(statuses(expect.received), [100, 200]);
    assert.match(expect.received, /\r\n\r\n5$/);
    // Refused, and the connection closed: too large, no length, too many headers, not HTTP.
    const refused = async (data, wait) => { const answer = await raw(server.port, data, wait); return [statuses(answer.received)[0], answer.closed]; };
    assert.deepEqual(await refused("POST /api/length HTTP/1.1\r\nContent-Length: 2001\r\n\r\n" + "x".repeat(2001)), [413, true]);
    // (The server waits for the body it refused, so that the sender can read the answer; not forever.)
    assert.deepEqual(await refused("POST /api/length HTTP/1.1\r\nContent-Length: 2001\r\n\r\n", 4000), [413, true]);
    assert.deepEqual(await refused("POST /api/length HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n12345\r\n0\r\n\r\n"), [411, true]);
    assert.deepEqual(await refused(`GET / HTTP/1.1\r\nX-Long: ${"x".repeat(17000)}`), [431, true]);
    assert.deepEqual(await refused("hello\r\n\r\n"), [400, true]);
    assert.deepEqual(await refused("GET / HTTP/1.1\r\nContent-Length: many\r\n\r\n"), [400, true]);
    // Half a request is given a second (here), an idle connection two.
    assert.deepEqual(await refused("GET /api/visitor HTTP/1.1\r\nHost:", 4000), [408, true]);
    const idle = await raw(server.port, get("/api/visitor"), 6000);
    assert.deepEqual([statuses(idle.received), idle.closed], [[200], true]);
    // One line per request: method, path, status, time.
    assert.match(server.log(), /serve-project: POST \/api\/login 200 \d+ms/);
    assert.match(server.log(), /published as https:\/\/app\.example\n/);
  } finally {
    proxy.close();
    agent.destroy();
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the upload example takes large files into .data/files and sends them back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-upload-"));
  await cp(join(root, "examples/upload"), directory, { recursive: true });
  const server = await startServer(directory);
  try {
    const ask = async (path, options) => {
      const response = await fetch(`${server.origin}${path}`, options);
      return [response.status, await response.text()];
    };
    const uploads = () => readdir(join(directory, ".data/uploads")).catch(() => []);
    // 40 MB that are not text: every byte value, in an order that does not repeat soon.
    const big = Buffer.alloc(40 * 1024 * 1024);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31 + (index >> 8)) & 255;
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

    assert.deepEqual(await ask("/api/files"), [200, "(:files [])"]);
    const [status, shelf] = await ask("/api/files?name=" + encodeURIComponent("My film (final).mp4"), { method: "POST", body: big });
    assert.equal(status, 200);
    assert.match(shelf, /^\(:files \[\(:name "My_film__final_\.mp4" :size 41943040 :at "\d{4}-\d\d-\d\d \d\d:\d\d"\)\]\)$/);
    assert.equal(digest(await readFile(join(directory, ".data/files/My_film__final_.mp4"))), digest(big));
    assert.deepEqual(await uploads(), []);                       // nothing is left of the arrival
    {
      const response = await fetch(`${server.origin}/api/file?name=My_film__final_.mp4`);
      assert.equal(response.headers.get("content-length"), "41943040");
      assert.equal(response.headers.get("content-disposition"), 'attachment; filename="My_film__final_.mp4"');
      assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(big));
    }
    // The files are data of the server, not files of the site.
    assert.equal((await ask("/.data/files/My_film__final_.mp4"))[0], 404);

    // A name cannot point out of the shelf; it becomes a plain name on it.
    await ask("/api/files?name=" + encodeURIComponent("../../server.el"), { method: "POST", body: "not the server" });
    assert.equal(await readFile(join(directory, ".data/files/server.el"), "utf8"), "not the server");
    assert.match(await readFile(join(directory, "server.el"), "utf8"), /a shelf of files/);
    assert.equal((await ask("/api/files?name=...", { method: "POST", body: "x" }))[0], 400);
    assert.equal((await ask("/api/file?name=nothing"))[0], 404);

    // Only what server.el declared is taken as a file; other bodies stay text, a megabyte at most.
    assert.equal((await ask("/api/files/remove", { method: "POST", body: big.subarray(0, 2 * 1024 * 1024) }))[0], 413);
    assert.deepEqual(await ask("/api/files/remove", { method: "POST", body: '"server.el"' }),
      [200, shelf]);
    // server.el refuses before a byte of the file is taken.
    const tooLarge = await raw(server.port, "POST /api/files?name=x HTTP/1.1\r\nContent-Length: 600000000\r\n\r\nabc");
    assert.match(tooLarge.received, /^HTTP\/1\.1 413 [^]*Connection: close[^]*"That file is too large for the shelf"$/);
    // Pages of other sites cannot upload.
    assert.equal((await ask("/api/files?name=x", { method: "POST", body: big.subarray(0, 2 * 1024 * 1024), headers: { Origin: "https://evil.example" } }))[0], 413);
    assert.equal((await ask("/api/files?name=x", { method: "POST", body: "small", headers: { Origin: "https://evil.example" } }))[0], 403);

    // A visitor who leaves in the middle leaves nothing behind.
    await raw(server.port, ["POST /api/files?name=half.bin HTTP/1.1\r\nContent-Length: 5000000\r\n\r\n" + "x".repeat(100000), 200], 300);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await uploads(), []);
    assert.equal((await ask("/api/file?name=half.bin"))[0], 404);
    // A sender that waits for "100 Continue" gets it; the request after a file is answered too.
    const two = await raw(server.port, ["POST /api/files?name=small.txt HTTP/1.1\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n", 150,
                                        "12345GET /api/file?name=small.txt HTTP/1.1\r\nConnection: close\r\n\r\n"], 2000);
    assert.deepEqual([...two.received.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((match) => match[1]), ["100", "200", "200"]);
    assert.match(two.received, /\r\n\r\n12345$/);

    // While a file arrives slowly, other requests are answered.
    const slow = raw(server.port, ["POST /api/files?name=slow.bin HTTP/1.1\r\nContent-Length: 300000\r\nConnection: close\r\n\r\n",
                                   ...Array.from({ length: 6 }, () => ["x".repeat(50000), 100]).flat()], 3000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = performance.now();
    assert.equal((await ask("/api/files"))[0], 200);
    assert.ok(performance.now() - started < 200, "a request during an upload is not held up");
    assert.match((await slow).received, /slow\.bin" :size 300000/);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("signing in: sessions that last, a limit on guesses, old hashes renewed, a backup", { skip: !sqliteAvailable() && "this Emacs has no SQLite" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-signin-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await cp(join(root, "tools/project/backup.sh"), join(directory, "backup.sh"));
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(setq app-server-password-rounds 200000 app-server-attempts-max 3 app-server-attempts-seconds 2)
(defun app-hash (name) (cdr (assoc name (app-server-read "accounts"))))
(defun app-keep-hash (name hash)
  (app-server-write "accounts" (cons (cons name hash) (assoc-delete-all name (app-server-read "accounts")))))
(defun app-server-handle (method path body)
  (let* ((sent (and (not (string-empty-p body)) (app-server-data body)))
         (name (car-safe sent)) (password (car-safe (cdr-safe sent))))
    (pcase (list method path)
      ('("POST" "/api/register")
       (when (app-hash name) (app-server-refuse "That name is taken" 409))
       (app-server-defer
        (lambda (respond _fail)
          (app-server-password-hash-later
           password (lambda (hash) (app-keep-hash name hash) (funcall respond (app-server-session-start name)))))))
      ('("POST" "/api/login")
       (let ((address (app-server-visitor-address)))
         (app-server-attempts-check name address)
         (app-server-defer
          (lambda (respond fail)
            (app-server-password-check-later
             password (app-hash name)
             (lambda (right)
               (if (not right)
                   (progn (app-server-attempts-failed name address)
                          (funcall fail "Wrong name or password" 401))
                 (app-server-attempts-clear name)
                 (app-server-session-start name)
                 (if (not (app-server-password-needs-rehash-p (app-hash name)))
                     (funcall respond (list :renewed nil))
                   (app-server-password-hash-later
                    password (lambda (hash) (app-keep-hash name hash) (funcall respond (list :renewed t))))))))))))
      ('("GET" "/api/me") (or (app-server-session) (app-server-refuse "Sign in first" 401)))
      ('("POST" "/api/logout") (app-server-session-end) t)
      ('("POST" "/api/logout-everywhere") (app-server-session-end-all (app-server-session)) t)
      (_ (signal 'file-missing (list "No such API" path))))))
`);
  // (A proxy is declared, so that what it says about the visitor's address counts.)
  const environment = { WORKERS: "2", PUBLIC_ORIGIN: "https://app.example" };
  let server = await startServer(directory, environment);
  const workers = () => [server.origin, `http://127.0.0.1:${server.port + 1}`];
  const ready = async () => {
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`${workers()[1]}/`); break; } catch (error) {
        if (attempt > 100) throw new Error("the second worker did not start");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
  try {
    await ready();
    // A visitor: a cookie jar and an address (as the proxy would report it), asking either worker.
    const visitor = (address) => {
      let cookie = "", turn = 0;
      return async (path, sent) => {
        const started = performance.now();
        const response = await fetch(`${workers()[turn++ % 2]}${path}`, {
          method: sent === undefined ? "GET" : "POST", body: sent === undefined ? undefined : sent === null ? "" : `(${sent.map((part) => JSON.stringify(part)).join(" ")})`,
          headers: { ...(cookie ? { Cookie: cookie } : {}), "X-Forwarded-For": address },
        });
        const set = response.headers.get("set-cookie");
        if (set) cookie = /Max-Age=0/.test(set) ? "" : set.split(";")[0];
        return { status: response.status, text: await response.text(), ms: performance.now() - started, retry: response.headers.get("retry-after"), cookie: () => cookie };
      };
    };
    const brief = ({ status, text }) => [status, text];
    const ada = visitor("203.0.113.1");

    // A password too short to be worth hashing is refused; a good one registers and signs in.
    assert.deepEqual(brief(await ada("/api/register", ["ada", "short"])), [400, '"A password needs at least 8 characters"']);
    assert.deepEqual(brief(await ada("/api/me")), [401, '"Sign in first"']);
    assert.deepEqual(brief(await ada("/api/register", ["ada", "correct horse battery"])), [200, '"ada"']);
    assert.deepEqual(brief(await ada("/api/me")), [200, '"ada"']);          // on the other worker
    assert.deepEqual(brief(await ada("/api/register", ["ada", "another password"])), [409, '"That name is taken"']);
    // What the server keeps would not let anyone in: not the session's name, not the password.
    const token = (await ada("/api/me")).cookie().split("=")[1];
    assert.match(token, /^[0-9a-f]{64}$/);
    const kept = Buffer.concat(await Promise.all(["server.db", "server.db-wal", "accounts.eld"].map((file) => readFile(join(directory, ".data", file)).catch(() => Buffer.alloc(0))))).toString("latin1");
    assert.equal(kept.includes(token), false);
    assert.equal(kept.includes("correct horse battery"), false);
    assert.equal(kept.includes(createHash("sha256").update(token).digest("hex")), true);

    // The session outlives the server.
    await server.stop();
    server = await startServer(directory, environment);
    await ready();
    assert.deepEqual(brief(await ada("/api/me")), [200, '"ada"']);

    // Signing out; signing in on two devices; signing out everywhere.
    await ada("/api/logout", null);
    assert.equal((await ada("/api/me")).status, 401);
    const phone = visitor("203.0.113.2");
    assert.deepEqual(brief(await ada("/api/login", ["ada", "correct horse battery"])), [200, "(:renewed nil)"]);
    assert.deepEqual(brief(await phone("/api/login", ["ada", "correct horse battery"])), [200, "(:renewed nil)"]);
    assert.equal((await phone("/api/me")).status, 200);
    await ada("/api/logout-everywhere", null);
    assert.deepEqual([(await ada("/api/me")).status, (await phone("/api/me")).status], [401, 401]);
    // A session name that was never given out is nobody.
    const forged = await fetch(`${server.origin}/api/me`, { headers: { Cookie: `session=${"0".repeat(64)}` } });
    assert.equal(forged.status, 401);

    // Guessing: three failures for a name, then nobody gets in under that name for a while, right password or not.
    const mallory = visitor("198.51.100.9");
    for (const guess of ["password 1", "password 2", "password 3"]) {
      assert.deepEqual(brief(await mallory("/api/login", ["ada", guess])), [401, '"Wrong name or password"']);
    }
    const stopped = await mallory("/api/login", ["ada", "correct horse battery"]);
    assert.deepEqual([stopped.status, stopped.text], [429, '"Too many attempts. Try again in 1 minutes"']);
    assert.ok(Number(stopped.retry) >= 1 && Number(stopped.retry) <= 2, `Retry-After: ${stopped.retry}`);
    // ...and nothing more from that address, whatever the name.
    assert.equal((await mallory("/api/login", ["grace", "whatever it is"])).status, 429);
    // Another address is not held up for another name; an unknown name takes as long as a known one.
    const bob = visitor("203.0.113.3");
    const unknown = await bob("/api/login", ["nobody", "correct horse battery"]);
    assert.equal(unknown.status, 401);
    assert.ok(unknown.ms > 40, `no quick answer for a name that does not exist (${Math.round(unknown.ms)} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal((await mallory("/api/login", ["ada", "correct horse battery"])).status, 200);

    // A hash made with fewer rounds still checks, and is renewed with the password that just proved right.
    const old = `pbkdf2-sha256$1000$abcd$${pbkdf2Sync("an older password", "abcd", 1000, 32, "sha256").toString("hex")}`;
    await writeFile(join(directory, ".data/accounts.eld"), `(("grace" . "${old}"))\n`);
    assert.deepEqual(brief(await bob("/api/login", ["grace", "an older password"])), [200, "(:renewed t)"]);
    assert.match(await readFile(join(directory, ".data/accounts.eld"), "utf8"), /^\(\("grace" \. "pbkdf2-sha256\$200000\$[0-9a-f]{32}\$[0-9a-f]{64}"\)\)\n$/);
    assert.deepEqual(brief(await bob("/api/login", ["grace", "an older password"])), [200, "(:renewed nil)"]);
    // A hash that asks for more work than is reasonable is not checked at all.
    await writeFile(join(directory, ".data/accounts.eld"), `(("eve" . "pbkdf2-sha256$99999999$abcd$${"0".repeat(64)}") ("zed" . "scrypt$ln=30,r=8,p=1$abcd$${"0".repeat(64)}"))\n`);
    const heavy = await Promise.all([visitor("203.0.113.4")("/api/login", ["eve", "whatever it is"]), visitor("203.0.113.5")("/api/login", ["zed", "whatever it is"])]);
    assert.deepEqual(heavy.map(({ status }) => status), [401, 401]);
    assert.ok(heavy.every(({ ms }) => ms < 3000), "no time is spent on them");

    // A backup, taken while the server runs: the databases whole, the Lisp data, nothing served.
    const saved = execFileSync(join(directory, "backup.sh"), { encoding: "utf8" }).trim().replace(/^backup\.sh: /, "");
    assert.equal((await readFile(join(saved, "server.db"))).subarray(0, 15).toString("latin1"), "SQLite format 3");
    assert.match(await readFile(join(saved, "accounts.eld"), "utf8"), /"eve"/);
    assert.equal((await fetch(`${server.origin}/.backups/`)).status, 404);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("with a proxy that sends files, the server says which file and the proxy sends it", async () => {
  // Emacs sends one large answer at a time and waits for each visitor.
  // With PROXY_SENDS_FILES it only decides (the same checks as ever) and
  // names the file in an X-Accel-Redirect header; nginx and Caddy, with the
  // shipped configurations, send it.
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-handoff-"));
  const outside = await mkdtemp(join(tmpdir(), "elisp-studio-elsewhere-"));
  await cp(join(root, "template"), directory, { recursive: true });
  const big = Buffer.alloc(100_000, "a file of more than one write\n");
  await writeFile(join(directory, "big.bin"), big);
  await writeFile(join(directory, "a b ü.txt"), big);
  await writeFile(join(directory, "small.txt"), "small");
  await writeFile(join(directory, "long.html"), `<p>${"x".repeat(40000)}</p>`);
  await mkdir(join(directory, "sub"));
  await writeFile(join(directory, "sub/data.json"), JSON.stringify({ text: "y".repeat(40000) }));
  await mkdir(join(directory, ".data"));
  await writeFile(join(directory, ".data/kept.bin"), big);
  await writeFile(join(outside, "elsewhere.bin"), big);
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(defun app-server-handle (method path _body)
  (pcase (list method path)
    ('("GET" "/api/kept") (app-server-send-file (expand-file-name "kept.bin" app-server-data-directory) :name "kept.bin" :type "image/png"))
    ('("GET" "/api/elsewhere") (app-server-send-file ${JSON.stringify(join(outside, "elsewhere.bin"))}))
    ('("GET" "/api/members-only") (app-server-refuse "Sign in first" 401))
    (_ (signal 'file-missing (list "No such API" path)))))
`);
  const ask = async (server, path, headers = {}, method = "GET") => {
    const response = await fetch(`${server.origin}${path}`, { method, headers });
    return { status: response.status, name: response.headers.get("x-accel-redirect"), type: response.headers.get("content-type"),
             cache: response.headers.get("cache-control"), tag: response.headers.get("etag"), frames: response.headers.get("x-frame-options"),
             save: response.headers.get("content-disposition"), body: Buffer.from(await response.arrayBuffer()) };
  };
  let server = await startServer(directory, { PUBLIC_ORIGIN: "https://app.example", PROXY_SENDS_FILES: "yes" });
  try {
    // A larger file of the project: its name, and nothing of it.
    const named = await ask(server, "/big.bin");
    assert.deepEqual([named.status, named.name, named.type, named.cache, named.tag, named.body.length],
      [200, "/.files/big.bin", "application/octet-stream", "no-cache", null, 0]);
    assert.equal((await ask(server, "/a%20b%20%C3%BC.txt")).name, "/.files/a%20b%20%C3%BC.txt");
    assert.equal((await ask(server, "/sub/data.json")).name, "/.files/sub/data.json");
    // Parts, "not changed" and HEAD are the proxy's to answer.
    assert.equal((await ask(server, "/big.bin", { Range: "bytes=0-9" })).name, "/.files/big.bin");
    assert.equal((await ask(server, "/big.bin", { "If-None-Match": '"anything"' })).name, "/.files/big.bin");
    assert.equal((await ask(server, "/big.bin", {}, "HEAD")).name, "/.files/big.bin");
    // A small file is one write, and a page goes out with this server's
    // word about frames: both are sent here.
    const small = await ask(server, "/small.txt");
    assert.deepEqual([small.name, small.body.toString(), small.tag !== null], [null, "small", true]);
    const page = await ask(server, "/long.html");
    assert.deepEqual([page.name, page.frames, page.body.length], [null, "SAMEORIGIN", 40007]);
    // What is not served is not named either; the proxy's own name for
    // the files is one of those.
    for (const path of ["/server.el", "/.data/kept.bin", "/.files/big.bin", "/.files/server.el", "/big.bin/", "/missing.bin"]) {
      const refused = await ask(server, path);
      assert.deepEqual([refused.status, refused.name], [404, null], path);
    }
    // A file that server.el answers with, after server.el decided that
    // this visitor gets it.
    const kept = await ask(server, "/api/kept");
    assert.deepEqual([kept.status, kept.name, kept.type, kept.cache, kept.save, kept.body.length],
      [200, "/.files/.data/kept.bin", "image/png", "no-store", 'attachment; filename="kept.bin"', 0]);
    const refusal = await ask(server, "/api/members-only");
    assert.deepEqual([refusal.status, refusal.name], [401, null]);
    // A file outside the application's directory is not the proxy's.
    const elsewhere = await ask(server, "/api/elsewhere");
    assert.deepEqual([elsewhere.status, elsewhere.name, elsewhere.body.equals(big)], [200, null, true]);
    await server.stop();

    // Without a proxy there is nobody to send it, whatever the variable says.
    server = await startServer(directory, { PROXY_SENDS_FILES: "yes" });
    const alone = await ask(server, "/big.bin");
    assert.deepEqual([alone.name, alone.body.equals(big)], [null, true]);
    await server.stop();
    // And with a proxy that was not told to, the server sends as before.
    server = await startServer(directory, { PUBLIC_ORIGIN: "https://app.example" });
    const asBefore = await ask(server, "/big.bin");
    assert.deepEqual([asBefore.name, asBefore.body.equals(big), asBefore.tag !== null], [null, true, true]);
    assert.equal((await ask(server, "/api/kept")).body.equals(big), true);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("visitors who hang up in the middle of an answer, or do not read it, do not end or keep the server", async () => {
  // Writing to a connection that the other side has closed raises SIGPIPE,
  // which ends an Emacs in batch mode unless the script that started it
  // had the signal ignored.  One request for a file of a few megabytes and
  // a closed connection was enough (found on 2026-11-15, after ZAP).
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-hangup-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await mkdir(join(directory, "server"));
  for (const [path, source] of [["run.sh", "tools/project/run.sh"], ["server/serve-project.el", "tools/serve-project.el"],
                                ["server/app-server.el", "lisp/app-server.el"]]) {
    await cp(join(root, source), join(directory, path));
  }
  const big = Buffer.alloc(3_000_000, "a file that takes more than one write to send\n");
  await writeFile(join(directory, "big.bin"), big);
  await writeFile(join(directory, "huge.bin"), Buffer.alloc(40_000_000, "more than a connection takes without being read\n"));
  // (In earnest a visitor has thirty seconds for a piece of an answer.)
  await writeFile(join(directory, "server.el"), `${await readFile(join(directory, "server.el"), "utf8")}\n(setq serve-project-send-timeout 2)\n`);
  const waitFor = async (check, label, timeout) => {
    for (const start = Date.now(); Date.now() - start < timeout;) {
      if (await check().catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out: ${label}`);
  };
  await writeFile(join(directory, "big.bin.gz"), gzipSync(big, { level: 0 }));
  // Ask and hang up at once, without reading: by closing, and by a reset.
  const hangUp = (port, path, reset, headers = "") => new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}\r\n`, () => {
      if (reset) socket.resetAndDestroy(); else socket.destroy();
      resolve();
    }));
  });
  // The studio's own starter, and the one a downloaded project has.
  const byRunSh = async () => {
    const port = await freePort();
    const child = spawn(join(directory, "run.sh"), [String(port)], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { log += chunk; });
    let exited = null;
    child.once("exit", (code, signal) => { exited = signal || code; });
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`http://127.0.0.1:${port}/`); break; } catch (error) {
        if (attempt > 100) throw new Error("run.sh did not start a server");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { port, origin: `http://127.0.0.1:${port}`, log: () => log, exited: () => exited,
             stop: () => new Promise((resolve) => { if (exited !== null) resolve(); else { child.once("exit", resolve); child.kill("SIGTERM"); } }) };
  };
  for (const start of [() => startServer(directory), byRunSh]) {
    const server = await start();
    try {
      for (const reset of [false, true]) {
        for (const [path, headers] of [["/big.bin", ""], ["/big.bin", "Accept-Encoding: gzip\r\n"], ["/big.bin", "Range: bytes=100-2999999\r\n"],
                                       ["/app.el", ""], ["/api/messages", ""]]) {
          for (let i = 0; i < 10; i++) await hangUp(server.port, path, reset, headers);
          await Promise.all(Array.from({ length: 10 }, () => hangUp(server.port, path, reset, headers)));
        }
      }
      // Some that read a little first, then go.
      await Promise.all(Array.from({ length: 20 }, () => new Promise((resolve) => {
        const socket = connect(server.port, "127.0.0.1");
        socket.on("error", () => resolve());
        socket.on("connect", () => socket.write(`GET /big.bin HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`));
        socket.once("data", () => { socket.destroy(); resolve(); });
      })));
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(server.exited(), null, "the server ended");

      // Visitors who ask for a large file and do not read it.  Emacs sends
      // one large answer at a time, so they hold everybody up (503), but
      // not for longer than a visitor has to take a piece of an answer.
      const deaf = await Promise.all(Array.from({ length: 40 }, () => new Promise((resolve) => {
        const socket = connect(server.port, "127.0.0.1");
        socket.on("error", () => resolve(socket));
        socket.on("connect", () => {
          socket.pause();
          socket.write(`GET /huge.bin HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`, () => resolve(socket));
        });
      })));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal((await fetch(`${server.origin}/app.el`)).status, 503);
      await waitFor(async () => (await fetch(`${server.origin}/app.el`)).status === 200, "the server answers again while they are still connected", 15000);
      assert.equal(deaf.filter((socket) => !socket.destroyed).length, 40);
      for (const socket of deaf) socket.destroy();
      assert.equal(server.exited(), null, "the server ended");

      const whole = await fetch(`${server.origin}/big.bin`, { headers: { "Accept-Encoding": "identity" } });
      assert.equal(whole.status, 200);
      assert.equal(Buffer.from(await whole.arrayBuffer()).equals(big), true);
      assert.equal((await fetch(`${server.origin}/api/messages`)).status, 200);
      assert.equal(server.exited(), null, "the server ended");
      assert.doesNotMatch(server.log(), /does not ignore SIGPIPE/);
    } finally {
      await server.stop();
    }
  }
  await rm(directory, { recursive: true, force: true });
});

test("what the security check found stays fixed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-security-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await cp(join(root, "tools/project/run.sh"), join(directory, "run.sh"));
  await writeFile(join(directory, "server.el"), `;;; -*- lexical-binding: t; -*-
(setq serve-project-max-connections 20 serve-project-request-timeout 1)
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/hello") "hello")
    ('("POST" "/api/data") (app-server-data body))
    ('("GET" "/api/address") (app-server-visitor-address))
    ('("GET" "/api/missing-file") (with-temp-buffer (insert-file-contents "/nowhere/secret/place.txt") t))
    ('("GET" "/api/broken") (car 1))
    ('("GET" "/api/broken-later") (app-server-defer (lambda (_respond _fail) (app-server-after 0.01 (lambda () (car 1))))))
    ('("GET" "/api/said") (error "Said on purpose"))
    (_ (signal 'file-missing (list "No such API" path)))))
`);
  const server = await startServer(directory);
  const host = `127.0.0.1:${server.port}`;
  const request = (line, headers = "", body = "") => `${line} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n${headers}\r\n${body}`;
  const answer = async (data, wait) => {
    const { received, closed } = await raw(server.port, data, wait);
    return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] || 0), body: received.split("\r\n\r\n").slice(1).join("\r\n\r\n"), received, closed };
  };
  const status = async (data, wait) => (await answer(data, wait)).status;
  const alive = async () => (await fetch(`${server.origin}/api/hello`, { signal: AbortSignal.timeout(3000) })).status;
  try {
    // Names that Emacs would take for files on other machines (/ssh:host:/...) are names
    // like any other: nothing is connected to (a listener here would see it), nothing hangs.
    let contacted = false;
    const listener = createServer((socket) => { contacted = true; socket.destroy(); });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const started = performance.now();
    for (const path of [`//ssh:probe@127.0.0.1%23${listener.address().port}:/etc/passwd`, "//sudo::/etc/shadow", "//scp:example.invalid:/x", "/x/..//ssh:example.invalid:/x"]) {
      assert.equal(await status(request(`GET ${path}`), 5000), 404, path);
    }
    assert.ok(performance.now() - started < 2000, "answered at once");
    assert.equal(contacted, false);
    listener.close();
    // Control characters in a name: not a file, not a failure.
    assert.equal(await status(request("GET /app.el%00.html")), 404);
    assert.equal(await status(request("GET /%0d%0aX:y")), 404);
    // The scripts that run the server are not for download; the page's files are.
    assert.deepEqual([await status(request("GET /run.sh")), await status(request("GET /RUN.SH")), await status(request("GET /app.el"))], [404, 404, 200]);

    // A request under another name than this server's (a page that points its own name here): refused.
    for (const name of ["evil.example", `evil.example:${server.port}`, `127.0.0.1:${server.port}.evil.example`]) {
      assert.equal(await status(`GET /api/hello HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`), 421, name);
      assert.equal(await status(`GET /app.el HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`), 421, name);
    }
    assert.equal(await status(`GET /api/hello HTTP/1.1\r\nHost: LOCALHOST:${server.port}\r\nConnection: close\r\n\r\n`), 200);
    // A request a browser says comes from a page of another site: refused, with or without an Origin.
    assert.equal(await status(request("GET /api/hello", "Sec-Fetch-Site: cross-site\r\n")), 403);
    assert.equal(await status(request("GET /api/hello", "Sec-Fetch-Site: same-origin\r\n")), 200);
    assert.equal(await status(request("GET /api/hello", "Sec-Fetch-Site: none\r\n")), 200);

    // Requests whose end two servers could see differently: refused, connection closed.
    const framed = (headers, body = "12345") => answer(`POST /api/data HTTP/1.1\r\nHost: ${host}\r\n${headers}\r\n${body}`).then(({ status, closed }) => [status, closed]);
    assert.deepEqual(await framed("Content-Length: 5\r\nContent-Length: 0\r\n"), [400, true]);
    assert.deepEqual(await framed("Content-Length: 5\r\nContent-Length: 5\r\n"), [400, true]);
    assert.deepEqual(await framed("Content-Length : 5\r\n"), [400, true]);
    assert.deepEqual(await framed("Transfer-Encoding : chunked\r\nContent-Length: 5\r\n"), [400, true]);
    assert.deepEqual(await framed("X: y\r\n Content-Length: 5\r\n"), [400, true]);
    assert.deepEqual(await framed("X: a\0b\r\nContent-Length: 5\r\n"), [400, true]);
    assert.deepEqual(await framed("No colon here\r\nContent-Length: 5\r\n"), [400, true]);
    assert.equal(await status(`get /api/hello HTTP/1.1\r\nHost: ${host}\r\n\r\n`), 400);
    assert.deepEqual((await framed("Content-Length: 5\r\nConnection: close\r\n", '"abc"')).slice(0, 1), [200]);

    // The answers say they are not to be shown inside a page of another site.
    const page = await fetch(`${server.origin}/`);
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'; form-action 'self'; base-uri 'self'; object-src 'none'");
    assert.equal((await fetch(`${server.origin}/api/hello`)).headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(page.headers.get("referrer-policy"), "strict-origin-when-cross-origin");

    // What goes wrong inside a handler is for the log; the visitor is told what server.el says on purpose.
    assert.deepEqual([await status(request("GET /api/said")), (await answer(request("GET /api/said"))).body], [400, '"Said on purpose"']);
    assert.equal((await answer(request("GET /api/missing-file"))).body, '"Not found"');
    assert.equal((await answer(request("GET /api/broken"))).body, '"The request could not be answered"');
    assert.equal((await answer(request("GET /api/broken-later"), 1500)).body, '"The request could not be answered"');
    assert.equal((await answer(request("GET /api/nothing"))).body, '"No such API: /api/nothing"');
    assert.match(server.log(), /app-server: Opening input file: No such file or directory, \/nowhere\/secret\/place\.txt/);
    // Without a proxy, nobody can say where a visitor comes from: not the visitor either.
    assert.equal((await answer(request("GET /api/address", "X-Forwarded-For: 203.0.113.9\r\n"))).body, "nil");

    // The body as data: plain data comes through, the rest is refused, and names
    // nobody here uses do not pile up in the server's memory.
    const data = async (text) => { const response = await fetch(`${server.origin}/api/data`, { method: "POST", body: text }); return [response.status, await response.text()]; };
    assert.deepEqual(await data('("ada" 1 2.5 [t nil] (car . "x"))'), [200, '("ada" 1 2.5 [t nil] (car . "x"))']);
    assert.deepEqual(await data("(zz-never-heard-of)"), [400, '"The request names something unknown: zz-never-heard-of"']);
    assert.deepEqual(await data("#1=(car . #1#)"), [400, '"The request holds too much data"']);
    assert.deepEqual(await data("#s(hash-table data (a 1))"), [400, '"The request holds something that is not data"']);
    assert.deepEqual(await data("((("), [400, '"The request is not Lisp data"']);
    const pid = execFileSync("pgrep", ["-f", `serve-project-port ${server.port}\\)`], { encoding: "utf8" }).trim().split("\n")[0];
    const memory = () => Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" })) / 1024;
    let count = 0;
    const flood = async () => {
      for (let round = 0; round < 20; round++) {
        await data(`(${Array.from({ length: 30000 }, () => `q${(count++).toString(36)}z`).join(" ")})`);
      }
    };
    await flood();                                             // (the first bodies warm the server up)
    const before = memory();
    await flood();
    await flood();
    const grown = memory() - before;
    assert.ok(grown < 40, `1.2 million unknown names later the server is ${Math.round(grown)} MB larger`);

    // More connections than may be open: the longest idle ones go, requests are still answered;
    // a connection that never says anything is not kept.
    const silent = await Promise.all(Array.from({ length: 60 }, () => new Promise((resolve) => {
      const socket = connect(server.port, "127.0.0.1");
      socket.on("connect", () => resolve(socket));
      socket.on("error", () => resolve(socket));
    })));
    assert.equal(await alive(), 200);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    assert.equal(silent.filter((socket) => !socket.destroyed && socket.readyState === "open").length, 0);
    for (const socket of silent) socket.destroy();
    assert.equal(await alive(), 200);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

// What the python3 on PATH can hash, as app-server.el finds out.
function pythonHas(algorithm) {
  try {
    execFileSync("python3", ["-c", algorithm === "scrypt"
      ? "import hashlib; hashlib.scrypt(b'x', salt=b'y', n=2, r=1, p=1, dklen=8)"
      : "import hashlib; hashlib.pbkdf2_hmac('sha256', b'x', b'y', 1)"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

test("whoever hashes a password gets the same bytes: python3, a second Emacs, this Emacs", () => {
  const emacs = execFileSync(join(root, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
  // Ask the adapter of a native server for digests, with and without a Python.
  const digests = (python, requests) => execFileSync(emacs, ["--batch", "-Q", "-l", join(root, "lisp/app-server.el"), "--eval", `(progn
    (setq app-server-password-python ${python ? '"python3"' : "nil"})
    (dolist (request '(${requests.map(([algorithm, cost, password, salt]) => `(${JSON.stringify(algorithm)} ${JSON.stringify(cost)} ${JSON.stringify(password)} ${JSON.stringify(salt)})`).join(" ")}))
      (let ((done nil))
        (apply #'app-server--kdf-process (append request (list (lambda (digest) (setq done (list digest))))))
        (while (not done) (accept-process-output nil 0.05))
        (princ (format "%s\n" (car done))))))`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
  const password = "pässword 日本語", salt = "0123456789abcdef";
  const pbkdf2 = pbkdf2Sync(password, salt, 50000, 32, "sha256").toString("hex");
  const scrypt = scryptSync(password, salt, 32, { N: 1 << 14, r: 8, p: 1 }).toString("hex");
  const requests = [["pbkdf2-sha256", "50000", password, salt], ["scrypt", "ln=14,r=8,p=1", password, salt], ["md5", "1", password, salt]];
  // A second Emacs: PBKDF2, and nothing else.
  assert.deepEqual(digests(false, requests), [pbkdf2, "nil", "nil"]);
  if (pythonHas("pbkdf2")) {
    assert.deepEqual(digests(true, requests), [pbkdf2, pythonHas("scrypt") ? scrypt : "nil", "nil"]);
  }
});

test("the password hash is PBKDF2-HMAC-SHA-256", () => {
  const emacs = execFileSync(join(root, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
  const lisp = (form) => execFileSync(emacs, ["--batch", "-Q", "-l", join(root, "lisp/app-server.el"), "--eval", `(princ ${form})`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  // The test vectors of RFC 7914 (section 11) and the customary one for 4096 rounds.
  assert.equal(lisp('(app-server--pbkdf2 "passwd" "salt" 1)'), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
  assert.equal(lisp('(app-server--pbkdf2 "Password" "NaCl" 80000)'), "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56");
  assert.equal(lisp('(app-server--pbkdf2 "password" "salt" 4096)'), "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
  // A key longer than a block is hashed first.
  assert.equal(lisp(`(app-server--pbkdf2 (make-string 65 ?a) "salt" 1)`),
    pbkdf2Sync("a".repeat(65), "salt", 1, 32, "sha256").toString("hex"));
  assert.equal(lisp('(let ((app-server-password-rounds 1000)) (list (app-server-password-check "pässword" (app-server-password-hash "pässword")) (app-server-password-check "x" "pbkdf2-sha256$1000$00$00") (app-server-password-check "x" nil)))'),
    "(t nil nil)");
});

test("WORKERS: several Emacs processes share one project", { skip: !sqliteAvailable() && "this Emacs has no SQLite" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-workers-"));
  await cp(join(root, "examples/sqlite"), directory, { recursive: true });
  const server = await startServer(directory, { WORKERS: "2" });
  const second = `http://127.0.0.1:${server.port + 1}`;
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`${second}/`); break; } catch (error) {
        if (attempt > 100) throw new Error("the second worker did not start");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    // Both write to the same database at once; nothing is lost, nobody is turned away.
    const add = (origin, title) => fetch(`${origin}/api/books`, { method: "POST", body: JSON.stringify(title) }).then((response) => response.status);
    const statuses = await Promise.all(Array.from({ length: 200 }, (_, index) => add(index % 2 ? second : server.origin, `Book ${index}`)));
    assert.deepEqual([...new Set(statuses)], [200]);
    for (const origin of [server.origin, second]) {
      assert.match(await (await fetch(`${origin}/api/books`)).text(), /:total 200 /);
    }
    assert.equal(existsSync(join(directory, ".data/app.db-wal")), true);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
  // Stopping the script stops every worker.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(fetch(second));
});

// Does the native Emacs that the scripts find have SQLite?
function sqliteAvailable() {
  try {
    const emacs = execFileSync(join(root, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
    return execFileSync(emacs, ["--batch", "-Q", "--eval", "(princ (and (fboundp 'sqlite-available-p) (sqlite-available-p)))"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "t";
  } catch (_) {
    return false;
  }
}
const emacsHasSqlite = sqliteAvailable();

test("the SQLite example keeps its books in a database file", { skip: !emacsHasSqlite && "this Emacs has no SQLite" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-sqlite-"));
  await cp(join(root, "examples/sqlite"), directory, { recursive: true });
  let server = await startServer(directory);
  try {
    const ask = async (path, body) => {
      const response = await fetch(`${server.origin}${path}`, body === undefined ? {} : { method: "POST", body });
      return [response.status, await response.text()];
    };
    assert.match((await ask("/api/books"))[1], /^\(:books \[\] :total 0 :read 0 :sqlite "3\./);
    await ask("/api/books", '"Structure and Interpretation of Computer Programs"');
    await ask("/api/books", '"An Introduction to Programming in Emacs Lisp"');
    // What a page sends is a parameter, not SQL.
    const [, afterInjection] = await ask("/api/books", '"x\'); DROP TABLE books; --"');
    assert.match(afterInjection, /:total 3 :read 0/);
    assert.match(afterInjection, /:title "x'\); DROP TABLE books; --"/);
    assert.equal((await ask("/api/books", '"   "'))[0], 400);

    // The search is the database's: ?search= becomes WHERE title LIKE ?.
    const [, found] = await ask("/api/books?search=emacs%20lisp");
    assert.match(found, /:books \[\(:id 2 :title "An Introduction to Programming in Emacs Lisp" :done nil :added "[-0-9: ]+"\)\] :total 3/);

    assert.match((await ask("/api/books/toggle", "1"))[1], /:total 3 :read 1/);
    assert.match((await ask("/api/books/remove", "3"))[1], /:total 2 :read 1/);

    // A real SQLite file, not served, found again by another server process.
    const database = await readFile(join(directory, ".data/app.db"));
    assert.equal(database.subarray(0, 15).toString("latin1"), "SQLite format 3");
    assert.equal((await ask("/.data/app.db"))[0], 404);
    await server.stop();
    server = await startServer(directory);
    assert.match((await ask("/api/books"))[1], /:total 2 :read 1/);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a downloaded project runs itself: run.sh, and with vendor/ its own copy of the browser's Emacs", async () => {
  // The archive the studio hands out: the project and the files of RUNTIME_FILES in js/studio.js.
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-download-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await mkdir(join(directory, "server"));
  for (const [path, source] of [["run.sh", "tools/project/run.sh"], ["fetch-emacs.sh", "tools/project/fetch-emacs.sh"],
                                ["server/serve-project.el", "tools/serve-project.el"], ["server/app-server.el", "lisp/app-server.el"],
                                ["server/LICENSE", "LICENSE"]]) {
    await cp(join(root, source), join(directory, path));
  }
  await cp(join(root, "tools/project/deploy"), join(directory, "server/deploy"), { recursive: true });
  const start = async () => {
    const port = await freePort();
    const child = spawn(join(directory, "run.sh"), [String(port)], { stdio: "ignore" });
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`${origin}/`); break; } catch (error) {
        if (attempt > 100) throw new Error("run.sh did not start a server");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { origin, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); }) };
  };
  let server = await start();
  try {
    assert.equal(await (await fetch(`${server.origin}/api/messages`)).text(), '("Hello from the server\'s Emacs")');
    const page = await (await fetch(`${server.origin}/`)).text();
    assert.match(page, /https:\/\/modeverv\.github\.io\/elisp-react\/js\/elisp-react\.js/);   // the public Emacs
    assert.equal((await fetch(`${server.origin}/server/serve-project.el`)).status, 404);
    assert.equal((await fetch(`${server.origin}/server.el`)).status, 404);
    assert.equal((await fetch(`${server.origin}/server/deploy/Caddyfile`)).status, 404);
    // The licence of the two server files comes along (MIT asks for that).
    assert.match(await readFile(join(directory, "server/LICENSE"), "utf8"), /^MIT License/);
    assert.match(await readFile(join(directory, "server/app-server.el"), "utf8"), /SPDX-License-Identifier: MIT/);
    await server.stop();

    // With a copy in vendor/ (what fetch-emacs.sh makes) the page is told to use it.
    await mkdir(join(directory, "vendor/elisp-react/js"), { recursive: true });
    await mkdir(join(directory, "vendor/wasmacs/app/src"), { recursive: true });
    await writeFile(join(directory, "vendor/elisp-react/js/elisp-react.js"), "// a copy\n");
    await writeFile(join(directory, "vendor/wasmacs/app/src/emacs-eval-client.js"), "// a copy\n");
    server = await start();
    const vendored = await (await fetch(`${server.origin}/`)).text();
    assert.match(vendored, /<script type="module" src="\/vendor\/elisp-react\/js\/elisp-react\.js">/);
    assert.match(vendored, /<meta name="elisp-react:wasmacs" content="\/vendor\/wasmacs\/">/);
    assert.equal(vendored.includes("modeverv.github.io"), false);
    assert.equal(await (await fetch(`${server.origin}/vendor/wasmacs/app/src/emacs-eval-client.js`)).text(), "// a copy\n");
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fetch-emacs.sh copies Emacs with all of its Lisp, or with the core of it, and the licences", async () => {
  // Stand-ins for the two published sites, with small files.
  const site = await mkdtemp(join(tmpdir(), "elisp-studio-site-"));
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-fetch-"));
  const emacs = "wasmacs/artifacts/emacs-browser-atomics-pdump";
  const files = {
    "elisp-react/js/elisp-react.js": "// elisp-react\n", "elisp-react/lisp/react.el": ";; react\n", "elisp-react/LICENSE": "MIT License\n",
    "wasmacs/app/eval-build-id.json": '{"id":"0123abcd"}\n', "wasmacs/app/src/emacs-eval-client.js": "// client\n",
    "wasmacs/app/src/emacs-eval-worker.js": "// worker\n", "wasmacs/app/src/emacs-eval-core.js": "// core\n",
    "wasmacs/app/src/wasmacs-eval-service.el": ";; service\n",
    [`${emacs}/temacs.js`]: "// temacs\n", [`${emacs}/temacs.wasm`]: "wasm", [`${emacs}/bootstrap-emacs.pdmp`]: "pdmp",
    [`${emacs}/temacs.files.json`]: '{"files":"all"}\n',
    [`${emacs}/temacs.data.parts/manifest.json`]: JSON.stringify({ parts: [{ name: "part-000" }, { name: "part-001" }] }, null, 2),
    [`${emacs}/temacs.data.parts/part-000`]: "data", [`${emacs}/temacs.data.parts/part-001`]: "more data",
    [`${emacs}/temacs.core.files.json`]: '{"files":"core"}\n', [`${emacs}/temacs.core.data`]: "core data",
    "wasmacs/licenses/files.txt": "NOTICE.txt\nGPL-3.0-or-later.txt\n",
    "wasmacs/licenses/NOTICE.txt": "where the source is\n",
    "wasmacs/licenses/GPL-3.0-or-later.txt": "GNU GENERAL PUBLIC LICENSE\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(site, path, ".."), { recursive: true });
    await writeFile(join(site, path), content);
  }
  const web = createHttpServer(async (request, response) => {
    try { response.end(await readFile(join(site, new URL(request.url, "http://site").pathname))); }
    catch (error) { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    await cp(join(root, "tools/project/fetch-emacs.sh"), join(directory, "fetch-emacs.sh"));
    // The script downloads from a server in this process: it must not block it.
    const script = (...options) => new Promise((resolve) => {
      const child = spawn(join(directory, "fetch-emacs.sh"), options, { stdio: "ignore", env: {
        ...process.env, WASMACS_URL: `${base}/wasmacs/`, ELISP_REACT_URL: `${base}/elisp-react/` } });
      child.once("exit", resolve);
    });
    const vendor = join(directory, "vendor");
    const copied = (path) => readFile(join(vendor, path), "utf8");
    const emacsFiles = async () => (await readdir(join(vendor, emacs), { recursive: true })).sort();

    // Every file of Emacs, as the studio has it; and next to the files
    // that every visitor downloads, a compressed copy for the server.
    const whole = ["bootstrap-emacs.pdmp", "bootstrap-emacs.pdmp.gz", "temacs.data.parts", "temacs.data.parts/manifest.json",
      "temacs.data.parts/part-000", "temacs.data.parts/part-001", "temacs.files.json", "temacs.files.json.gz",
      "temacs.js", "temacs.js.gz", "temacs.wasm", "temacs.wasm.gz"];
    assert.equal(await script(), 0);
    assert.deepEqual(await emacsFiles(), whole);
    assert.equal(await copied(`${emacs}/temacs.files.json`), '{"files":"all"}\n');
    assert.equal(await copied(`${emacs}/temacs.data.parts/part-001`), "more data");
    assert.equal(await copied("wasmacs/app/eval-build-id.json"), '{"id":"0123abcd"}\n');
    assert.equal(await copied("wasmacs/app/src/emacs-eval-worker.js"), "// worker\n");
    assert.equal(gunzipSync(await readFile(join(vendor, emacs, "bootstrap-emacs.pdmp.gz"))).toString(), "pdmp");
    assert.equal(gunzipSync(await readFile(join(vendor, emacs, "temacs.files.json.gz"))).toString(), '{"files":"all"}\n');
    assert.equal(await copied("wasmacs/licenses/NOTICE.txt"), "where the source is\n");
    assert.match(await copied("wasmacs/licenses/GPL-3.0-or-later.txt"), /GNU GENERAL PUBLIC LICENSE/);
    assert.match(await copied("elisp-react/LICENSE"), /^MIT License/);

    // --core: the smaller package, whose index takes the name the page
    // asks for, and nothing left of the whole one.  A browser keeps the
    // two apart.
    const core = ["bootstrap-emacs.pdmp", "bootstrap-emacs.pdmp.gz", "temacs.core.data", "temacs.files.json", "temacs.files.json.gz",
      "temacs.js", "temacs.js.gz", "temacs.wasm", "temacs.wasm.gz"];
    assert.equal(await script("--core"), 0);
    assert.deepEqual(await emacsFiles(), core);
    assert.equal(await copied(`${emacs}/temacs.files.json`), '{"files":"core"}\n');
    assert.equal(gunzipSync(await readFile(join(vendor, emacs, "temacs.files.json.gz"))).toString(), '{"files":"core"}\n');
    assert.equal(await copied(`${emacs}/temacs.core.data`), "core data");
    assert.equal(await copied("wasmacs/app/eval-build-id.json"), '{"id":"0123abcd-core"}\n');
    // Twice changes nothing; and back to the whole (--full says the same).
    assert.equal(await script("--core"), 0);
    assert.deepEqual(await emacsFiles(), core);
    assert.equal(await copied("wasmacs/app/eval-build-id.json"), '{"id":"0123abcd-core"}\n');
    assert.equal(await script("--full"), 0);
    assert.deepEqual(await emacsFiles(), whole);
    assert.equal(await copied("wasmacs/app/eval-build-id.json"), '{"id":"0123abcd"}\n');
    assert.equal(await script("--everything"), 2);

    // A name in the list is a file of that directory or nothing.
    await writeFile(join(site, "wasmacs/licenses/files.txt"), "../../../outside.txt\n");
    assert.notEqual(await script(), 0);
    assert.equal(existsSync(join(directory, "outside.txt")), false);
  } finally {
    await new Promise((resolve) => web.close(resolve));
    await rm(site, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
