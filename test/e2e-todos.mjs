// The todos example (accounts, each one's todos) in the studio, where its
// server.el runs in the browser tab on SQLite and hashes passwords with
// the browser's Web Crypto.  The same server.el runs on MySQL through
// tools/serve-cgi.el (test/serve-cgi.test.mjs).
//
//   node test/e2e-todos.mjs
//
// The tab's database survives a reload of the studio; its cookies do not
// (README, Limits), so the account signs in again.
//
// Needs ../wasmacs/docs (built, with SQLite) and ../elisp-react.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../tools/serve.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, waitUntil } from "./lib/cdp.mjs";

const pass = (message) => console.log(`PASS ${message}`);
const { server, origin } = await serve();
const workDir = await mkdtemp(join(tmpdir(), "elisp-studio-todos-"));
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
  const frame = "window.document.querySelector('#preview')?.contentDocument";
  const page = (expression) => js(`(() => { const document = ${frame}; return ${expression}; })()`);
  const until = (expression, label) => waitUntil(
    () => js(`(() => { const document = ${frame}; return Boolean(document) && (${expression}); })()`).catch(() => false), label, 120_000);
  const type = (selector, value) => page(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const submit = (selector) => page(`(document.querySelector(${JSON.stringify(selector)}).requestSubmit(), true)`);
  const titles = () => page("[...document.querySelectorAll('.todo .title')].map((node) => node.textContent)");

  await client.send("Page.navigate", { url: `${origin}/elisp-studio/?example=todos` }, sessionId);
  await until("Boolean(document.querySelector('form.signin'))", "the sign-in form");
  await page("(document.querySelector('p.switch button').click(), true)");
  await until("document.querySelector('form.signin h1')?.textContent === 'Create an account'", "the account form");
  await type(".name", "studio-user");
  await type(".password", "short");
  await submit("form.signin");
  await until("document.querySelector('.signin .error')?.textContent === 'A password needs at least 8 characters'", "a short password is refused");
  await type(".password", "a long enough password");
  await submit("form.signin");
  await until("document.querySelector('header .me')?.textContent === 'studio-user'", "signed in");
  pass("an account is made in the tab (the password hashed with Web Crypto, the session in SQLite)");

  for (const title of ["one thing", "二つ目"]) {
    await type(".draft", title);
    await submit("form.new");
    await until(`[...document.querySelectorAll('.todo .title')].some((node) => node.textContent === ${JSON.stringify(title)})`, `"${title}" is in the list`);
  }
  await page("(document.querySelector('.todo .toggle').click(), true)");
  await until("Boolean(document.querySelector('.todo.done'))", "a todo is done");
  pass(`todos are added and marked: ${JSON.stringify(await titles())}`);

  await page("(document.querySelector('button.signout').click(), true)");
  await until("Boolean(document.querySelector('form.signin'))", "signed out");
  await type(".name", "studio-user");
  await type(".password", "wrong password");
  await submit("form.signin");
  await until("document.querySelector('.signin .error')?.textContent === 'Wrong name or password'", "a wrong password is refused");
  pass("signing out, and a wrong password refused");

  // The studio keeps the tab's database, not its cookies (README, Limits):
  // after a reload the account and its todos are there, behind the sign-in.
  await client.send("Page.navigate", { url: `${origin}/elisp-studio/` }, sessionId);
  await until("Boolean(document.querySelector('form.signin'))", "the sign-in form after a reload");
  await type(".name", "studio-user");
  await type(".password", "a long enough password");
  await submit("form.signin");
  await until("document.querySelectorAll('.todo').length === 2 && Boolean(document.querySelector('.todo.done'))", "the todos after a reload");
  pass(`after a reload of the studio, signed in again: the same todos ${JSON.stringify(await titles())}`);
  console.log("e2e-todos passed");
} finally {
  client?.close();
  chrome?.kill("SIGTERM");
  server.close();
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
