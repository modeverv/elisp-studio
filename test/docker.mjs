// The downloaded project under Docker: the template, assembled as the
// download assembles it (js/studio.js, RUNTIME_FILES), started with its
// docker-compose.yml, checked from outside.  Not a unit test: it builds an
// image (Ubuntu with its Emacs, and Caddy) and takes a few minutes.
//
//   npm run test:docker        needs docker with compose; uses ports 18080, 18443
//
// What it checks:
// - Plain HTTP through Caddy: the page, /api/, a file that Caddy sends for
//   Emacs (X-Accel-Redirect), and the server's refusals (another site's
//   page, another host, .data/, server.el).
// - The data in its volume after a restart and after the container is made
//   again.
// - HTTPS with DOMAIN=localhost, where Caddy makes its own certificate.
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const project = "elisp-studio-docker-test";
const ports = { HTTP_PORT: "18080", HTTPS_PORT: "18443" };
const http = `http://localhost:${ports.HTTP_PORT}`;
const https = `https://localhost:${ports.HTTPS_PORT}`;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The template and RUNTIME_FILES of js/studio.js in DIRECTORY. */
async function assemble(directory) {
  await cp(join(root, "template"), directory, { recursive: true });
  const studio = await readFile(join(root, "js/studio.js"), "utf8");
  const list = studio.slice(studio.indexOf("const RUNTIME_FILES"), studio.indexOf("];", studio.indexOf("const RUNTIME_FILES")));
  const entries = [...list.matchAll(/\["([^"]+)", "([^"]+)", (true|false)\]/g)];
  assert.ok(entries.some(([, path]) => path === "Dockerfile"), "RUNTIME_FILES has the Dockerfile");
  for (const [, path, source, executable] of entries) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await cp(join(root, source), join(directory, path));
    await chmod(join(directory, path), executable === "true" ? 0o755 : 0o644);
  }
  // A file larger than 16 KB: Emacs names it and Caddy sends it.
  await writeFile(join(directory, "large.txt"), "elisp-studio\n".repeat(4000));
}

async function compose(directory, env, ...args) {
  const { stdout } = await execFile("docker", ["compose", "-p", project, ...args],
    { cwd: directory, env: { ...process.env, ...ports, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** curl, for what fetch cannot do: another Host, a certificate of Caddy's own. */
async function curl(...args) {
  const { stdout } = await execFile("curl", ["-s", "-k", "--max-time", "20", ...args]);
  return stdout;
}

async function waitFor(url, label, timeoutMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await curl("-o", "/dev/null", "-w", "%{http_code}", url).catch(() => "")) === "200") return;
    await pause(1000);
  }
  throw new Error(`timed out: ${label}`);
}

const directory = await mkdtemp(join(tmpdir(), "elisp-studio-docker-"));
try {
  await assemble(directory);

  console.log("docker compose up --build (HTTP) ...");
  await compose(directory, {}, "up", "-d", "--build");
  await waitFor(`${http}/`, "the page over HTTP");

  const page = await fetch(`${http}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("via"), "1.1 Caddy", "Caddy is in front of Emacs");
  assert.match(await page.text(), /<div id="app">/);
  assert.match(await (await fetch(`${http}/api/messages`)).text(), /Hello from the server's Emacs/);
  const posted = await fetch(`${http}/api/messages`, { method: "POST", headers: { Origin: http }, body: '"Sent to Emacs in Docker"' });
  assert.equal(posted.status, 200);
  assert.match(await posted.text(), /Sent to Emacs in Docker/);
  console.log("ok: the page and /api/ through Caddy");

  const large = await fetch(`${http}/large.txt`);
  assert.equal(large.status, 200);
  assert.equal((await large.text()).length, 13 * 4000, "the whole file");
  assert.equal(large.headers.get("server"), "Caddy", "Caddy sent the file itself");
  console.log("ok: a large file, sent by Caddy for Emacs");

  assert.equal((await fetch(`${http}/api/messages`, { method: "POST", headers: { Origin: "https://elsewhere.example" }, body: '"x"' })).status, 403);
  assert.equal(await curl("-o", "/dev/null", "-w", "%{http_code}", "-H", "Host: elsewhere.example", `${http}/`), "421");
  assert.equal((await fetch(`${http}/.data/messages.eld`)).status, 404);
  assert.equal((await fetch(`${http}/server.el`)).status, 404);
  console.log("ok: refused: another site's page (403), another host (421), .data/ and server.el (404)");

  const owners = await compose(directory, {}, "exec", "-T", "app", "sh", "-c",
    "stat -c '%U' /srv/app /srv/app/.data; for p in /proc/[0-9]*; do [ \"$(cat $p/comm 2>/dev/null)\" = emacs ] && stat -c '%U' $p; done | sort -u");
  assert.deepEqual(owners.trim().split("\n"), ["root", "app", "app"], "the files are root's; Emacs runs as app and owns .data/");
  console.log("ok: Emacs runs as app and can write .data/ only");

  await compose(directory, {}, "restart");
  await waitFor(`${http}/api/messages`, "after a restart", 120_000);
  assert.match(await (await fetch(`${http}/api/messages`)).text(), /Sent to Emacs in Docker/);
  console.log("ok: the data after a restart");

  console.log("docker compose up (HTTPS, DOMAIN=localhost) ...");
  await compose(directory, {}, "down");
  await compose(directory, { DOMAIN: "localhost" }, "up", "-d");
  await waitFor(`${https}/`, "the page over HTTPS", 120_000);
  assert.match(await curl(`${https}/api/messages`), /Sent to Emacs in Docker/, "the volume outlived the container");
  assert.match(await curl("-X", "POST", "-H", `Origin: ${https}`, "--data", '"Over HTTPS"', `${https}/api/messages`), /Over HTTPS/);
  assert.equal(await curl("-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", `Origin: ${http}`, "--data", '"x"', `${https}/api/messages`), "403",
    "the published origin is https://localhost:18443 now");
  console.log("ok: HTTPS with Caddy's certificate; the data of the volume; the new origin");
  console.log("docker test passed");
} catch (error) {
  console.error(await compose(directory, {}, "logs", "--no-color", "--tail", "80").catch(() => ""));
  throw error;
} finally {
  await compose(directory, {}, "down", "-v", "--rmi", "local").catch((error) => console.error(error.message));
  await rm(directory, { recursive: true, force: true });
}
