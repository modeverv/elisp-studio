// Record the studio in use: the pictures in the README.
//
//   node tools/record-demo.mjs            writes doc/images/demo.gif and two PNGs
//
// Headless Chrome opens the studio with the stopwatch example
// (?example=stopwatch) from a local server, and this script plays a user:
// it clicks in the application and types into Emacs, key by key, while
// screenshots are taken.  ffmpeg turns them into the GIF.  Needs Chrome,
// ffmpeg, and ../wasmacs/docs and ../elisp-react next to this repository.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "../test/lib/cdp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const images = join(root, "doc/images");
const WIDTH = 1280, HEIGHT = 720, FPS = 8;

const { server, origin } = await serve();
const workDir = await mkdtemp(join(tmpdir(), "elisp-studio-demo-"));
const frames = join(workDir, "frames");
await mkdir(frames, { recursive: true });
await mkdir(images, { recursive: true });
let chrome = null, client = null;
try {
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`, "--remote-debugging-port=0", `--user-data-dir=${join(workDir, "profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  client = new CdpClient(await devToolsUrl(chrome));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
  const js = (expression) => evaluate(client, sessionId, expression);
  const until = (expression, label) => waitUntil(() => js(expression).catch(() => false), label, 90_000);
  const app = (expression) => js(`(() => { const document = window.document.querySelector('#preview').contentDocument; return ${expression}; })()`);
  const screenshot = async () => Buffer.from((await client.send("Page.captureScreenshot", { format: "png" }, sessionId)).data, "base64");

  // ---- the user ---------------------------------------------------------------
  const keys = (text) => js(`(document.querySelector('#editor').contentWindow.__wasmacsDebugSendInputBytes(${JSON.stringify([...new TextEncoder().encode(text)])}), true)`);
  // Type like a person: one key after the other.
  const type = async (text, delay = 70) => {
    for (const char of text) {
      await keys(char);
      await pause(delay);
    }
  };
  const click = (selector) => app(`(document.querySelector(${JSON.stringify(selector)}).click(), true)`);
  // What is going on, for the viewer: a line across the bottom of the page.
  const caption = (text) => js(`(() => {
    let bar = document.querySelector('#demo-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-caption';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:9px 16px;background:#c792ea;color:#16181d;font:600 17px system-ui,sans-serif;z-index:99';
      document.body.append(bar);
      document.querySelector('main').style.paddingBottom = '40px';
    }
    bar.textContent = ${JSON.stringify(text)};
    return true;
  })()`);

  await client.send("Page.navigate", { url: `${origin}/elisp-studio/?example=stopwatch` }, sessionId);
  await until("Boolean(document.querySelector('#preview')?.contentDocument?.querySelector('.time'))", "the stopwatch renders");
  await until("/Stopwatch/.test(document.querySelector('#editor').contentWindow.__wasmacsDebugScreenText())", "Emacs shows app.el");
  await caption("elisp-studio: Emacs on the left, the application it is editing on the right");
  await pause(1500);

  // ---- recording --------------------------------------------------------------
  let recording = true, count = 0;
  const recorder = (async () => {
    while (recording) {
      const started = Date.now();
      await writeFile(join(frames, `frame-${String(count++).padStart(4, "0")}.png`), await screenshot());
      await pause(Math.max(0, 1000 / FPS - (Date.now() - started)));
    }
  })();
  const still = async (name) => writeFile(join(images, name), await screenshot());

  await pause(1500);
  await caption("1. Start the stopwatch");
  await pause(800);
  await click(".toggle");
  await pause(2500);
  await click(".lap");
  await pause(1200);

  await caption("2. Change the title in Emacs and save (C-x C-s): the page follows, the clock keeps running");
  await pause(600);
  await keys("\x13");                 // C-s
  await type('(h1 "');
  await keys("\r");
  await pause(400);
  await keys("\x1bd");                // M-d: the word "Stopwatch"
  await pause(400);
  await type("Lap timer");
  await pause(700);
  await keys("\x18\x13");             // C-x C-s
  await until("document.querySelector('#preview').contentDocument.querySelector('h1').textContent === 'Lap timer'", "the title changes");
  await pause(1000);
  await still("live-reload.png");
  await pause(1800);

  await caption("3. A typo: Emacs marks it while you type (Flymake), before anything is saved");
  await pause(600);
  await keys("\x13");
  await type("stopwatch-forma");
  await keys("\r");
  await pause(500);
  await keys("\x7f");                 // DEL: stopwatch-formt
  await pause(2200);
  await type("\x1bxflymake-show-buffer-diagnostics", 25);
  await keys("\r");
  await pause(2500);
  await still("diagnostics.png");
  await pause(1200);
  await caption("Fix it: the warning goes away");
  await type("a");
  await pause(2500);
  await keys("\x181");                // C-x 1
  await pause(800);

  await caption("4. The stylesheet too: C-x C-f style.css, change the colour, save");
  await pause(600);
  await keys("\x18\x06");             // C-x C-f
  await pause(400);
  await type("style.css");
  await keys("\r");
  await pause(700);
  await keys("\x13");
  await type(".time { color: ");
  await keys("\r");
  await pause(300);
  await keys("\x0b");                 // C-k
  await type("#ff6b6b; }");
  await pause(600);
  await keys("\x18\x13");
  await until("getComputedStyle(document.querySelector('#preview').contentDocument.querySelector('.time')).color === 'rgb(255, 107, 107)'", "the colour changes");
  await pause(1200);
  await click(".lap");
  await caption("No reload, no build: the application ran the whole time");
  await pause(3500);

  recording = false;
  await recorder;
  console.log(`${count} frames`);

  // ---- the GIF ----------------------------------------------------------------
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "frame-%04d.png"),
    "-vf", "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
    join(images, "demo.gif"),
  ]);
  console.log("doc/images/demo.gif, live-reload.png, diagnostics.png");
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  server.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
