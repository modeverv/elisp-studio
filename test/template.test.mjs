// What a new project and the download come with for keeping and checking
// it (tools/project/): test/run.sh passes on the template (lint and its
// tests) and on the examples (lint), under a native Emacs, and fails on a
// warning.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// The libraries: this checkout's app-server.el, and elisp-react's from a
// checkout next to this one, else from where it is published.
const sibling = join(root, "../elisp-react/");
const environment = {
  ...process.env,
  ELISP_STUDIO_URL: pathToFileURL(root).href.replace(/\/?$/, "/"),
  ...(existsSync(join(sibling, "lisp/react-testing.el")) ? { ELISP_REACT_URL: pathToFileURL(sibling).href } : {}),
};
const run = (directory) => new Promise((resolve) => {
  execFile("bash", ["test/run.sh"], { cwd: directory, env: environment }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code : 0, output: stdout + stderr }));
});
async function project(source) {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-template-"));
  await cp(join(root, source), directory, { recursive: true });
  await mkdir(join(directory, "test"), { recursive: true });
  await cp(join(root, "tools/project/test/run.sh"), join(directory, "test/run.sh"));
  return directory;
}

test("test/run.sh: the template's files compile without a warning and its tests pass; a warning fails it", async () => {
  const directory = await project("template");
  try {
    const passed = await run(directory);
    assert.equal(passed.code, 0, passed.output);
    assert.match(passed.output, /lint: \.\/app\.el \.\/server\.el \.\/test\/app-test\.el/);
    assert.match(passed.output, /Ran 3 tests, 3 results as expected/);
    // A library of the project's own in vendor/ is on load-path, not checked.
    await mkdir(join(directory, "vendor/helper"), { recursive: true });
    await writeFile(join(directory, "vendor/helper/helper.el"), "(defun helper () (undefined-in-helper))\n(provide 'helper)\n");
    await writeFile(join(directory, "uses.el"), ";;; -*- lexical-binding: t; -*-\n(require 'helper)\n(defun uses () (helper))\n");
    const withLibrary = await run(directory);
    assert.equal(withLibrary.code, 0, withLibrary.output);
    await writeFile(join(directory, "uses.el"), ";;; -*- lexical-binding: t; -*-\n(defun uses () (no-such-function-anywhere))\n");
    const failed = await run(directory);
    assert.notEqual(failed.code, 0);
    assert.match(failed.output, /uses\.el:2:\d+: Error: the function .no-such-function-anywhere. is not known/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("test/run.sh: the examples' files compile without a warning", async () => {
  for (const example of ["stopwatch", "sqlite", "upload"]) {
    const directory = await project(`examples/${example}`);
    try {
      const result = await run(directory);
      assert.equal(result.code, 0, `${example}: ${result.output}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
