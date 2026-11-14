// The ZIP writer: an archive it makes is read by the system's unzip.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crc32, createZip } from "../js/zip.js";

test("crc32 is the standard one", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("unzip extracts what createZip stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-zip-"));
  try {
    const files = new Map([
      ["index.html", "<!doctype html>\n<title>x</title>\n"],
      ["app.el", "(message \"日本語\")\n"],
      ["lib/data.bin", Uint8Array.from({ length: 1000 }, (_, i) => i % 256)],
      ["empty.txt", ""],
    ]);
    await writeFile(join(directory, "project.zip"), createZip(files));
    execFileSync("unzip", ["-q", "-t", "project.zip"], { cwd: directory });
    execFileSync("unzip", ["-q", "project.zip", "-d", "out"], { cwd: directory });
    assert.equal(await readFile(join(directory, "out/index.html"), "utf8"), files.get("index.html"));
    assert.equal(await readFile(join(directory, "out/app.el"), "utf8"), files.get("app.el"));
    assert.deepEqual(new Uint8Array(await readFile(join(directory, "out/lib/data.bin"))), files.get("lib/data.bin"));
    assert.equal((await readFile(join(directory, "out/empty.txt"))).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
