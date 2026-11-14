// The upload example in the studio: a file goes from a file input to
// server.el in the tab's Emacs, is kept, comes back, and is still there
// after a reload.
//
//   node test/e2e-upload.mjs
//
// Needs ../wasmacs/docs (built) and ../elisp-react.  The same server.el
// under a native Emacs, with large files, is in test/serve-project.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../tools/serve.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, waitUntil } from "./lib/cdp.mjs";

const pass = (message) => console.log(`PASS ${message}`);
const { server, origin } = await serve();
const workDir = await mkdtemp(join(tmpdir(), "elisp-studio-upload-"));
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
  const until = (expression, label) => waitUntil(() => js(expression).catch(() => false), label, 90_000);
  const frame = "window.document.querySelector('#preview')?.contentDocument";
  const page = (expression) => js(`(() => { const document = ${frame}; return ${expression}; })()`);
  const pageUntil = (expression, label) => until(`(() => { const document = ${frame}; return Boolean(document) && (${expression}); })()`, label);
  const names = () => page("[...document.querySelectorAll('li.file .name')].map((node) => node.textContent)");
  // The visitor chooses a file of SIZE bytes (byte i is i mod 251) and sends it.
  const put = async (name, size) => {
    await page(`(() => {
      const bytes = Uint8Array.from({ length: ${size} }, (_, index) => index % 251);
      const chosen = new DataTransfer();
      chosen.items.add(new File([bytes], ${JSON.stringify(name)}, { type: "application/x-test" }));
      const input = document.querySelector('input.file');
      input.files = chosen.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await pageUntil("!document.querySelector('button.put').disabled", "the page knows a file is chosen");
  };
  const send = () => page("(document.querySelector('form.new').requestSubmit(), true)");
  // What the server sends back for a file, as the studio hands it to the page.
  const taken = (name) => js(`window.elispStudio.fetch(${JSON.stringify(`/api/file?name=${encodeURIComponent(name)}`)}).then(async (response) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, size: bytes.length, intact: bytes.every((byte, index) => byte === index % 251),
             disposition: response.headers.get("Content-Disposition"), type: response.headers.get("Content-Type") };
  })`);

  await client.send("Page.navigate", { url: `${origin}/elisp-studio/?example=upload` }, sessionId);
  await pageUntil("/0 files on the shelf/.test(document.querySelector('.status')?.textContent || '')", "the shelf starts empty");
  assert.equal(await page("document.querySelector('button.put').disabled"), true);

  await put("notes of today.bin", 3_000_000);
  assert.equal(await page("document.querySelector('button.put').textContent"), "put on the shelf (2.9 MB)");
  pass("the page's Lisp learns what the visitor chose: a name and a size, not the content");
  await send();
  await pageUntil("document.querySelectorAll('li.file').length === 1", "the file is on the shelf");
  assert.deepEqual(await names(), ["notes_of_today.bin"]);
  assert.equal(await page("document.querySelector('li.file .size').textContent"), "2.9 MB");
  assert.deepEqual(await taken("notes_of_today.bin"),
    { status: 200, size: 3_000_000, intact: true, disposition: 'attachment; filename="notes_of_today.bin"', type: "application/octet-stream" });
  pass("a 3 MB file goes from the file input to server.el in the tab and comes back intact");

  await put("../../etc/passwd", 10);
  await send();
  await pageUntil("document.querySelectorAll('li.file').length === 2", "a second file");
  assert.deepEqual(await names(), ["notes_of_today.bin", "passwd"]);
  assert.equal((await taken("../notes_of_today.bin")).size, 3_000_000);   // only the last part of a name counts
  pass("a name that points elsewhere ends up as a plain name on the shelf");

  await client.send("Page.navigate", { url: `${origin}/elisp-studio/` }, sessionId);
  await pageUntil("document.querySelectorAll('li.file').length === 2", "the shelf is there after a reload");
  assert.equal((await taken("notes_of_today.bin")).intact, true);
  pass("kept files survive a reload of the studio (IndexedDB)");

  await page("(document.querySelector('li.file .remove').click(), true)");
  await pageUntil("document.querySelectorAll('li.file').length === 1", "a file is taken off the shelf");
  assert.deepEqual(await names(), ["passwd"]);
  assert.equal((await taken("notes_of_today.bin")).status, 404);
  pass("a file is removed; asking for it afterwards is a 404");
  console.log("upload e2e passed");
} finally {
  client?.close();
  chrome?.kill();
  server?.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(workDir, { recursive: true, force: true });
}
