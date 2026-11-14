// A project out of the studio, served by a native Emacs: the same server.el
// that ran in the browser tab answers real HTTP requests.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { Agent, createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  return { origin, port, log: () => log, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); }) };
}

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
     (let ((name (car (read-from-string body))) (session (app-server-token)))
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
    ('("POST" "/api/split") (app-server-set-header "X-Evil" (car (read-from-string body))) t)
    (_ (signal 'file-missing (list "No such API" path)))))
(setq serve-project-request-timeout 1 serve-project-idle-timeout 2 serve-project-max-body 2000)
`);
  const server = await startServer(directory, { PUBLIC_ORIGIN: "https://app.example/" });
  // The proxy: one kept connection to the server, and the headers a proxy adds.
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = new Set();
  const proxy = createHttpServer((request, response) => {
    const upstream = httpRequest({
      host: "127.0.0.1", port: server.port, agent, method: request.method, path: request.url,
      headers: { ...request.headers, "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" },
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
    const get = (path, more = "") => `GET ${path} HTTP/1.1\r\nHost: x\r\n${more}\r\n`;
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
    assert.deepEqual(await refused("POST /api/length HTTP/1.1\r\nContent-Length: 2001\r\n\r\n"), [413, true]);
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

// Does the native Emacs that the scripts find have SQLite?
const emacsHasSqlite = (() => {
  try {
    const emacs = execFileSync(join(root, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
    return execFileSync(emacs, ["--batch", "-Q", "--eval", "(princ (and (fboundp 'sqlite-available-p) (sqlite-available-p)))"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "t";
  } catch (_) {
    return false;
  }
})();

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
                                ["server/serve-project.el", "tools/serve-project.el"], ["server/app-server.el", "lisp/app-server.el"]]) {
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
