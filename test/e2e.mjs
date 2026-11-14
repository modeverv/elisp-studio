// The studio in real Chrome: Emacs on the left edits the project, the
// application on the right follows without a reload and keeps its state.
//
//   node test/e2e.mjs            with isolation headers from the server
//   node test/e2e.mjs --plain    as on GitHub Pages: service workers add them
//   E2E_SITE=https://modeverv.github.io node test/e2e.mjs    a deployed copy
//
// Needs ../wasmacs/docs (a built wasmacs) and ../elisp-react next to this
// repository, unless E2E_SITE is given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../tools/serve.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "./lib/cdp.mjs";

const plain = process.argv.includes("--plain");
const pass = (message) => console.log(`PASS ${message}`);
let server = null;
let origin = (process.env.E2E_SITE || "").replace(/\/$/, "");
if (!origin) ({ server, origin } = await serve({ plain }));
const slow = Boolean(process.env.E2E_SITE);

const workDir = await mkdtemp(join(tmpdir(), "elisp-studio-"));
let chrome = null, client = null;
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
  const until = (expression, label, ms = slow ? 300_000 : 60_000) => waitUntil(() => js(expression).catch(() => false), label, ms);
  // Inside the application's frame.
  const app = (expression) => js(`(() => { const document = window.document.querySelector('#preview').contentDocument; return ${expression}; })()`);
  const appUntil = (expression, label) => until(`(() => { const frame = window.document.querySelector('#preview'); if (!frame?.contentDocument) return false; const document = frame.contentDocument; return ${expression}; })()`, label);
  const status = () => js("document.querySelector('#status').textContent");
  // Type into Emacs: M-: FORM RET.
  const emacsEval = (form) => js(`(() => {
    const bytes = [...new TextEncoder().encode("\\u001b:" + ${JSON.stringify(form.replace(/\n\s*/g, " "))} + "\\r")];
    window.document.querySelector('#editor').contentWindow.__wasmacsDebugSendInputBytes(bytes);
    return true;
  })()`);
  const editFile = (file, from, to) => emacsEval(`(with-current-buffer (find-file-noselect "/home/user/elisp-studio/app/${file}")
    (goto-char (point-min))
    (unless (search-forward ${JSON.stringify(from)} nil t) (error "not found"))
    (replace-match ${JSON.stringify(to)} t t)
    (save-buffer))`);

  const t0 = Date.now();
  await client.send("Page.navigate", { url: `${origin}/elisp-studio/` }, sessionId);
  await until("window.crossOriginIsolated === true && Boolean(window.elispStudio)", "the studio is cross-origin isolated");
  await appUntil("document.querySelector('.count')?.textContent === 'Count: 0'", "the template application renders");
  assert.match(await status(), /the application runs/);
  const editorScreen = await js("document.querySelector('#editor').contentWindow.__wasmacsDebugScreenText()");
  assert.match(editorScreen, /app\.el/);
  assert.match(editorScreen, /react-define-component 'Counter/);
  pass(`Emacs shows app.el and the application runs next to it (${Date.now() - t0} ms${plain ? ", isolation from service workers" : ""})`);

  // Give the application some state, and tag its nodes.
  await app("(document.querySelector('.increment').click(), document.querySelector('.increment').click(), document.querySelector('.increment').click(), true)");
  await appUntil("document.querySelector('.count').textContent === 'Count: 3'", "three clicks");
  await app("(document.querySelectorAll('#app *').forEach((node) => { node.dataset.before = '1'; }), true)");
  const frameBefore = await js("(window.__frame = document.querySelector('#preview'), true)");
  assert.equal(frameBefore, true);

  // Edit in Emacs, save: the page follows, the count stays.
  await editFile("app.el", '(format "Count: %d" count)', '(format "Clicks so far: %d" count)');
  await appUntil("document.querySelector('.count').textContent === 'Clicks so far: 3'", "the edit reaches the application");
  assert.match(await status(), /app\.el updated .*no reload, state kept/);
  assert.equal(await js("window.__frame === document.querySelector('#preview')"), true);
  assert.equal(await app("document.querySelector('.count').dataset.before"), "1");
  await app("(document.querySelector('.increment').click(), true)");
  await appUntil("document.querySelector('.count').textContent === 'Clicks so far: 4'", "the application goes on");
  pass("an edit saved in Emacs changes the running application: no reload, same DOM nodes, state kept");

  // New behaviour, too: the handler is replaced.
  await editFile("app.el", "(1+ (react-state self :count))", "(+ 10 (react-state self :count))");
  await appUntil("document.querySelector('.count').textContent === 'Clicks so far: 4'", "still 4");
  await pause(500);
  await until("/app\\.el updated/.test(document.querySelector('#status').textContent)", "the second edit is applied");
  await app("(document.querySelector('.increment').click(), true)");
  await appUntil("document.querySelector('.count').textContent === 'Clicks so far: 14'", "the new handler adds ten");
  pass("a changed event handler is in effect at the next click");

  // A stylesheet.
  await editFile("style.css", "color: #c792ea;", "color: rgb(255, 0, 0);");
  await appUntil("getComputedStyle(document.querySelector('h1')).color === 'rgb(255, 0, 0)'", "the stylesheet is swapped");
  assert.equal(await app("document.querySelector('.count').textContent"), "Clicks so far: 14");
  pass("a saved stylesheet is applied in place");

  // A mistake: the application keeps running on the old code, the error is shown.
  await editFile("app.el", '(h1 "Hello from Emacs Lisp")', '(h1 (this-function-does-not-exist))');
  await until("document.querySelector('#status').classList.contains('error')", "the error is reported");
  assert.match(await js("document.querySelector('#error').textContent"), /this-function-does-not-exist/);
  assert.equal(await app("document.querySelector('h1').textContent"), "Hello from Emacs Lisp");
  await editFile("app.el", '(h1 (this-function-does-not-exist))', '(h1 "Fixed")');
  await appUntil("document.querySelector('h1').textContent === 'Fixed'", "the fix is applied");
  assert.equal(await js("document.querySelector('#error').classList.contains('shown')"), false);
  assert.equal(await app("document.querySelector('.count').textContent"), "Clicks so far: 14");
  pass("a broken edit is reported and leaves the application running; the fix clears the error");

  // An endless loop in the application: it is replaced, the editor lives.
  await editFile("app.el", '(h1 "Fixed")', '(h1 (progn (while t) "never"))');
  await until("/did not start/.test(document.querySelector('#status').textContent)", "the hang is noticed and the stuck application is taken away", 90_000);
  assert.match(await js("document.querySelector('#editor').contentWindow.__wasmacsDebugScreenText()"), /app\.el/);
  await editFile("app.el", '(h1 (progn (while t) "never"))', '(h1 "Back")');
  await appUntil("document.querySelector('h1')?.textContent === 'Back'", "the application comes back");
  assert.equal(await app("document.querySelector('.count').textContent"), "Clicks so far: 0");
  pass("an endless loop takes down only the application, which is started again; Emacs keeps editing");

  // The page's structure: a new application.
  await editFile("index.html", '<div id="app">Loading Emacs…</div>', '<header id="banner">My page</header><div id="app">Loading Emacs…</div>');
  await appUntil("document.querySelector('#banner')?.textContent === 'My page' && document.querySelector('h1')?.textContent === 'Back'", "index.html restarts the application");
  pass("a changed index.html starts the application again");
  console.log("e2e passed");
} catch (error) {
  try {
    console.error("status:", await evaluate(client, undefined, "1").catch(() => ""));
  } catch (_) { /* ignore */ }
  throw error;
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  server?.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
