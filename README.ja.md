# elisp-studio

Emacs Lisp の Web アプリケーションをブラウザの中で書き、リロードなしで変わるのを見ながら作る環境です。

公開ページ: <https://modeverv.github.io/elisp-studio/> （デスクトップの Chrome 用です。初回は Emacs 本体を約150MBダウンロードし、以後はブラウザが保持します）

[English](README.md)

![studio を使っているところ。Emacs でタイトル、コード、スタイルシートを編集している間も、ストップウォッチは動き続ける](doc/images/demo.gif)

*Emacs Lisp で書いたストップウォッチを、動かしたまま編集しています。Emacs でタイトルを書き換えて保存し、打ち間違いには入力した時点で Flymake が印を付け、スタイルシートの色を変えています。右の時計は一度も止まりません。（`tools/record-demo.mjs` で録画したものです。同じプロジェクトは [`?example=stopwatch`](https://modeverv.github.io/elisp-studio/?example=stopwatch) で試せます）*

```text
┌──────────────────────────────┬──────────────────────────────┐
│ GNU Emacs                    │ あなたのアプリケーション        │
│ app.el を編集                 │ Emacs Lisp が描画             │
│                              │                              │
│ 書き換えて C-x C-s            │ すぐに変わる                   │
│                              │ リロードなし、state はそのまま   │
└──────────────────────────────┴──────────────────────────────┘
```

左右のどちらも Emacs です。左は本物の GNU Emacs 30.2 で、WebAssembly としてページの中で動き（[wasmacs](https://github.com/modeverv/wasmacs)）、自分のファイルシステムを持っています。右がアプリケーションで、2つ目の Emacs がプロジェクトの Emacs Lisp を [elisp-react](https://github.com/modeverv/elisp-react) で評価してページを描画します。インストールもビルドも要りません。

## 試し方

1. ページを開きます。Emacs が `app.el` を開いた状態で起動し、隣にアプリケーションが表示されます。
2. カウンターを何回かクリックします。
3. Emacs で `app.el` の文字列（たとえば `"Count: %d"`）を書き換え、`C-x C-s` で保存します。
4. アプリケーションの表示が新しい文字列に変わります。カウンターの数はそのままです。

プロジェクトは Emacs のファイルシステムの `/home/user/elisp-studio/app` にあります。ブラウザが保持するので、次に開いたときも残っています。新しいプロジェクトは `template/` から作られます。アドレスに `?example=stopwatch` や `?example=sqlite` を付けると、`examples/` の該当するディレクトリから作られます。すでにあるプロジェクトが置き換えられることはありません（最初からやり直すには、Emacs の中でこのディレクトリを削除します）。これは wasmacs のページが使っているのと同じ `/home/user` なので、wasmacs を直接開いたときにもプロジェクトが見えます。ファイルは次のとおりです。

```text
index.html   ページ。<div id="app">、スタイルシート、<script type="text/emacs-lisp" src="app.el">
app.el       プログラム（elisp-react を使用）
style.css    スタイルシート
server.el    サーバー側（任意）。ページから /api/... へのリクエストに答える
```

`server.el` がなければ、プロジェクトはどこに置いても単独で動く静的サイトです。

ファイルを保存したときの動作:

| ファイル | 動作 |
|---|---|
| `index.html` が読み込んでいる `.el` | 動いているアプリケーションの中でコンパイルして評価します。定義し直されたコンポーネントは、今の state のまま再描画されます。 |
| `index.html` がリンクしているスタイルシート | その場で差し替えます。 |
| `index.html` | アプリケーションを起動し直します（state は初期化されます）。 |
| `server.el` | 動いているサーバーの中で評価します。サーバーのデータは保たれます。 |

Emacs でプロジェクトのファイルを開いているときに使えるキー:

| キー | |
|---|---|
| `C-x C-s` | 保存。上の表のとおりアプリケーションに反映されます。 |
| `C-M-x` | カーソル位置の定義を、保存せずに動いているアプリケーション（またはサーバー）へ送ります。 |
| `C-c C-p` | 公開。git でプロジェクトをコミットして push します（後述）。 |
| `C-M-i`、`M-.`、`C-h f` | 関数名の補完、定義へのジャンプ、説明の表示。Emacs 自身の関数、elisp-react の関数に加えて、プロジェクトで定義した関数も、定義しているファイルを保存すれば対象になります。入力中は ElDoc が引数を表示します。 |
| `M-g n`、`M-g p` | コンパイラが指摘した次／前の場所へ移動します。 |

![綴りを間違えた関数名にバッファ上で印が付き、診断の一覧にも表示される。ファイルはまだ保存していない](doc/images/diagnostics.png)

入力中は、バイトコンパイラが指摘するはずの箇所に Flymake が印を付けます。編集中の Emacs が、変更のたびに少し間をおいてバッファの内容をコンパイルします。保存も実行もしません。保存したファイルについてアプリケーション側の Emacs が言ったことも戻ってきます。エコーエリアに1行、コンパイラの警告とエラーが `*elisp-studio*` バッファに表示されます（compilation バッファなので `RET` でその場所へ飛べます）。

![C-x C-s のあと。右のタイトルが新しくなり、時計は動き続け、Emacs には「no reload, state kept」と表示される](doc/images/live-reload.png)

間違えてもアプリケーションは落ちません。新しいコードが読み込めなければ、エラーをアプリケーションの下に表示し、古いコードのまま動き続けます。無限ループを書いた場合はアプリケーションが止まりますが、止まるのはアプリケーションだけです。次に保存したときに studio が新しいアプリケーションを起動し、Emacs はそのまま編集を続けられます。「restart app」ボタンは、ファイルからアプリケーションを起動し直します。

## サーバー側

`server.el` があるプロジェクトにはサーバーがあります。このファイルは関数を1つ定義します。

```elisp
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/messages") (app-server-read "messages" '("Hello")))
    ...))
```

関数は Lisp のデータを返します。ページはそれを印字された形で受け取り、読み戻します。関数がエラーを起こすと、そのエラーがレスポンスになります。`(app-server-parameter "name")` で、リクエストの `?name=...` の値を取得できます。

サーバーがデータを保持する方法は2つあります。

- `app-server-read` と `app-server-write`：Lisp の値をファイルに保存します。
- `(app-server-database)`：SQLite のデータベースです。Emacs 自身の `sqlite-execute` と `sqlite-select` で使います。ドライバも別のプログラムも要りません。SQLite は Emacs の一部です。

```elisp
(let ((db (app-server-database)))
  (sqlite-execute db "CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
  (sqlite-execute db "INSERT INTO books (title) VALUES (?)" (list title))     ; SQL の文字列ではなくパラメータとして渡す
  (sqlite-select db "SELECT id, title FROM books WHERE title LIKE ?" (list (concat "%" search "%"))))
```

[`examples/sqlite`](examples/sqlite) は、この方法でデータを持つ読書リストです（[試す](https://modeverv.github.io/elisp-studio/?example=sqlite)）。studio の中では、データベースはサーバー役の Emacs のメモリ上のファイルで、studio がブラウザ（IndexedDB）に保存して次回に引き継ぎます。ネイティブの Emacs で動かすと `.data/app.db` というファイルになり、`sqlite3` コマンドでも開けます。

SQLite の同梱について：SQLite は[パブリックドメイン](https://www.sqlite.org/copyright.html)なので、配布に条件はありません。ブラウザで動く Emacs には、wasmacs がリンクしています（wasmacs の README の「同梱ソフトウェアとライセンス」を参照）。ネイティブの Emacs は、SQLite つきでビルドされていれば使えます。通常のパッケージはそうなっています（`(sqlite-available-p)` で確認できます）。このリポジトリにも、ダウンロードしたプロジェクトにも、SQLite 自体は含まれません。

studio の中では、サーバーはブラウザのタブの中の3つ目の Emacs です。アプリケーションから `/api/...` へのリクエストはタブの外に出ず、studio がその Emacs に渡します。`server.el` を保存すると、動いているサーバーが変わります。

同じプロジェクトを、ネイティブの Emacs を Web サーバーにして本番として動かせます。そのためのスクリプトは、ダウンロード（次の節）に入っています。

```sh
./run.sh            # http://127.0.0.1:8018/ を開く
```

プロジェクトのファイルを配信し、`/api/...` には同じ `server.el` で答えます。サーバーが保持するデータはプロジェクトの `.data/` に置かれます。ページの Emacs Lisp は、これまでどおり閲覧者のブラウザの中で動きます。

## プロジェクトを外に出す

- ヘッダーの **download .zip**：プロジェクトを1つのアーカイブにします。bash と GNU Emacs（29以降）があれば、それだけで動きます。

  ```text
  index.html, app.el, style.css, server.el    プロジェクト
  run.sh              ./run.sh [PORT]。Emacs がこのディレクトリの Web サーバーになる
  fetch-emacs.sh      任意。ブラウザ用の Emacs を vendor/ にダウンロードする（約160MB、curl が必要）
  server/             run.sh が Emacs に読み込ませるもの（HTTP サーバーと app-server.el）
  README.txt
  ```

  `./run.sh` を実行すると、Emacs がページを配信し、ページからのリクエストに答えます。ブラウザの中でページの `app.el` を動かす Emacs は、通常はページが wasmacs のサイトからダウンロードします。`./fetch-emacs.sh` を実行したあとは、同じ Emacs が `vendor/` から配信するようになり、インターネットは不要になります。
- Emacs の **`C-c C-p`**（`M-x elisp-studio-publish`）：Emacs の中で動く git で `git add`、`git commit` を行い、`origin` というリモートがあれば `git push` します。GitHub へ HTTPS で push するには、[wasmacs の companion 拡張](https://github.com/modeverv/wasmacs#network-access)と、リモートの認証情報が必要です（最初に1回、`M-x shell` で `cd ~/elisp-studio/app`、`git remote add origin https://github.com/YOU/REPOSITORY.git`）。`server.el` のないプロジェクトを GitHub Pages を有効にしたリポジトリに push すれば、そのまま Web に公開されます。

## 言語サーバー（LSP）は？

Emacs の LSP クライアントである Eglot は、この Emacs に入っていて読み込めます。足りないのは相手になる言語サーバーです。wasmacs の process service 向けにビルドされたプログラムである必要があり、今はありません。Emacs Lisp については言語サーバーは不要です。補完、説明、定義へのジャンプは Emacs 自身の機能で、診断は Emacs のバイトコンパイラから得ています。

## 仕組み

```text
studio のページ (js/studio.js)
  ├─ iframe: wasmacs（エディタ）             ../wasmacs/app/xterm-atomics-pdump.html?embed=1
  │     Emacs がファイルを保存 -> ページが /home/user の tar イメージを受け取る (postMessage)
  ├─ iframe: アプリケーション                 プロジェクトの index.html を srcdoc として表示
  │     elisp-react の土台と wasmacs の評価サービス（2つ目の Emacs）
  │     変更された .el -> app.load(name, text) -> 定義し直されたコンポーネントが再描画される
  └─ worker: サーバー                        評価サービスをもう1つ（3つ目の Emacs）。server.el を実行
        アプリケーションの fetch("/api/...") -> app-server-respond -> レスポンス
```

studio は、単独でも存在する2つのものをつなぐ配線にすぎません。エディタはファイルが変わるたびに中身を報告し、studio はそれをアプリケーションが持っているものと比べて、差分を渡します。詳しくは [doc/design.md](doc/design.md) を参照してください。

## 開発

studio は、同じオリジンに2つの兄弟サイトを必要とします。このリポジトリの隣に checkout（ビルド済みの `../wasmacs` と `../elisp-react`）がある状態で実行します。

```sh
npm run serve            # http://127.0.0.1:5190/elisp-studio/
npm run test:unit        # tar、zip、ネイティブの Emacs で配信したプロジェクト
npm run test:e2e         # headless Chrome で studio を操作
npm run test:e2e:plain   # 同じテストを、GitHub Pages と同じく分離ヘッダーなしで実行
npm run test:e2e:sqlite  # SQLite のサンプル。studio の中で動かし、ダウンロードして単独でも動かす
node tools/record-demo.mjs   # この README の画像を録画し直す（ffmpeg が必要）
```

## 制限

- デスクトップの Chrome が対象です。タブの中で Emacs が2つ動くので、メモリを数百MB使います。
- プロジェクトは1つです。
- ホットリロードのあと、既存のコンポーネントの `:initial-state` と `:did-mount` は実行し直されません。最初からやり直すには「restart app」を使います。
- アプリケーションの実行中に起きたエラーには、場所の情報がありません。
- 編集中の Emacs は、バッファを検査するときにプロジェクトのマクロを展開します。無限ループするマクロを書くと、エディタが固まります。
- GitHub への push は、Emacs 自身のファイルシステム内のリポジトリに対してだけテストしています。companion 拡張を通る経路は wasmacs のもので、そちらでテストされています。
- タブの中のサーバーは、データのディレクトリをメモリ上に持ちます。studio は、内容を変えたリクエストのあとでそれを IndexedDB にコピーします。小さなデータベースなら問題ありませんが、大きなものには向きません。
- `run.sh` は 127.0.0.1 でだけ待ち受けます。1つの Emacs がリクエストを1件ずつ順に処理します。
