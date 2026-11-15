// The studio with a project in a directory of this machine, in real Chrome,
// and a native Emacs that edits the directory (lisp/elisp-studio-local.el).
//
//   node test/e2e-local.mjs
//
// Needs ../wasmacs/docs (built) and ../elisp-react, or the network for
// their published files, and a native Emacs.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../tools/serve.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "./lib/cdp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pass = (message) => console.log(`PASS ${message}`);
const workDir = await mkdtemp(join(tmpdir(), "elisp-studio-local-"));
const project = join(workDir, "my-app");
await cp(join(root, "template"), project, { recursive: true });
const { server, origin } = await serve({ project });
// What tools/studio.mjs leaves for an editor to find the studio by.
await writeFile(join(project, ".elisp-studio.json"), JSON.stringify({ url: origin }));
const emacs = execFileSync(join(root, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
// A native Emacs, as somebody's own: the library loaded, then FORMS.
const inEmacs = (forms) => new Promise((resolve, reject) => {
  const child = spawn(emacs, ["--batch", "-Q", "-l", join(root, "lisp/elisp-studio-local.el"), "--eval", `(progn ${forms})`],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_CACHE_HOME: join(workDir, "cache") } });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`Emacs exited with ${code}: ${err}`))));
});
// Wait in Emacs for the studio's next answer, then print it.
const awaitReport = `(let ((limit (+ (float-time) 20)))
  (while (and (not elisp-studio-local-last-report) (< (float-time) limit)) (accept-process-output nil 0.1))
  (princ (format "%s|%s|%s" (plist-get elisp-studio-local-last-report :status)
                 (plist-get elisp-studio-local-last-report :summary) (plist-get elisp-studio-local-last-report :log))))`;

let chrome = null, client = null;
try {
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1200,800",
    "--remote-debugging-port=0", `--user-data-dir=${join(workDir, "profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  client = new CdpClient(await devToolsUrl(chrome));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  const js = (expression) => evaluate(client, sessionId, expression);
  const until = (expression, label, ms = 120_000) => waitUntil(() => js(expression).catch(() => false), label, ms);
  const app = (expression) => js(`(() => { const document = window.document.querySelector('#preview').contentDocument; return ${expression}; })()`);
  const appUntil = (expression, label) => until(`(() => { const frame = window.document.querySelector('#preview'); if (!frame?.contentDocument) return false; const document = frame.contentDocument; return ${expression}; })()`, label);
  const status = () => js("document.querySelector('#status').textContent");
  const edit = async (file, change) => writeFile(join(project, file), change(await readFile(join(project, file), "utf8")));
  // The studio's answers, as an editor on this machine gets them.
  const reportAfter = async (n) => (await fetch(`${origin}/__project/report?after=${n}&wait=20`)).json();
  const reports = async () => (await (await fetch(`${origin}/__project/state`)).json()).report;

  await client.send("Page.navigate", { url: `${origin}/elisp-studio/?project=local` }, sessionId);
  await appUntil("document.querySelector('h1')?.textContent === 'Hello from Emacs Lisp'", "the application of the directory runs");
  assert.equal(await js("document.querySelector('#project').textContent"), project);
  assert.equal(await js("getComputedStyle(document.querySelector('.editor-pane')).display"), "none");
  assert.equal(await js("document.querySelector('#editor').getAttribute('src')"), null);
  pass(`the page shows the application of ${project}; no Emacs in the page`);

  // State to keep, and a node to recognise.
  await app("(document.querySelector('.increment').click(), document.querySelector('.increment').click(), true)");
  await appUntil("document.querySelector('.count').textContent === 'Count: 2'", "the counter counts");
  await app("(document.querySelector('.count').dataset.mine = 'yes', true)");

  // A save from anywhere: the file changes on the disk, the page follows.
  let seen = await reports();
  await edit("app.el", (text) => text.replace("Hello from Emacs Lisp", "Hello from a file on the disk"));
  await appUntil("document.querySelector('h1').textContent === 'Hello from a file on the disk'", "the saved app.el is applied");
  assert.deepEqual(await app("[document.querySelector('.count').textContent, document.querySelector('.count').dataset.mine]"), ["Count: 2", "yes"]);
  const answer = await reportAfter(seen);
  assert.deepEqual([answer.status, /app\.el updated at .*: no reload, state kept/.test(answer.summary)], ["ok", true]);
  pass(`app.el saved on the disk is applied without a reload, state kept; the studio answers "${answer.summary}"`);

  await edit("style.css", (text) => `${text}\nh1 { letter-spacing: 3px; }\n`);
  await appUntil("getComputedStyle(document.querySelector('h1')).letterSpacing === '3px'", "the saved stylesheet is applied");
  pass("a saved stylesheet is applied in place");

  // A file that does not read: said so, with the file's name on this
  // machine; the application runs on, and the repair clears it.
  seen = await reports();
  const good = await readFile(join(project, "app.el"), "utf8");
  await writeFile(join(project, "app.el"), `${good}\n(defun broken (`);
  const broken = await reportAfter(seen);
  assert.equal(broken.status, "error");
  assert.match(`${broken.summary} ${broken.log}`, /app\.el/);
  assert.equal(await app("document.querySelector('.count').textContent"), "Count: 2");
  seen = broken.n;
  await writeFile(join(project, "app.el"), `${good}\n(defun unused-argument (x) 1)\n`);
  const repaired = await reportAfter(seen);
  assert.equal(repaired.status, "ok");
  assert.equal(repaired.log.includes(`${project}/app.el`), true, repaired.log);   // the compiler's warning, with the place
  pass(`a broken save is reported and leaves the application running; warnings name ${project}/app.el`);

  // A native Emacs with the library: saving shows the studio's answer.
  const saved = await inEmacs(`
    (find-file ${JSON.stringify(join(project, "app.el"))})
    (unless elisp-studio-local-mode (error "the mode is not on"))
    (goto-char (point-min))
    (search-forward "Hello from a file on the disk")
    (replace-match "Hello from my own Emacs")
    (save-buffer)
    ${awaitReport}`);
  assert.match(saved, /^ok\|elisp-studio: app\.el updated at .*: no reload, state kept\|/);
  await appUntil("document.querySelector('h1').textContent === 'Hello from my own Emacs'", "what Emacs saved is applied");
  assert.deepEqual(await app("[document.querySelector('.count').textContent, document.querySelector('.count').dataset.mine]"), ["Count: 2", "yes"]);
  pass(`a native Emacs saves app.el: the page follows, and Emacs is told "${saved.split("|")[1]}"`);

  // C-M-x: one definition into the running application, the file not saved.
  const before = await readFile(join(project, "app.el"), "utf8");
  const evaluated = await inEmacs(`
    (find-file ${JSON.stringify(join(project, "app.el"))})
    (goto-char (point-min))
    (search-forward "\\"+1\\"")
    (replace-match "\\"+one\\"")
    (elisp-studio-local-eval-defun)
    ${awaitReport}`);
  assert.match(evaluated, /^ok\|elisp-studio: a definition of app\.el evaluated at .*state kept \(not saved yet\)\|/);
  await appUntil("document.querySelector('.increment').textContent === '+one'", "the definition is in the application");
  assert.equal(await app("document.querySelector('.count').textContent"), "Count: 2");
  assert.equal(await readFile(join(project, "app.el"), "utf8"), before);
  pass("C-M-x in a native Emacs changes the running application; the file is as it was");

  // The address bar: the preview has no address, elisp-react keeps one in
  // memory; the studio shows it and moves it, and hash links stay inside.
  await writeFile(join(project, "app.el"), `;;; -*- lexical-binding: t; -*-
(react-define-component 'Where
  :initial-state (lambda (_props) (list :hash (react-location :hash)))
  :did-mount (lambda (self) (react-location-watch (lambda (location) (react-set-state self :hash (plist-get location :hash)))))
  :render (lambda (self) (jsx (div (p (:class "where") (react-state self :hash)) (a (:class "about" :href "#/about") "about")))))
(react-mount '(Where) "#app")
`);
  await appUntil("Boolean(document.querySelector('.where'))", "the new app.el is applied");
  await js("const field = document.querySelector('#address'); field.value = '#/settings'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); true");
  await appUntil("document.querySelector('.where').textContent === '#/settings'", "the address bar moves the application");
  assert.equal(await js("document.querySelector('#address').value"), "/#/settings");
  await app("document.querySelector('.about').click()");
  await appUntil("document.querySelector('.where').textContent === '#/about'", "a hash link is followed in the application");
  assert.equal(await js("document.querySelector('#address').value"), "/#/about");
  assert.equal(await js("document.querySelector('#preview').contentWindow.location.href"), "about:srcdoc");
  await js("document.querySelector('#back').click(); true");
  await appUntil("document.querySelector('.where').textContent === '#/settings'", "Back");
  await js("document.querySelector('#forward').click(); true");
  await appUntil("document.querySelector('.where').textContent === '#/about'", "Forward");
  pass("the address bar shows the application's address and moves it; hash links stay in the preview; Back and Forward work");

  // The project's own files: a data file the application fetches, an image
  // it shows; nothing of the server.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await writeFile(join(project, "pixel.png"), pixel);
  await writeFile(join(project, "data.json"), '{"greeting":"from data.json"}');
  await writeFile(join(project, "app.el"), `;;; -*- lexical-binding: t; -*-
(react-define-component 'Files
  :initial-state (lambda (_props) (list :greeting ""))
  :did-mount (lambda (self) (react-fetch "data.json" :then (lambda (response) (react-set-state self :greeting (plist-get (react-response-json response) :greeting)))))
  :render (lambda (self) (jsx (div (p (:class "greeting") (react-state self :greeting)) (img (:class "pixel" :src "pixel.png" :alt ""))))))
(react-mount '(Files) "#app")
`);
  await appUntil("document.querySelector('.greeting')?.textContent === 'from data.json'", "the application fetches a file of the project");
  await appUntil("document.querySelector('.pixel')?.naturalWidth === 1", "the application shows an image of the project");
  for (const [path, status] of [["pixel.png", 200], ["server.el", 404], [".elisp-studio.json", 404], ["../package.json", 404]]) {
    assert.equal((await fetch(`${origin}/__project/files/${path}`)).status, status, path);
  }
  pass("the application fetches and shows the project's own files (data.json, an image); server.el and hidden files are not served");

  // Two files changed at once load in index.html's order (lib.el before
  // app.el, although "app.el" sorts first); a failure keeps the files after
  // it for the next change.
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word () \"one\")\n");
  await writeFile(join(project, "app.el"), ";;; -*- lexical-binding: t; -*-\n(react-mount (jsx (p (:class \"order\") (order-word))) \"#app\")\n");
  await edit("index.html", (html) => html.replace('<script type="text/emacs-lisp" src="app.el">', '<script type="text/emacs-lisp" src="lib.el"></script>\n<script type="text/emacs-lisp" src="app.el">'));
  await appUntil("document.querySelector('.order')?.textContent === 'one'", "the application starts with lib.el and app.el");
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word () \"one\")\n(defun order-word-2 () \"two\")\n");
  await writeFile(join(project, "app.el"), ";;; -*- lexical-binding: t; -*-\n(react-mount (jsx (p (:class \"order\") (order-word-2))) \"#app\")\n");
  await appUntil("document.querySelector('.order')?.textContent === 'two'", "both changes are applied, lib.el first");
  // lib.el broken and app.el changed: app.el waits; fixing lib.el alone brings it in.
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word-3 () \"three\"\n");
  await writeFile(join(project, "app.el"), ";;; -*- lexical-binding: t; -*-\n(react-mount (jsx (p (:class \"order\") (order-word-3))) \"#app\")\n");
  await until("/lib.el: not applied .*; not loaded after it: app.el/.test(document.querySelector('#status').textContent)", "the failure names what was not loaded");
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word-3 () \"three\")\n");
  await appUntil("document.querySelector('.order')?.textContent === 'three'", "fixing lib.el loads app.el too");
  pass("files changed together load in index.html's order; after a failure the files not loaded are loaded with the next change");

  // A definition taken out of its file is taken out of the application, and
  // a file that still uses it is named.
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word-3 () \"three\")\n(defun lib-unused () 1)\n(defvar lib-setting 2)\n");
  await appUntil("document.querySelector('.order')?.textContent === 'three'", "lib.el with more definitions");
  const defined = (name) => js(`window.elispStudio.preview.app.emacs.eval("(vector (fboundp '${name}) (boundp 'lib-setting))")`);
  await until("/lib.el updated/.test(document.querySelector('#status').textContent)", "lib.el is applied");
  assert.deepEqual(await defined("lib-unused"), [true, true]);
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word-3 () \"three\")\n");
  await until("/function lib-unused is gone; variable lib-setting is gone/.test(document.querySelector('#status').textContent)", "the removed definitions are reported");
  assert.deepEqual(await defined("lib-unused"), [null, null]);
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word-4 () \"four\")\n");
  await until("/function order-word-3 is gone, but app.el still uses it/.test(document.querySelector('#status').textContent)", "a file that still uses it is named");
  await writeFile(join(project, "lib.el"), ";;; -*- lexical-binding: t; -*-\n(defun order-word-3 () \"three\")\n");
  pass("definitions taken out of a file are taken out of the running application; a file that still uses one is named");

  // Data only (a defconst in words.el): every component renders again.
  await writeFile(join(project, "words.el"), ";;; -*- lexical-binding: t; -*-\n(defconst words-greeting \"hello\")\n");
  await writeFile(join(project, "app.el"), ";;; -*- lexical-binding: t; -*-\n(react-define-component 'Greeting :pure t :render (lambda (_self) (jsx (p (:class \"greeting-word\") words-greeting))))\n(react-mount '(Greeting) \"#app\")\n");
  await edit("index.html", (html) => html.replace('<script type="text/emacs-lisp" src="app.el">', '<script type="text/emacs-lisp" src="words.el"></script>\n<script type="text/emacs-lisp" src="app.el">'));
  await appUntil("document.querySelector('.greeting-word')?.textContent === 'hello'", "the application starts with words.el");
  await writeFile(join(project, "words.el"), ";;; -*- lexical-binding: t; -*-\n(defconst words-greeting \"good morning\")\n");
  await appUntil("document.querySelector('.greeting-word')?.textContent === 'good morning'", "a change of data alone renders again");
  pass("a change of data alone (a defconst) renders the application again, :pure components too");

  // A save whose definitions load but whose render fails says so, with the
  // component; the next good save clears it.
  await writeFile(join(project, "app.el"), ";;; -*- lexical-binding: t; -*-\n(react-define-component 'Greeting :pure t :render (lambda (_self) (jsx (p (:class \"greeting-word\") (car 1)))))\n");
  await until("/app\\.el: loaded, but the application failed to render/.test(document.querySelector('#status').textContent)", "a failed render is reported as such");
  assert.match(await js("document.querySelector('#error').textContent"), /Wrong type argument: listp, 1, in Greeting/);
  await writeFile(join(project, "app.el"), ";;; -*- lexical-binding: t; -*-\n(react-define-component 'Greeting :pure t :render (lambda (_self) (jsx (p (:class \"greeting-word\") words-greeting))))\n(react-mount '(Greeting) \"#app\")\n");
  await until("/app\\.el updated/.test(document.querySelector('#status').textContent) && document.querySelector('#error').textContent === ''", "the next good save clears it");
  await appUntil("document.querySelector('.greeting-word')?.textContent === 'good morning'", "and renders");
  pass("a save that loads but fails to render is reported as that, naming the component; the next good save clears it");

  // An expression evaluated in the running application, with its value.
  const value = await (await fetch(`${origin}/__project/value`, { method: "POST", body: JSON.stringify({ text: "(+ 20 22)" }) })).json();
  assert.deepEqual(value, { value: "42", output: "", error: null });
  const inspected = await inEmacs(`(find-file ${JSON.stringify(join(project, "app.el"))}) (princ (elisp-studio-local-eval-expression "(react-inspect)"))`);
  assert.match(inspected, /:component Greeting :depth 0/);
  pass(`an expression is evaluated in the application and its value comes back, to Emacs too: ${inspected.trim()}`);

  // Your own Emacs knows react.el and the project's definitions: Flymake
  // compiles a file that requires react without warnings, components and
  // helpers complete.
  await writeFile(join(project, "check.el"), ";;; -*- lexical-binding: t; -*-\n(require 'react)\n(react-define-component 'Check :render (lambda (self) (jsx (p (:class \"c\") (react-state self :x) (order-word-3)))))\n");
  const known = await inEmacs(`
    (find-file ${JSON.stringify(join(project, "check.el"))})
    (require 'bytecomp)
    (let ((load-path (append elisp-flymake-byte-compile-load-path load-path)) (warnings nil))
      (let ((byte-compile-log-warning-function (lambda (text &rest _) (push text warnings))))
        (byte-compile-file buffer-file-name))
      (princ (format "react:%s component:%s helper:%s warnings:%S"
                     (featurep 'react) (fboundp 'Greeting) (fboundp 'order-word-3)
                     (seq-filter (lambda (text) (string-match-p "not known\\|free variable" text)) warnings))))`);
  assert.match(known, /react:t component:t helper:t warnings:nil/);
  await rm(join(project, "check.el"));
  await rm(join(project, "check.elc"), { force: true });
  pass("your own Emacs gets react.el from the studio and the project's definitions: no false warnings, components and helpers known");

  // No isolation on this machine: there is no editor in the page.
  assert.deepEqual(await js("[window.crossOriginIsolated, document.querySelector('#preview').contentWindow.crossOriginIsolated]"), [false, false]);
  assert.equal((await fetch(`${origin}/elisp-studio/`)).headers.get("cross-origin-embedder-policy"), null);
  pass("on this machine the studio and its preview are not cross-origin isolated (third-party frames need no credentialless)");

  // Not a file of a project: the mode stays off, and saving asks nobody.
  const elsewhere = join(workDir, "elsewhere.el");
  await writeFile(elsewhere, "(list)");
  assert.equal(await inEmacs(`(find-file ${JSON.stringify(elsewhere)}) (princ (if elisp-studio-local-mode "on" "off"))`), "off");
  // A studio that is not there: Emacs says so and saves all the same.
  server.close();
  const alone = await inEmacs(`
    (find-file ${JSON.stringify(join(project, "style.css"))})
    (goto-char (point-max)) (insert "\\n/* saved without a studio */\\n")
    (save-buffer)
    (princ (if elisp-studio-local-mode "saved" "the mode is off"))`);
  assert.equal(alone, "saved");
  assert.match(await readFile(join(project, "style.css"), "utf8"), /saved without a studio/);
  pass("outside a project the mode is off; without the studio a save is a save");
  console.log("local e2e passed");
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  server.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
