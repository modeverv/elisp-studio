// A project out of the studio, served by a native Emacs: the same server.el
// that ran in the browser tab answers real HTTP requests.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
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

async function startServer(directory) {
  const port = await freePort();
  const child = spawn(join(root, "tools/serve-project.sh"), [directory, String(port)], { stdio: ["ignore", "ignore", "pipe"] });
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
  return { origin, stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); }) };
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
