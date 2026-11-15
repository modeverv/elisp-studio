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
    { stdio: ["ignore", "pipe", "pipe"] });
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
