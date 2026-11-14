// The tar reader, against archives made here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectFiles, readTar } from "../js/tar.js";

const encoder = new TextEncoder();

function entry(path, content, { type = "0", prefix = "" } = {}) {
  const header = new Uint8Array(512);
  const put = (offset, text) => header.set(encoder.encode(text), offset);
  const body = encoder.encode(content);
  put(0, path);
  put(100, "0000644");
  put(124, body.length.toString(8).padStart(11, "0"));
  header[156] = type.charCodeAt(0);
  put(257, "ustar");
  put(345, prefix);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return [header, padded];
}
function tar(...entries) {
  const blocks = [...entries.flat(), new Uint8Array(1024)];
  const bytes = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
  let offset = 0;
  for (const block of blocks) { bytes.set(block, offset); offset += block.length; }
  return bytes;
}

test("readTar returns the regular files with their content", () => {
  const files = readTar(tar(
    entry("home/user/", "", { type: "5" }),
    entry("home/user/a.txt", "hello"),
    entry("deep.el", "x".repeat(700), { prefix: "home/user/some/long/directory" }),
  ));
  assert.deepEqual([...files.keys()], ["home/user/a.txt", "home/user/some/long/directory/deep.el"]);
  assert.equal(new TextDecoder().decode(files.get("home/user/a.txt")), "hello");
  assert.equal(files.get("home/user/some/long/directory/deep.el").length, 700);
});

test("projectFiles takes one directory and leaves the editor's leftovers out", () => {
  const files = projectFiles(tar(
    entry("home/user/elisp-studio/app/app.el", "(message \"日本語\")"),
    entry("home/user/elisp-studio/app/style.css", "body {}"),
    entry("home/user/elisp-studio/app/app.el~", "old"),
    entry("home/user/elisp-studio/app/#app.el#", "autosave"),
    entry("home/user/elisp-studio/app/.#app.el", "lock"),
    entry("home/user/elisp-studio/app/app.elc", "compiled"),
    entry("home/user/elisp-studio/app/lib/util.el", "(provide 'util)"),
    entry("home/user/elisp-studio/other/app.el", "another project"),
    entry("home/user/notes.txt", "not a project"),
  ), "/home/user/elisp-studio/app");
  assert.deepEqual(Object.fromEntries(files), {
    "app.el": "(message \"日本語\")",
    "style.css": "body {}",
    "lib/util.el": "(provide 'util)",
  });
});

test("an empty or foreign archive has no project", () => {
  assert.equal(projectFiles(new Uint8Array(1024), "/home/user/elisp-studio/app").size, 0);
  assert.equal(projectFiles(tar(entry("home/user/x", "y")), "/home/user/elisp-studio/app").size, 0);
});
