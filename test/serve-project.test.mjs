// A project out of the studio, served by a native Emacs: the same server.el
// that ran in the browser tab answers real HTTP requests.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Another server process finds what the first one kept.
    await server.stop();
    server = await startServer(directory);
    assert.deepEqual(await text("/api/messages"), [200, '("Hello from the server\'s Emacs" "from a real request")']);
  } finally {
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
