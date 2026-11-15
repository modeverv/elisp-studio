// The studio on one's own machine: a project in a directory (the server's
// side of it), sibling sites without a checkout, and the window's start.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as createRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readProject } from "../tools/local-project.mjs";
import { serve } from "../tools/serve.mjs";
import { chromeArguments, excludeFromGit, findChrome, newProject } from "../tools/studio.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The events of a server-sent stream, as they come: next() waits for one.
async function listen(url, headers = {}) {
  const response = await fetch(url, { headers });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    status: response.status,
    async next() {
      for (;;) {
        const end = text.indexOf("\n\n");
        if (end >= 0) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          return { event: /^event: (.*)$/m.exec(block)[1], data: JSON.parse(/^data: (.*)$/m.exec(block)[1]) };
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("the stream ended");
        text += decoder.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

test("a project in a directory: its text files, without what editors and tools leave", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-local-"));
  try {
    await cp(join(root, "template"), directory, { recursive: true });
    await mkdir(join(directory, "parts"));
    await writeFile(join(directory, "parts/list.el"), "(list)");
    for (const [name, text] of [["app.el~", "backup"], ["#app.el#", "auto-save"], [".#app.el", "lock"], ["app.elc", "compiled"],
                                [".elisp-studio.json", "{}"], ["photo.png", "not text"], ["run.sh", "#!/bin/sh"]]) {
      await writeFile(join(directory, name), text);
    }
    // A library of the project's own, in vendor/ beside what the tools put there.
    await mkdir(join(directory, "vendor/dash"), { recursive: true });
    await writeFile(join(directory, "vendor/dash/dash.el"), "(provide 'dash)");
    for (const name of ["vendor/wasmacs", "vendor/elisp-react", "server", ".data", ".git", "node_modules/x"]) {
      await mkdir(join(directory, name), { recursive: true });
      await writeFile(join(directory, name, "inside.el"), "(not the project)");
    }
    await writeFile(join(directory, "huge.json"), "x".repeat(1024 * 1024 + 1));
    const { files } = readProject(directory);
    assert.deepEqual(Object.keys(files).sort(), ["app.el", "index.html", "parts/list.el", "server.el", "style.css", "test/app-test.el", "vendor/dash/dash.el"]);
    assert.equal(files["app.el"], await readFile(join(directory, "app.el"), "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the server tells the page about the directory and passes on what an editor and the page say", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-local-"));
  await cp(join(root, "template"), directory, { recursive: true });
  const { server, origin } = await serve({ project: directory });
  try {
    const page = await listen(`${origin}/__project/events`);
    const first = await page.next();
    assert.equal(first.event, "files");
    assert.equal(first.data.directory, directory);
    assert.deepEqual(Object.keys(first.data.files).sort(), ["app.el", "index.html", "server.el", "style.css", "test/app-test.el"]);

    // A save, by whatever saves: the page gets the files as they are now.
    await writeFile(join(directory, "style.css"), "body { color: red }");
    const changed = await page.next();
    assert.equal(changed.event, "files");
    assert.equal(changed.data.files["style.css"], "body { color: red }");
    // What an editor leaves next to the file is no change.
    await writeFile(join(directory, "style.css~"), "backup");
    await writeFile(join(directory, ".#style.css"), "lock");
    await writeFile(join(directory, "new.el"), "(new)");
    assert.deepEqual(Object.keys((await page.next()).data.files).sort(), ["app.el", "index.html", "new.el", "server.el", "style.css", "test/app-test.el"]);

    // The page says what happened; an editor that asked before gets it.
    const state = await (await fetch(`${origin}/__project/state`)).json();
    assert.deepEqual(state, { directory, report: 0, listening: 1 });
    assert.deepEqual(await (await fetch(`${origin}/__project/report?after=0`)).json(), { n: 0 });   // nothing yet, not waiting
    const waiting = fetch(`${origin}/__project/report?after=0&wait=10`).then((response) => response.json());
    await pause(100);
    await fetch(`${origin}/__project/report`, { method: "POST", body: JSON.stringify({ status: "ok", summary: "app.el updated", log: "" }) });
    assert.deepEqual(await waiting, { n: 1, status: "ok", summary: "app.el updated", log: "" });
    assert.deepEqual(await (await fetch(`${origin}/__project/report?after=0`)).json(), { n: 1, status: "ok", summary: "app.el updated", log: "" });
    const t0 = Date.now();
    assert.deepEqual(await (await fetch(`${origin}/__project/report?after=1&wait=1`)).json(), { n: 1 });   // waited, nothing came
    assert.equal(Date.now() - t0 >= 900, true);

    // An editor has a definition evaluated: the page is told.
    const evaluated = await (await fetch(`${origin}/__project/eval`, { method: "POST", body: JSON.stringify({ file: "app.el", text: "(defun f ())" }) })).json();
    assert.deepEqual(evaluated, { listening: 1, report: 1 });
    assert.deepEqual(await page.next(), { event: "eval", data: { file: "app.el", text: "(defun f ())" } });
    assert.equal((await fetch(`${origin}/__project/eval`, { method: "POST", body: "not json" })).status, 400);

    // Not for pages of other sites, and not under another name (a page
    // elsewhere that points its domain at this machine).
    for (const headers of [{ Origin: "https://example.com" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "null" }]) {
      assert.equal((await fetch(`${origin}/__project/state`, { headers })).status, 403, JSON.stringify(headers));
      assert.equal((await fetch(`${origin}/__project/eval`, { method: "POST", headers, body: JSON.stringify({ file: "app.el", text: "(kill-emacs)" }) })).status, 403);
    }
    const port = new URL(origin).port;
    const other = await new Promise((resolve) => {
      const request = createRequest({ host: "127.0.0.1", port, path: "/__project/events", headers: { Host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.end();
    });
    assert.equal(other, 403);
    assert.equal((await fetch(`${origin}/__project/state`, { headers: { Origin: origin } })).status, 200);   // the studio's own page
    page.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
  // Without a project there is nothing to ask.
  const plain = await serve();
  try {
    assert.equal((await fetch(`${plain.origin}/__project/state`)).status, 404);
  } finally {
    await new Promise((resolve) => plain.server.close(resolve));
  }
});

// A server.el that shares a library with the page.
const sharedLibrary = (word) => `;;; -*- lexical-binding: t; -*-\n(defun shared-greeting () ${JSON.stringify(word)})\n(provide 'shared)\n`;
const serverWithLibrary = `;;; -*- lexical-binding: t; -*-
(require 'shared)
(defun app-server-handle (method path _body)
  (pcase (list method path)
    ('("GET" "/api/greeting") (app-server-set-cookie "seen" "yes") (shared-greeting))
    ('("GET" "/api/seen") (app-server-cookie "seen"))
    (_ (signal 'file-missing (list "No such API" path)))))
`;

test("--native-server: server.el runs in a native Emacs behind the studio, and starts again when a file it loaded changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-native-"));
  await cp(join(root, "template"), directory, { recursive: true });
  await writeFile(join(directory, "shared.el"), sharedLibrary("one"));
  await writeFile(join(directory, "server.el"), serverWithLibrary);
  const { server, origin } = await serve({ project: directory, nativeServer: true });
  let port = null;
  try {
    const page = await listen(`${origin}/__project/events`);
    assert.equal((await page.next()).data.server, "native");
    let news = await page.next();
    assert.equal(news.event, "server");
    assert.equal(news.data.status, "ok");
    port = Number(/127\.0\.0\.1:(\d+)/.exec(news.data.summary)[1]);
    // The page's own requests, as the browser makes them: cookies pass.
    const response = await fetch(`${origin}/api/greeting`, { headers: { Origin: origin } });
    assert.equal(await response.text(), '"one"');
    const cookie = response.headers.get("set-cookie").split(";")[0];
    assert.equal(await (await fetch(`${origin}/api/seen`, { headers: { Cookie: cookie } })).text(), '"yes"');
    // A page of another site is refused by the native server, as on a server.
    assert.equal((await fetch(`${origin}/api/greeting`, { headers: { Origin: "https://example.com" } })).status, 403);

    // A file that server.el loaded changed: a new start, the new text.
    await writeFile(join(directory, "shared.el"), sharedLibrary("two"));
    assert.equal((await page.next()).event, "files");
    news = await page.next();
    assert.match(news.data.summary, /shared\.el changed: server\.el started again in a native Emacs/);
    assert.equal(await (await fetch(`${origin}/api/greeting`)).text(), '"two"');
    port = Number(/127\.0\.0\.1:(\d+)/.exec(news.data.summary)[1]);
    // A file that it did not load: the same server goes on.
    await writeFile(join(directory, "style.css"), "body {}");
    assert.equal((await page.next()).event, "files");
    await pause(500);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/api/greeting`)).text(), '"two"');
    page.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
  // The native Emacs ends with the studio.
  let gone = false;
  for (let tries = 0; tries < 50 && !gone; tries += 1) {
    gone = await fetch(`http://127.0.0.1:${port}/`).then(() => false, () => true);
    if (!gone) await pause(100);
  }
  assert.equal(gone, true);
});

test("a new project gets the template and what keeps and checks it; a repository keeps the studio's files out of git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-new-"));
  try {
    const app = join(directory, "app");
    newProject(app);
    for (const name of ["index.html", "app.el", "style.css", "server.el", "test/app-test.el", ".gitignore", "test/run.sh", ".github/workflows/test.yml"]) {
      assert.equal(existsSync(join(app, name)), true, name);
    }
    assert.notEqual(statSync(join(app, "test/run.sh")).mode & 0o111, 0);
    assert.match(await readFile(join(app, ".gitignore"), "utf8"), /^\.data\/$/m);
    // Over no file that is there.
    await writeFile(join(app, ".gitignore"), "mine\n");
    newProject(app);
    assert.equal(await readFile(join(app, ".gitignore"), "utf8"), "mine\n");

    // An existing repository: what the studio writes is excluded, once.
    const repository = join(directory, "repository");
    await mkdir(repository);
    execFileSync("git", ["init", "-q", repository]);
    excludeFromGit(repository, [".elisp-studio.json"]);
    excludeFromGit(repository, [".elisp-studio.json", ".data/"]);
    const exclude = await readFile(join(repository, ".git/info/exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((line) => line === ".elisp-studio.json").length, 1);
    assert.equal(exclude.split("\n").filter((line) => line === ".data/").length, 1);
    await writeFile(join(repository, ".elisp-studio.json"), "{}");
    await mkdir(join(repository, ".data"));
    await writeFile(join(repository, ".data/app.db"), "secret");
    await writeFile(join(repository, "app.el"), "(list)");
    assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repository, encoding: "utf8" }), "?? app.el\n");
    // Not a repository: nothing is made.
    excludeFromGit(app, [".elisp-studio.json"]);
    assert.equal(existsSync(join(app, ".git")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sibling site without a checkout comes from where it is published, once", async () => {
  const site = await mkdtemp(join(tmpdir(), "elisp-studio-published-"));
  const cache = await mkdtemp(join(tmpdir(), "elisp-studio-cache-"));
  await mkdir(join(site, "elisp-react/js"), { recursive: true });
  await writeFile(join(site, "elisp-react/js/elisp-react.js"), "// the published host\n");
  await writeFile(join(site, "elisp-react/index.html"), "<p>elisp-react</p>");
  let asked = 0;
  const web = createServer(async (request, response) => {
    asked += 1;
    try { response.end(await readFile(join(site, new URL(request.url, "http://site").pathname))); }
    catch (error) { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  // (The mounts are read when the module is; a server of its own, then.)
  const script = `
    import { serve } from ${JSON.stringify(join(root, "tools/serve.mjs"))};
    const { origin } = await serve({ sites: process.env.SITES, cache: process.env.CACHE });
    console.log(origin);`;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ELISP_REACT: join(site, "no-such-checkout"), SITES: `http://127.0.0.1:${web.address().port}/`, CACHE: cache },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const origin = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
    const get = async (path, headers = {}) => {
      const response = await fetch(`${origin}${path}`, { headers });
      return [response.status, await response.text()];
    };
    assert.deepEqual(await get("/elisp-react/js/elisp-react.js"), [200, "// the published host\n"]);
    assert.equal(await readFile(join(cache, "elisp-react/js/elisp-react.js"), "utf8"), "// the published host\n");
    assert.deepEqual(await get("/elisp-react/"), [200, "<p>elisp-react</p>"]);
    assert.deepEqual(await get("/elisp-react/js/missing.js"), [404, "not found"]);
    assert.deepEqual(await get("/elisp-react/../../outside"), [404, "not found"]);
    // From the cache now: the published site is not asked again, and may be away.
    const before = asked;
    assert.deepEqual(await get("/elisp-react/js/elisp-react.js"), [200, "// the published host\n"]);
    assert.deepEqual(await get("/elisp-react/js/elisp-react.js", { Range: "bytes=3-5" }), [206, "the"]);
    assert.equal(asked, before);
    await new Promise((resolve) => web.close(resolve));
    assert.deepEqual(await get("/elisp-react/js/elisp-react.js"), [200, "// the published host\n"]);
    // This repository's own files never come from elsewhere.
    assert.equal((await get("/elisp-studio/js/studio.js"))[0], 200);
    assert.equal(existsSync(join(cache, "elisp-studio")), false);
  } finally {
    child.kill();
    if (web.listening) await new Promise((resolve) => web.close(resolve));
    await rm(site, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test("the window: an application window of Chrome with a profile of its own", async () => {
  assert.equal(findChrome({ CHROME_PATH: "/opt/my/chrome" }, (path) => path === "/opt/my/chrome"), "/opt/my/chrome");
  assert.equal(findChrome({}, (path) => path === "/usr/bin/chromium"), "/usr/bin/chromium");
  assert.equal(findChrome({}, () => false), null);
  assert.deepEqual(chromeArguments("http://127.0.0.1:5190/elisp-studio/", "/p").slice(0, 2), ["--app=http://127.0.0.1:5190/elisp-studio/", "--user-data-dir=/p"]);
  assert.equal(chromeArguments("http://x/", "/p", { kiosk: true })[0], "--kiosk");

  // What tools/studio.mjs would start, for a directory that is not a project yet.
  const directory = join(await mkdtemp(join(tmpdir(), "elisp-studio-new-")), "my-app");
  try {
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [join(root, "tools/studio.mjs"), ...args, "--print"], { encoding: "utf8" }).replace(/^[^{]*/, ""));
    const local = run(directory, "--port", "5222", "--kiosk");
    assert.equal(local.page, "http://localhost:5222/elisp-studio/?project=local");
    assert.equal(local.project, directory);
    assert.equal(local.arguments.includes("--kiosk"), true);
    // It got the template's files, and keeps what it has the next time.
    assert.equal(await readFile(join(directory, "app.el"), "utf8"), await readFile(join(root, "template/app.el"), "utf8"));
    await writeFile(join(directory, "app.el"), ";; mine");
    run(directory);
    assert.equal(await readFile(join(directory, "app.el"), "utf8"), ";; mine");
    const web = run();
    assert.deepEqual([web.page, web.project], ["http://127.0.0.1:5190/elisp-studio/", null]);
  } finally {
    await rm(join(directory, ".."), { recursive: true, force: true });
  }
});
