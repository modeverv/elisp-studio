// tools/serve-cgi.el: one request to /api/ answered by an Emacs that then
// ends, as a CGI program on a shared host; and the SQL that its server.el
// uses on SQLite or MySQL (lisp/app-server.el, app-server-sql-*).
//
// The MySQL tests run when APP_SERVER_TEST_MYSQL names an option file of a
// database they may fill (CI has one); otherwise they are skipped.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const emacs = execFileSync(join(root, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
const mysql = process.env.APP_SERVER_TEST_MYSQL || "";
const origin = "https://example.test";

function hasSqlite() {
  try {
    return execFileSync(emacs, ["--batch", "-Q", "--eval", "(princ (and (fboundp 'sqlite-available-p) (sqlite-available-p)))"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "t";
  } catch (_) {
    return false;
  }
}
const emacsHasSqlite = hasSqlite();

/** One request through serve-cgi.el: { status, headers (lower-case names), body }. */
function cgi(directory, data, method, path, { body = "", cookie, from = origin, host = "example.test", env = {} } = {}) {
  const [pathInfo, query] = path.split("?");
  // The body comes from a file, as from the pipe of a web server: Node's
  // own pipes are sockets on Linux, which /dev/stdin cannot open.
  const input = join(data, "..", `.body-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(input, body);
  const stdin = openSync(input, "r");
  return new Promise((resolve, reject) => {
    const child = spawn(emacs, ["--batch", "-Q", "-l", join(root, "tools/serve-cgi.el"), "-f", "serve-cgi-main"], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        APP_DIRECTORY: directory, APP_DATA: data, PUBLIC_ORIGIN: origin,
        HTTP_HOST: host, REMOTE_ADDR: "203.0.113.9", HTTPS: "on",
        REQUEST_METHOD: method, PATH_INFO: pathInfo, QUERY_STRING: query || "",
        CONTENT_LENGTH: String(Buffer.byteLength(body)),
        ...(from ? { HTTP_ORIGIN: from } : {}), ...(cookie ? { HTTP_COOKIE: cookie } : {}),
        ...env,
      },
      stdio: [stdin, "pipe", "pipe"],
    });
    closeSync(stdin);
    const chunks = [], errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      if (code !== 0 || split < 0) return reject(new Error(`serve-cgi ended with ${code}: ${text}`));
      const headers = {};
      let status = 0;
      for (const line of text.slice(0, split).split("\r\n")) {
        const colon = line.indexOf(": ");
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 2);
        if (name === "status") status = Number(value.split(" ")[0]);
        else headers[name] = headers[name] ? `${headers[name]}\n${value}` : value;
      }
      const stderr = Buffer.concat(errors).toString("utf8");
      // What Emacs said on its error output: the reason of a 500.
      if (status >= 500 && !env.EXPECT_FAILURE) console.error(`serve-cgi ${method} ${path} -> ${status}:\n${stderr}`);
      resolve({ status, headers, body: text.slice(split + 4), stderr });
    });
    child.on("close", () => rm(input, { force: true }));
  });
}

async function project(example) {
  const directory = await mkdtemp(join(tmpdir(), "elisp-studio-cgi-"));
  await cp(join(root, example), directory, { recursive: true });
  return { directory, data: join(directory, ".data") };
}

test("serve-cgi answers server.el's API with serve-project's checks and headers", async () => {
  const { directory, data } = await project("template");
  try {
    const got = await cgi(directory, data, "GET", "/api/messages");
    assert.equal(got.status, 200);
    assert.equal(got.body, '("Hello from the server\'s Emacs")');
    assert.equal(got.headers["content-type"], "application/x-emacs-lisp; charset=utf-8");
    for (const name of ["x-content-type-options", "x-frame-options", "content-security-policy", "referrer-policy"]) {
      assert.ok(got.headers[name], `${name} is sent`);
    }
    assert.equal(got.headers["cache-control"], "no-store");
    const posted = await cgi(directory, data, "POST", "/api/messages", { body: '"日本語 from a CGI"' });
    assert.equal(posted.status, 200);
    assert.match(posted.body, /日本語 from a CGI/);
    // What serve-project refuses, this refuses.
    assert.equal((await cgi(directory, data, "POST", "/api/messages", { body: '"x"', from: "https://elsewhere.example" })).status, 403);
    assert.equal((await cgi(directory, data, "GET", "/api/messages", { host: "elsewhere.example" })).status, 421);
    assert.equal((await cgi(directory, data, "GET", "/server.el")).status, 404);
    // One line per request in the log; server.el compiled once into the data directory.
    const log = await readFile(join(data, "requests.log"), "utf8");
    assert.match(log, /GET \/api\/messages 200 \d+ms/);
    assert.match(log, /POST \/api\/messages 403 \d+ms/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the SQL layer: parameters as hex literals, SELECTs as JSON rows (MySQL's form, no database)", () => {
  const out = execFileSync(emacs, ["--batch", "-Q", "-l", join(root, "lisp/app-server.el"), "--eval", `(progn
    (princ (app-server--mysql-bind "SELECT a FROM t WHERE x = ? AND y = '?' -- ?\n AND z = ? AND w = ?" (list "it's 日本" 3 nil)))
    (terpri)
    (princ (app-server--mysql-json-select "SELECT DISTINCT id, CAST(x AS CHAR) AS c, (SELECT 1 FROM u WHERE a IN (1, 2)) AS s FROM t WHERE a = ?"))
    (terpri)
    (princ (condition-case err (app-server--mysql-json-select "SELECT * FROM t") (app-server-sql-error (nth 2 err))))
    (terpri)
    (princ (condition-case err (app-server--mysql-bind "SELECT ? FROM t" nil) (app-server-sql-error (nth 2 err)))))`],
    { encoding: "utf8" }).split("\n");
  // "it's 日本" in UTF-8, as hex; the ? in quotes and in a comment stay.
  assert.equal(out[0], "SELECT a FROM t WHERE x = CONVERT(X'6974277320E697A5E69CAC' USING utf8mb4) AND y = '?' -- ?");
  assert.equal(out[1], " AND z = 3 AND w = NULL");
  assert.equal(out[2], "SELECT DISTINCT JSON_ARRAY(id, CAST(x AS CHAR), (SELECT 1 FROM u WHERE a IN (1, 2))) FROM t WHERE a = ?");
  assert.equal(out[3], "Name the columns, not *: SELECT * FROM t");
  assert.equal(out[4], "More ? than parameters in: SELECT ? FROM t");
});

/** The todos example's story, through the CGI front end, on the backend that ENV chooses. */
async function todosStory(env) {
  const { directory, data } = await project("examples/todos");
  const name = (who) => `${who}${process.pid}`;
  const ask = (method, path, body, cookie, more = {}) => cgi(directory, data, method, path, { body, cookie, env: { ...env, ...more } });
  const cookieOf = (answer) => answer.headers["set-cookie"].split(";")[0];
  try {
    assert.deepEqual([(await ask("GET", "/api/me")).body], ["nil"]);
    assert.equal((await ask("POST", "/api/signup", `("${name("a")}" "short")`)).status, 400);
    const a = await ask("POST", "/api/signup", `("${name("a")}" "correct horse battery")`);
    assert.equal(a.status, 200);
    assert.match(a.headers["set-cookie"], /HttpOnly; Secure; SameSite=Lax/);
    const alice = cookieOf(a);
    assert.equal((await ask("POST", "/api/signup", `("${name("a")}" "another password")`)).status, 409);
    const added = await ask("POST", "/api/todos", '"牛乳 & eggs"', alice);
    assert.match(added.body, /^\(\(:id \d+ :title "牛乳 & eggs" :done nil\)\)$/);
    const id = Number(added.body.match(/:id (\d+)/)[1]);
    const bob = cookieOf(await ask("POST", "/api/signup", `("${name("b")}" "battery staple b")`));
    // Bob cannot reach Alice's todo.
    assert.equal((await ask("POST", "/api/todos/toggle", String(id), bob)).body, "nil");
    assert.match((await ask("GET", "/api/todos", "", alice)).body, /:done nil/);
    assert.match((await ask("POST", "/api/todos/toggle", String(id), alice)).body, /:done t/);
    assert.equal((await ask("POST", "/api/todos/clear", "", alice)).body, "nil");
    assert.equal((await ask("GET", "/api/todos")).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await ask("POST", "/api/signin", `("${name("a")}" "wrong")`)).status, 401);
    assert.equal((await ask("POST", "/api/signin", `("${name("a")}" "correct horse battery")`)).status, 429);
    // The failures count for the account and for the address they came from.
    assert.equal((await ask("POST", "/api/signin", `("${name("b")}" "battery staple b")`)).status, 429);
    assert.equal((await ask("POST", "/api/signin", `("${name("b")}" "battery staple b")`, undefined,
                            { REMOTE_ADDR: "198.51.100.7" })).status, 200);
    await ask("POST", "/api/signout", "", alice);
    assert.equal((await ask("GET", "/api/me", "", alice)).body, "nil");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the todos example through serve-cgi on SQLite: accounts, each one's todos, limits",
  { skip: !emacsHasSqlite && "this Emacs has no SQLite" }, () => todosStory({}));

test("the todos example through serve-cgi on MySQL", { skip: !mysql && "APP_SERVER_TEST_MYSQL is not set" }, async () => {
  execFileSync("mysql", [`--defaults-extra-file=${mysql}`, "-e",
    "DROP TABLE IF EXISTS todo_items, todo_users, app_server_sessions, app_server_attempts"]);
  await todosStory({ APP_MYSQL: mysql });
});

test("app-server-sql on MySQL: values, errors, transactions, and a process killed in one",
  { skip: !mysql && "APP_SERVER_TEST_MYSQL is not set" }, () => {
    const run = (forms) => execFileSync(emacs, ["--batch", "-Q", "-l", join(root, "lisp/app-server.el"),
      "--eval", `(setq app-server-mysql ${JSON.stringify(mysql)})`, "--eval", forms], { encoding: "utf8" });
    const out = run(`(progn
      (app-server-sql-execute "DROP TABLE IF EXISTS sql_test")
      (app-server-sql-execute "CREATE TABLE sql_test (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL UNIQUE, note TEXT, n DOUBLE)")
      (prin1 (list
        (app-server-sql-insert "INSERT INTO sql_test (name, note, n) VALUES (?, ?, ?)" (list "a" "' \\" \\\\ ; -- 日本 🍣\\n\\t" 1.5))
        (app-server-sql-insert "INSERT INTO sql_test (name) VALUES (?)" (list "b"))
        (app-server-sql-select "SELECT id, name, note, n FROM sql_test ORDER BY id")
        (app-server-sql-execute "UPDATE sql_test SET n = 2 WHERE name IN (?, ?)" (list "a" "b"))
        (condition-case err (app-server-sql-insert "INSERT INTO sql_test (name) VALUES (?)" (list "a")) (app-server-sql-error (nth 1 err)))
        (condition-case nil (app-server-sql-transaction (app-server-sql-insert "INSERT INTO sql_test (name) VALUES (?)" (list "c")) (error "no")) (error nil))
        (app-server-sql-select "SELECT COUNT(*) FROM sql_test WHERE name = ?" (list "c")))))`);
    assert.equal(out, '(1 2 ((1 "a" "\' \\" \\\\ ; -- 日本 🍣\n\t" 1.5) (2 "b" nil nil)) 2 1062 nil ((0)))');
    // The process ends in the middle of a transaction: nothing of it stays.
    assert.throws(() => run(`(app-server-sql-transaction
                               (app-server-sql-insert "INSERT INTO sql_test (name) VALUES (?)" (list "killed"))
                               (signal-process (emacs-pid) 'KILL))`));
    assert.equal(run(`(prin1 (app-server-sql-select "SELECT COUNT(*) FROM sql_test WHERE name = ?" (list "killed")))`), "((0))");
  });
