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
    ('("POST" "/api/hash")
     (app-server-defer (lambda (respond _fail) (app-server-password-hash-later (car (read-from-string body)) respond))))
    ('("POST" "/api/hash-scrypt")
     (app-server-defer (lambda (respond _fail)
       (let ((app-server-password-algorithm 'scrypt) (app-server-password-scrypt "ln=14,r=8,p=1"))
         (app-server-password-hash-later (car (read-from-string body)) respond)))))
    ('("POST" "/api/check")
     (let* ((sent (car (read-from-string body))) (password (car sent)) (hash (cadr sent)))
       (app-server-defer (lambda (respond fail)
         (app-server-password-check-later
          password hash (lambda (right) (if right (funcall respond t) (funcall fail "Wrong password" 401))))))))
    ('("POST" "/api/split") (app-server-set-header "X-Evil" (car (read-from-string body))) t)
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
