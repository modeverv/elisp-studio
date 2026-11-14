# elisp-studio

Emacs Lisp の Web アプリケーションをブラウザの中で書き、リロードなしで変わるのを見ながら作る環境です。

公開ページ: <https://modeverv.github.io/elisp-studio/> （デスクトップの Chrome 用です。初回は Emacs 本体を約150MBダウンロードし、以後はブラウザが保持します）

[English](README.md)

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

プロジェクトは Emacs のファイルシステムの `/home/user/elisp-studio/app` にあります。ブラウザが保持するので、次に開いたときも残っています。これは wasmacs のページが使っているのと同じ `/home/user` なので、wasmacs を直接開いたときにもプロジェクトが見えます。ファイルは次のとおりです。

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

入力中は、バイトコンパイラが指摘するはずの箇所に Flymake が印を付けます。編集中の Emacs が、変更のたびに少し間をおいてバッファの内容をコンパイルします。保存も実行もしません。保存したファイルについてアプリケーション側の Emacs が言ったことも戻ってきます。エコーエリアに1行、コンパイラの警告とエラーが `*elisp-studio*` バッファに表示されます（compilation バッファなので `RET` でその場所へ飛べます）。

間違えてもアプリケーションは落ちません。新しいコードが読み込めなければ、エラーをアプリケーションの下に表示し、古いコードのまま動き続けます。無限ループを書いた場合はアプリケーションが止まりますが、止まるのはアプリケーションだけです。次に保存したときに studio が新しいアプリケーションを起動し、Emacs はそのまま編集を続けられます。「restart app」ボタンは、ファイルからアプリケーションを起動し直します。

## サーバー側

`server.el` があるプロジェクトにはサーバーがあります。このファイルは関数を1つ定義します。

```elisp
(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/messages") (app-server-read "messages" '("Hello")))
    ...))
```

関数は Lisp のデータを返します。ページはそれを印字された形で受け取り、読み戻します。関数がエラーを起こすと、そのエラーがレスポンスになります。`app-server-read` と `app-server-write` で、リクエストをまたいで Lisp のデータを保持できます。

studio の中では、サーバーはブラウザのタブの中の3つ目の Emacs です。アプリケーションから `/api/...` へのリクエストはタブの外に出ず、studio がその Emacs に渡します。`server.el` を保存すると、動いているサーバーが変わります。

同じプロジェクトを、ネイティブの Emacs を Web サーバーにして本番として動かせます。

```sh
tools/serve-project.sh /path/to/the/project 8018     # http://127.0.0.1:8018/ を開く
```

プロジェクトのファイルを配信し、`/api/...` には同じ `server.el` で答えます。サーバーが保持するデータはプロジェクトの `.data/` に置かれます。ページの Emacs Lisp は、これまでどおり閲覧者のブラウザの中で動きます。

## プロジェクトを外に出す

- ヘッダーの **download .zip**：プロジェクトのファイルを1つのアーカイブにします。
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
```

## 制限

- デスクトップの Chrome が対象です。タブの中で Emacs が2つ動くので、メモリを数百MB使います。
- プロジェクトは1つです。
- ホットリロードのあと、既存のコンポーネントの `:initial-state` と `:did-mount` は実行し直されません。最初からやり直すには「restart app」を使います。
- アプリケーションの実行中に起きたエラーには、場所の情報がありません。
- 編集中の Emacs は、バッファを検査するときにプロジェクトのマクロを展開します。無限ループするマクロを書くと、エディタが固まります。
- GitHub への push は、Emacs 自身のファイルシステム内のリポジトリに対してだけテストしています。companion 拡張を通る経路は wasmacs のもので、そちらでテストされています。
- タブの中のサーバーは、データを `localStorage` に保存します。小さなデータ向けです。
