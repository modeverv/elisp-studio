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
import { pbkdf2Sync } from "node:crypto";
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
let chrome = null, client = null, pageSession = null;
try {
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1400,800",
    "--remote-debugging-port=0", `--user-data-dir=${join(workDir, "profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  client = new CdpClient(await devToolsUrl(chrome));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  pageSession = sessionId;
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

  // What the application's Emacs says is shown in the editing Emacs.
  // The terminal's text; a line that Emacs wrapped (it ends in a backslash) is joined again.
  const screen = async () => (await js("document.querySelector('#editor').contentWindow.__wasmacsDebugScreenText()"))
    .split("\n").map((row) => row.trimEnd()).join("\n").replace(/\\\n/g, "");
  const screenUntil = (pattern, label) => waitUntil(async () => pattern.test(await screen()), label, 30_000);
  // Ask Emacs something (a form without side effects) until the answer is
  // on the screen: a message of the studio may overwrite the echo area.
  const emacsUntil = (form, pattern, label) => waitUntil(async () => {
    await emacsEval(form);
    await pause(400);
    return pattern.test(await screen());
  }, label, 30_000);
  await editFile("app.el", "(react-set-state self :count 0)", "(progn (function-that-is-not-there) (react-set-state self :count 0))");
  await screenUntil(/Warning: the function .function-that-is-not-there. is not known/, "the compiler's warning appears in Emacs");
  const warningScreen = await screen();
  assert.match(warningScreen, /\/home\/user\/elisp-studio\/app\/app\.el:\d+:\d+: Warning/);
  assert.match(warningScreen, /\*elisp-studio\*/);
  assert.match(await status(), /app\.el updated/);
  // The same warning is a Flymake diagnostic in the buffer.
  await emacsEval(`(with-current-buffer "app.el"
    (message "flymake-%s-%s" flymake-mode
             (mapcar (lambda (d) (list (flymake-diagnostic-type d) (line-number-at-pos (flymake-diagnostic-beg d))))
                     (flymake-diagnostics))))`);
  await screenUntil(/flymake-t-\(\(:warning \d+\)\)/, "Flymake has the warning at its line");
  // RET on the warning's line, as in any compilation buffer: the place in app.el.
  await emacsEval('(progn (next-error) (message "jumped-to-%s-%s" (buffer-name) (looking-at-p "function-that-is-not-there")))');
  await screenUntil(/jumped-to-app\.el-t/, "next-error jumps to the place of the warning");
  await editFile("app.el", "(progn (function-that-is-not-there) (react-set-state self :count 0))", "(react-set-state self :count 0)");
  await waitUntil(async () => !/\*elisp-studio\*/.test(await screen()), "the log window goes away when there is nothing to say", 30_000);
  await emacsEval('(with-current-buffer "app.el" (message "flymake-now-%d" (length (flymake-diagnostics))))');
  await screenUntil(/flymake-now-0/, "the diagnostic is gone with the warning");
  pass("compiler warnings appear in Emacs with their places (next-error jumps there), as Flymake diagnostics too, and go away when fixed");

  // Emacs knows the libraries the project is written with.
  await emacsEval(`(with-temp-buffer
    (emacs-lisp-mode)
    (insert "(react-plist-w")
    (completion-at-point)
    (message "completed-%s" (buffer-string)))`);
  await screenUntil(/completed-\(react-plist-with/, "C-M-i completes a name of elisp-react");
  await emacsEval(`(message "knows-%S-%s-%s"
    (help-function-arglist 'react-fetch t)
    (string-match-p "Change the state of SELF" (documentation 'react-set-state))
    (fboundp 'app-server-write))`);
  await screenUntil(/knows-\(url &rest options\)-0-t/, "arguments and documentation are known (ElDoc, C-h f)");
  await emacsEval(`(progn
    (xref-find-definitions "react-mount")
    (let ((found (format "definition-%s-%s" (buffer-name) (looking-at-p "(defun react-mount"))))
      (switch-to-buffer "app.el")
      (message "%s" found)))`);
  await screenUntil(/definition-react\.el-t/, "M-. goes to the definition in react.el");
  pass("Emacs completes, describes and finds the functions of elisp-react and of the server library");

  // Diagnostics while typing: a change that is not saved is checked too.
  await emacsEval(`(with-current-buffer "app.el"
    (goto-char (point-max))
    (insert "(defun unsaved-thing () (function-typed-just-now))")
    (flymake-start)
    (message "typing-%s-%s" (buffer-modified-p)
             (mapcar (lambda (d) (list (flymake-diagnostic-type d)
                                       (buffer-substring (flymake-diagnostic-beg d) (flymake-diagnostic-end d))))
                     (flymake-diagnostics))))`);
  await screenUntil(/typing-t-\(\(:warning function-typed-just-now\)\)/, "the unsaved text has its diagnostic, on the symbol");
  assert.equal(await js("window.elispStudio.files.get('app.el').includes('function-typed-just-now')"), false);
  await emacsEval('(with-current-buffer "app.el" (revert-buffer t t t) (flymake-start))');
  await waitUntil(async () => {
    await emacsEval('(with-current-buffer "app.el" (message "reverted-%s-%d" (buffer-modified-p) (length (flymake-diagnostics))))');
    await pause(300);
    return /reverted-nil-0/.test(await screen());
  }, "no diagnostics after the text is taken back", 30_000);
  pass("Flymake checks the buffer as it is typed: this Emacs compiles the text without saving or running it");

  // The project's own definitions are known to Emacs once they are saved.
  await emacsEval(`(with-current-buffer "app.el"
    (goto-char (point-max))
    (insert "\n(defun my-own-helper (count step)\n  \\"The count after one more STEP.\\"\n  (+ count step))\n\n(defvar my-own-setting 5 \\"How far a click goes.\\")\n")
    (save-buffer))`);
  await until("/app\\.el updated/.test(document.querySelector('#status').textContent)", "the file with the helper is applied");
  await emacsUntil(`(with-temp-buffer
    (emacs-lisp-mode)
    (insert "(my-own-h")
    (completion-at-point)
    (message "own-%s-%S-%s-%s" (buffer-string) (help-function-arglist 'my-own-helper t)
             (documentation-property 'my-own-setting 'variable-documentation)
             (symbol-value 'my-own-setting)))`,
    /own-\(my-own-helper-\(count step\)-How far a click goes\.-nil/,
    "the helper completes and has its arguments; the variable is declared but has no value here");
  await emacsUntil(`(progn
    (xref-find-definitions "my-own-helper")
    (let ((found (format "own-definition-%s-%s" (buffer-name)
                         (and (save-excursion (search-forward "(defun my-own-helper" (line-end-position) t)) t))))
      (switch-to-buffer "app.el")
      (message "%s" found)))`, /own-definition-app\.el-t/, "M-. goes to the helper in app.el");
  // Using it draws no "not known to be defined".
  await editFile("app.el", "(+ 10 (react-state self :count))", "(my-own-helper (react-state self :count) 10)");
  await appUntil("true", "the application is there");
  await emacsUntil('(with-current-buffer "app.el" (flymake-start) (message "own-use-%d" (length (flymake-diagnostics))))',
    /own-use-0/, "no diagnostics for a call of the project's own function");
  await app("(document.querySelector('.increment').click(), true)");
  await appUntil("document.querySelector('.count').textContent === 'Clicks so far: 24'", "the helper runs in the application");
  pass("Emacs knows the project's own functions and variables after a save (completion, arguments, M-.), without running the project");

  await editFile("app.el", '(h1 "Fixed")', '(h1 "Fixed"');
  await screenUntil(/End of file during parsing/, "a syntax error appears in Emacs");
  assert.equal(await app("document.querySelector('h1').textContent"), "Fixed");
  await editFile("app.el", '(h1 "Fixed"', '(h1 "Fixed")');
  await until("/app\\.el updated/.test(document.querySelector('#status').textContent)", "the repaired file is applied");
  pass("a file that does not read is reported in Emacs; the application runs on");

  // C-M-x: one definition, without saving.
  await emacsEval(`(with-current-buffer "app.el"
    (goto-char (point-min))
    (search-forward "(h1 \\"Fixed\\")")
    (replace-match "(h1 \\"Not saved\\")" t t)
    (elisp-studio-eval-defun)
    (message "modified-%s" (buffer-modified-p)))`);
  await appUntil("document.querySelector('h1').textContent === 'Not saved'", "the definition reaches the application");
  assert.match(await status(), /a definition of app\.el evaluated/);
  assert.equal(await app("document.querySelector('.count').textContent"), "Clicks so far: 24");
  assert.equal(await js("window.elispStudio.files.get('app.el').includes('Not saved')"), false);
  await emacsEval('(with-current-buffer "app.el" (goto-char (point-min)) (search-forward "(h1 \\"Not saved\\")") (replace-match "(h1 \\"Fixed\\")" t t) (save-buffer))');
  await appUntil("document.querySelector('h1').textContent === 'Fixed'", "back to the saved text");
  pass("C-M-x sends the definition at point to the running application; the file is not saved, the state is kept");

  // The server: a third Emacs in the tab runs the project's server.el.
  const messages = () => app("[...document.querySelectorAll('.message')].map((node) => node.textContent)");
  const send = (text) => app(`(() => {
    const input = document.querySelector('.draft');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.messages form').requestSubmit();
    return true;
  })()`);
  assert.deepEqual(await messages(), ["Hello from the server's Emacs"]);
  await send("first");
  await appUntil("document.querySelectorAll('.message').length === 2", "the server stores a message");
  assert.deepEqual(await messages(), ["Hello from the server's Emacs", "first"]);
  pass("the application's requests to /api/ are answered by server.el in a third Emacs");

  await editFile("server.el", "(list (string-trim text))", "(list (upcase (string-trim text)))");
  await until("/server\\.el updated/.test(document.querySelector('#status').textContent)", "server.el is applied");
  await send("second");
  await appUntil("document.querySelectorAll('.message').length === 3", "the changed server answers");
  assert.deepEqual(await messages(), ["Hello from the server's Emacs", "first", "SECOND"]);
  assert.equal(await app("document.querySelector('.count').textContent"), "Clicks so far: 24");
  pass("a saved server.el takes effect at once; the server keeps its data, the application its state");

  await send("   ");
  await appUntil("document.querySelector('.messages .error')?.textContent === 'A message needs some text'", "the server refuses");
  assert.equal((await messages()).length, 3);
  pass("an error signalled in server.el reaches the page as the response");

  // Answering later: the server's Emacs runs only during a call, so the
  // page keeps the time and makes the server's own requests.
  await editFile("server.el", "(_ (signal 'file-missing", `('("GET" "/api/later")
     (app-server-defer (lambda (respond _fail) (app-server-after 0.3 (lambda () (funcall respond "later"))))))
    ('("GET" "/api/elsewhere")
     (let ((url (app-server-parameter "url")))
       (app-server-defer (lambda (respond _fail)
         (app-server-fetch url :then (lambda (response) (funcall respond (list (plist-get response :status) (length (plist-get response :text))))))))))
    ('("GET" "/api/broken")
     (app-server-defer (lambda (_respond _fail) (app-server-after 0.05 (lambda () (error "Broke later"))))))
    ('("POST" "/api/login") (app-server-set-cookie "session" (app-server-token 8)) (app-server-set-header "X-Greeting" "hello") t)
    ('("GET" "/api/me") (or (app-server-cookie "session") (app-server-refuse "Sign in first" 401)))
    ('("POST" "/api/logout") (app-server-delete-cookie "session") t)
    ('("GET" "/api/bearer") (app-server-header "authorization"))
    ('("POST" "/api/hash")
     (app-server-defer (lambda (respond _fail) (app-server-password-hash-later (car (read-from-string body)) respond))))
    ('("POST" "/api/signin") (app-server-attempts-check "ada") (app-server-attempts-failed "ada") (app-server-session-start "ada"))
    ('("GET" "/api/who") (app-server-session))
    ('("POST" "/api/signout") (app-server-session-end) t)
    ('("POST" "/api/hash-scrypt")
     (app-server-defer (lambda (respond _fail)
       (let ((app-server-password-algorithm 'scrypt))
         (app-server-password-hash-later (car (read-from-string body)) respond)))))
    ('("POST" "/api/check")
     (let ((sent (car (read-from-string body))))
       (app-server-defer (lambda (respond _fail) (app-server-password-check-later (car sent) (cadr sent) respond)))))
    (_ (signal 'file-missing`);
  await until("window.elispStudio.server?.source?.includes('/api/later')", "the deferring server.el is applied");
  const viaServer = (path, options = {}) => js(`(async () => {
    const started = performance.now();
    const response = await window.elispStudio.fetch(${JSON.stringify(path)}, ${JSON.stringify(options)});
    return [response.status, await response.text(), performance.now() - started, response.headers.get("x-greeting")];
  })()`);
  const [[laterStatus, laterText, laterMs], [quickStatus, , quickMs]] = await Promise.all([viaServer("/api/later"), viaServer("/api/messages")]);
  assert.deepEqual([laterStatus, laterText, quickStatus], [200, '"later"', 200]);
  assert.ok(laterMs >= 280 && quickMs < laterMs, `a waiting request does not hold up another (${Math.round(laterMs)} ms, ${Math.round(quickMs)} ms)`);
  const elsewhere = await js("new URL('js/tar.js', location.href).href");
  const tarLength = (await (await fetch(elsewhere)).text()).length;
  assert.deepEqual((await viaServer(`/api/elsewhere?url=${encodeURIComponent(elsewhere)}`)).slice(0, 2), [200, `(200 ${tarLength})`]);
  assert.deepEqual((await viaServer("/api/broken")).slice(0, 2), [400, '"Broke later"']);
  pass("a handler can answer later: after a moment, after a request of its own; an error later is the response");

  // Cookies: the studio keeps them for the application, as a browser would.
  assert.deepEqual((await viaServer("/api/me")).slice(0, 2), [401, '"Sign in first"']);
  const login = await viaServer("/api/login", { method: "POST" });
  assert.deepEqual([login[0], login[3]], [200, "hello"]);
  assert.match((await viaServer("/api/me"))[1], /^"[0-9a-f]{16}"$/);
  await viaServer("/api/logout", { method: "POST" });
  assert.equal((await viaServer("/api/me"))[0], 401);
  assert.equal((await viaServer("/api/bearer", { headers: { Authorization: "Bearer abc.def.ghi" } }))[1], '"Bearer abc.def.ghi"');
  pass("server.el reads and sets headers and cookies, and gets the page's Authorization header; a refusal carries its status");

  // Sessions and the limit on attempts, kept in the tab's own SQLite.
  assert.equal((await viaServer("/api/who"))[1], "nil");
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await viaServer("/api/signin", { method: "POST" }))[1], '"ada"');
  assert.equal((await viaServer("/api/who"))[1], '"ada"');
  assert.deepEqual((await viaServer("/api/signin", { method: "POST" })).slice(0, 2), [429, '"Too many attempts. Try again in 10 minutes"']);
  await viaServer("/api/signout", { method: "POST" });
  assert.equal((await viaServer("/api/who"))[1], "nil");
  pass("server.el starts and ends sessions and stops a sixth attempt, in the tab as under a native Emacs");

  // Passwords: the same functions and the same hashes as under a native
  // Emacs; here the browser's Web Crypto does the arithmetic.
  const hashed = await viaServer("/api/hash", { method: "POST", body: '"pässword 日本語"' });
  assert.match(hashed[1], /^"pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}"$/);
  const [, , hashSalt, hashDigest] = JSON.parse(hashed[1]).split("$");
  assert.equal(hashDigest, pbkdf2Sync("pässword 日本語", hashSalt, 600000, 32, "sha256").toString("hex"));
  assert.equal((await viaServer("/api/check", { method: "POST", body: `("pässword 日本語" ${hashed[1]})` }))[1], "t");
  assert.equal((await viaServer("/api/check", { method: "POST", body: `("pässword 日本" ${hashed[1]})` }))[1], "nil");
  assert.deepEqual((await viaServer("/api/hash-scrypt", { method: "POST", body: '"long enough"' })).slice(0, 2), [400, '"This server cannot make scrypt hashes"']);
  assert.deepEqual((await viaServer("/api/hash", { method: "POST", body: '"short"' })).slice(0, 2), [400, '"A password needs at least 8 characters"']);
  pass(`server.el hashes and checks a password in the tab: the page computes it (${Math.round(hashed[2])} ms for 600,000 rounds), and says so when asked for scrypt`);

  // Publishing: the project as a ZIP, and with git from inside Emacs.
  const zipNames = await js(`(async () => {
    const zip = await window.elispStudio.zip();
    const text = new TextDecoder("latin1").decode(zip);
    const names = ["index.html", "app.el", "style.css", "server.el", "run.sh", "fetch-emacs.sh", "backup.sh", "server/serve-project.el", "server/app-server.el", "server/LICENSE", "README.txt",
      "server/deploy/Caddyfile", "server/deploy/nginx.conf", "server/deploy/app.service"];
    return { magic: text.slice(0, 2), missing: names.filter((name) => !text.includes(name)), git: text.includes(".git/") };
  })()`);
  assert.deepEqual(zipNames, { magic: "PK", missing: [], git: false });
  pass("the project downloads as a ZIP archive, with run.sh and the server files");

  // C-c C-p commits; with a remote it pushes.  The remote here is a bare
  // repository in Emacs's own filesystem.
  await emacsEval('(message "publish-1-%s" (elisp-studio-publish "First version"))');
  await screenUntil(/Committed\.  No remote yet|publish-1-t/, "a commit without a remote");
  await emacsEval(`(progn
    (let ((default-directory "/home/user/")) (process-file "git" nil nil nil "init" "-q" "--bare" "published.git"))
    (let ((default-directory elisp-studio-project)) (process-file "git" nil nil nil "remote" "add" "origin" "/home/user/published.git"))
    (message "publish-2-%s" (elisp-studio-publish "nothing new")))`);
  await screenUntil(/Nothing new to commit; pushed|publish-2-t/, "the commit is pushed to the remote");
  await editFile("style.css", "font-size: 22px;", "font-size: 24px;");
  await screenUntil(/style\.css updated/, "the studio's word about the stylesheet has arrived in Emacs");
  await emacsEval('(message "publish-3-%s" (elisp-studio-publish "Bigger title"))');
  await screenUntil(/Committed and pushed|publish-3-t/, "a change is committed and pushed");
  await emacsEval(`(with-temp-buffer
    (let ((default-directory "/home/user/published.git/"))
      (process-file "git" nil t nil "log" "--format=%s" "--all")
      (process-file "git" nil t nil "show" "--stat" "--format=" "HEAD"))
    (message "remote-has-%s" (replace-regexp-in-string "[[:space:]]+" "_" (string-trim (buffer-string)))))`);
  await screenUntil(/remote-has-Bigger_title_First_version_style\.css/, "the remote has both commits, the last one touching style.css");
  assert.equal(await js("[...window.elispStudio.files.keys()].some((path) => path.startsWith('.git'))"), false);
  pass("C-c C-p in Emacs commits the project with git and pushes it to its remote");

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

  // Close the tab, come back: the project (Emacs's files) and what the
  // server kept are still there.
  await client.send("Page.navigate", { url: `${origin}/elisp-studio/` }, sessionId);
  await appUntil("document.querySelector('#banner')?.textContent === 'My page' && document.querySelectorAll('.message').length === 3", "everything is still there after a reload");
  assert.deepEqual(await messages(), ["Hello from the server's Emacs", "first", "SECOND"]);
  pass("after a reload of the studio, the project and the server's data are as they were");
  console.log("e2e passed");
} catch (error) {
  // What the studio and Emacs showed when it went wrong.
  try {
    const show = (expression) => evaluate(client, pageSession, expression).catch((failure) => `(${failure.message})`);
    console.error("status:", await show("document.querySelector('#status').textContent"));
    console.error("error :", await show("document.querySelector('#error').textContent"));
    console.error("app   :", await show("document.querySelector('#preview')?.contentDocument?.body?.innerText"));
    console.error("emacs :\n" + await show("document.querySelector('#editor').contentWindow.__wasmacsDebugScreenText().split('\\n').map((row) => row.trimEnd()).filter(Boolean).join('\\n')"));
  } catch (_) { /* the browser is gone */ }
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
