// The SQLite example, from the studio to a machine of its own.
//
//   node test/e2e-sqlite.mjs
//
// 1. In the studio (?example=sqlite): server.el keeps a reading list in an
//    SQLite database inside the server's Emacs in the browser tab; the
//    database survives a reload of the studio.
// 2. The download: the ZIP is unpacked, fetch-emacs.sh puts the browser's
//    Emacs into vendor/ (from the local server here, not the internet),
//    run.sh makes a native Emacs the web server.  With everything else
//    switched off, Chrome opens that server: the same application, its data
//    now in a real .data/app.db.
//
// Needs ../wasmacs/docs (built, with SQLite), ../elisp-react, unzip, curl,
// and a native Emacs with SQLite.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../tools/serve.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "./lib/cdp.mjs";

const pass = (message) => console.log(`PASS ${message}`);
let { server, origin } = await serve();
const workDir = await mkdtemp(join(tmpdir(), "elisp-studio-sqlite-"));
let chrome = null, client = null, native = null;
try {
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1400,800",
    "--remote-debugging-port=0", `--user-data-dir=${join(workDir, "profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  client = new CdpClient(await devToolsUrl(chrome));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  const js = (expression) => evaluate(client, sessionId, expression);
  const until = (expression, label) => waitUntil(() => js(expression).catch(() => false), label, 90_000);

  // The same actions in the studio's frame and, later, in the page itself.
  const user = (documentExpression) => {
    const page = (expression) => js(`(() => { const document = ${documentExpression}; return ${expression}; })()`);
    const pageUntil = (expression, label) => until(`(() => { const document = ${documentExpression}; return Boolean(document) && (${expression}); })()`, label);
    const type = (selector, value) => page(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    return {
      page, pageUntil, type,
      titles: () => page("[...document.querySelectorAll('.book .title')].map((node) => node.textContent)"),
      status: () => page("document.querySelector('.status')?.textContent"),
      async add(title) {
        await type(".draft", title);
        await page("(document.querySelector('form.new').requestSubmit(), true)");
        await pageUntil(`[...document.querySelectorAll('.book .title')].some((node) => node.textContent === ${JSON.stringify(title)})`, `"${title}" is in the list`);
      },
    };
  };

  // ---- 1. in the studio ---------------------------------------------------------
  const studio = user("window.document.querySelector('#preview')?.contentDocument");
  await client.send("Page.navigate", { url: `${origin}/elisp-studio/?example=sqlite` }, sessionId);
  await studio.pageUntil("/0 books, 0 read\\. SQLite 3\\.\\d+/.test(document.querySelector('.status')?.textContent || '')", "the reading list starts empty");
  pass(`in the studio the server's Emacs has SQLite: "${await studio.status()}"`);
  await studio.add("Structure and Interpretation of Computer Programs");
  await studio.add("An Introduction to Programming in Emacs Lisp");
  await studio.add("The Art of the Metaobject Protocol");
  assert.deepEqual(await studio.titles(), ["The Art of the Metaobject Protocol", "An Introduction to Programming in Emacs Lisp", "Structure and Interpretation of Computer Programs"]);
  await studio.type(".search", "emacs");
  await studio.pageUntil("document.querySelectorAll('.book').length === 1", "the database answers the search");
  assert.deepEqual(await studio.titles(), ["An Introduction to Programming in Emacs Lisp"]);
  await studio.type(".search", "");
  await studio.pageUntil("document.querySelectorAll('.book').length === 3", "the whole list again");
  await studio.page("(document.querySelectorAll('.toggle')[2].click(), true)");
  await studio.pageUntil("/3 books, 1 read/.test(document.querySelector('.status').textContent)", "a book is marked as read");
  pass("server.el inserts, searches and updates with SQL in the browser tab");

  await client.send("Page.navigate", { url: `${origin}/elisp-studio/` }, sessionId);
  await studio.pageUntil("/3 books, 1 read/.test(document.querySelector('.status')?.textContent || '')", "the database is there after a reload");
  pass("the database survives a reload of the studio (IndexedDB)");

  // ---- 2. the download ----------------------------------------------------------
  const zip = Buffer.from(await js(`window.elispStudio.zip().then((bytes) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  })`), "base64");
  const project = join(workDir, "project");
  await writeFile(join(workDir, "project.zip"), zip);
  execFileSync("unzip", ["-q", join(workDir, "project.zip"), "-d", project]);
  for (const name of ["run.sh", "fetch-emacs.sh", "server.el", "app.el", "server/serve-project.el", "README.txt"]) {
    assert.equal(existsSync(join(project, name)), true, `${name} is in the archive`);
  }
  // Not execFileSync: the server it downloads from lives in this process.
  await new Promise((resolve, reject) => {
    const fetching = spawn(join(project, "fetch-emacs.sh"), [], {
      env: { ...process.env, WASMACS_URL: `${origin}/wasmacs/`, ELISP_REACT_URL: `${origin}/elisp-react/` }, stdio: "ignore",
    });
    fetching.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`fetch-emacs.sh exited with ${code}`))));
  });
  const vendoredEmacs = join(project, "vendor/wasmacs/artifacts/emacs-browser-atomics-pdump");
  assert.equal(existsSync(join(vendoredEmacs, "temacs.wasm")), true);
  // The core package: Emacs Lisp and its library, not the 146 MB of the editor.
  assert.equal(existsSync(join(vendoredEmacs, "temacs.core.data")), true);
  assert.equal(existsSync(join(vendoredEmacs, "temacs.data.parts")), false);
  const vendorBytes = (await readdir(join(project, "vendor"), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).reduce((sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size, 0);
  assert.equal(vendorBytes < 50e6, true, `vendor/ has ${vendorBytes} bytes`);
  pass(`the ZIP unpacks to a project with run.sh; fetch-emacs.sh brought the browser's Emacs into vendor/ (${(vendorBytes / 1e6).toFixed(1)} MB)`);

  // Nothing but the project's own server from here on.
  server.close();
  server = null;
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  native = spawn(join(project, "run.sh"), [String(port)], { stdio: "ignore" });
  const nativeOrigin = `http://127.0.0.1:${port}`;
  await waitUntil(() => fetch(`${nativeOrigin}/`).then((response) => response.ok, () => false), "run.sh serves", 20_000);

  const standalone = user("window.document");
  await client.send("Page.navigate", { url: `${nativeOrigin}/` }, sessionId);
  await standalone.pageUntil("/0 books, 0 read\\. SQLite 3\\.\\d+/.test(document.querySelector('.status')?.textContent || '')", "the application runs on its own");
  await standalone.add("Gödel, Escher, Bach");
  await standalone.add("The Little Schemer");
  await standalone.page("(document.querySelectorAll('.toggle')[0].click(), true)");
  await standalone.pageUntil("/2 books, 1 read/.test(document.querySelector('.status').textContent)", "the native server updates");
  const resources = await js("performance.getEntriesByType('resource').map((entry) => new URL(entry.name).origin).filter((value, index, all) => all.indexOf(value) === index)");
  assert.deepEqual(resources, [nativeOrigin]);
  // The page's Emacs reads its Lisp files one by one from the project's
  // server, which sends the parts of the package it asks for.
  assert.equal(await js("window.elispReact.files"), "on demand");
  const database = await readFile(join(project, ".data/app.db"));
  assert.equal(database.subarray(0, 15).toString("latin1"), "SQLite format 3");
  pass(`unpacked and started with run.sh, the application runs with nothing else: "${await standalone.status()}", data in .data/app.db (${database.length} bytes)`);
  console.log("sqlite e2e passed");
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  native?.kill("SIGTERM");
  server?.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
