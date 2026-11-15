# elisp-studio

Emacs Lisp の Web アプリケーションをブラウザの中で書き、リロードなしで変わるのを見ながら作る環境です。

公開ページ: <https://modeverv.github.io/elisp-studio/> （デスクトップの Chrome 用です。初回はエディタ用の Emacs を約150MBダウンロードし、以後はブラウザが保持します。ここで作ったアプリケーションは別で、訪問者がダウンロードするのは約5MBです）

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

プロジェクトは Emacs のファイルシステムの `/home/user/elisp-studio/app` にあります。ブラウザが保持するので、次に開いたときも残っています。新しいプロジェクトは `template/` から作られます。アドレスに `?example=stopwatch`、`?example=sqlite`、`?example=upload` のいずれかを付けると、`examples/` の該当するディレクトリから作られます。すでにあるプロジェクトが置き換えられることはありません（最初からやり直すには、Emacs の中でこのディレクトリを削除します）。これは wasmacs のページが使っているのと同じ `/home/user` なので、wasmacs を直接開いたときにもプロジェクトが見えます。ファイルは次のとおりです。

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

関数は Lisp のデータを返します。ページはそれを印字された形で受け取り、読み戻します。関数がエラーを起こすと、そのエラーがレスポンスになります。3つの引数のほかに、次のものが使えます。

- `(app-server-data body)`：本文を Lisp のデータとして読みます。`read` ではなく、これを使ってください。Emacs のリーダーは、初めて見る名前をすべてシンボルとして保持し続けるので、閲覧者が名前を大量に送るだけでサーバーのメモリを埋められます。`app-server-data` が通すのは、文字列、数値、リスト、ベクタ、そしてこの Emacs がすでに知っているシンボルだけです。閲覧者が送ったものが評価されることはありません。
- `(app-server-parameter "name")`：リクエストの `?name=...` の値。
- `(app-server-header "name")`、`(app-server-cookie "name")`：リクエストに付いてきたヘッダーと Cookie。
- `(app-server-set-header "Name" "value")`、`(app-server-set-cookie "name" "value" :max-age 3600)`、`(app-server-delete-cookie "name")`：応答に付けるもの。Cookie は、指定しないかぎり、ページのスクリプトからは見えず、`SameSite=Lax` で、閲覧者が HTTPS で来た場合は `Secure` になります。
- `(app-server-refuse "Sign in first" 401)`：そのメッセージとステータスで断ります。
- `(app-server-token)`：推測できないランダムな名前。セッションに使います。

ログインは、これらを組み合わせて作ります。全体は、下の「ログイン」の節にあります。

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

SQLite の同梱について：SQLite は[パブリックドメイン](https://www.sqlite.org/copyright.html)なので、配布に条件はありません。ブラウザで動く Emacs には、wasmacs がリンクしています（wasmacs の README の「ライセンス」を参照）。ネイティブの Emacs は、SQLite つきでビルドされていれば使えます。通常のパッケージはそうなっています（`(sqlite-available-p)` で確認できます）。このリポジトリにも、ダウンロードしたプロジェクトにも、SQLite 自体は含まれません。

studio の中では、サーバーはブラウザのタブの中の3つ目の Emacs です。アプリケーションから `/api/...` へのリクエストはタブの外に出ず、studio がその Emacs に渡します。`server.el` を保存すると、動いているサーバーが変わります。

同じプロジェクトを、ネイティブの Emacs を Web サーバーにして本番として動かせます。そのためのスクリプトは、ダウンロード（次の節）に入っています。

```sh
./run.sh            # http://127.0.0.1:8018/ を開く
```

プロジェクトのファイルを配信し、`/api/...` には同じ `server.el` で答えます。サーバーが保持するデータはプロジェクトの `.data/` に置かれます。ページの Emacs Lisp は、これまでどおり閲覧者のブラウザの中で動きます。

### あとで応答する

何かを待つ必要があるハンドラが、他のリクエストまで待たせる必要はありません。ハンドラは `app-server-defer` を返します。リクエストは開いたままになり、サーバーは他のリクエストの処理に進み、`respond` が呼ばれた時点で応答が送られます。

```elisp
('("GET" "/api/rates")
 (app-server-defer
  (lambda (respond fail)
    (app-server-fetch "https://example.com/rates.json"
                      :then (lambda (response)
                              (if (plist-get response :ok)
                                  (funcall respond (plist-get response :text))
                                (funcall fail "The rates are not available")))))))
```

待てるものは3つあり、どれもサーバーを止めません。

- `(app-server-fetch URL :method :headers :body :then :catch)`：他のサーバーへの HTTP リクエスト。
- `(app-server-after 秒数 関数)`：一定の時間。
- `(app-server-run '("program" "argument") :input 文字列 :then 関数)`：プログラム。たとえば、長い計算を任せる2つ目の Emacs です。関数は `(:status 0 :output "...")` を受け取ります。コマンドはシェルを通りません。

`(funcall fail メッセージ [ステータス])` はリクエストを断ります。あとで動く関数の中のエラーも同じ扱いになり、`app-server-deferred-timeout`（30秒）以内に応答されなかったリクエストには 504 が返ります。同じ `server.el` がスタジオの中でも動きます。そこでは、サーバーの Emacs の代わりにページが時間を計り、リクエストを送ります（したがって、他のサイトへのリクエストにはブラウザの制限がかかります）。プログラムを実行できるのは、ネイティブの Emacs だけです。

計算は「待ち」ではありません。実行中の Emacs Lisp と SQLite は、これまでどおり1つのスレッドを占有します。そのための手段が `app-server-run` です。

### 閲覧者からのファイル

リクエストの本文はハンドラが受け取るテキストで、上限は 1 MB です。ファイルは別扱いです。サーバーは、届いた分から順にディスクへ書き込み、ハンドラにはその名前を渡します。大きさに上限はありません。どのリクエストがファイルを運ぶのかは `server.el` が決めます。判断の材料はヘッダーだけで、ファイルを1バイトも受け取る前に決まります。

```elisp
(defun app-server-upload-p (method path size)
  (and (equal path "/api/photos")
       (app-visitor)                                   ; ログイン済みか（違えば 401 で断る）
       (or (< size (* 200 1024 1024)) (app-server-refuse "Too large" 413))))

('("POST" "/api/photos")
 (let ((name (concat (app-server-token 8) ".jpg")))
   (app-server-keep-upload name)                       ; これで (app-server-file name) になる
   name))
('("GET" "/api/photo")
 (app-server-send-file (app-server-file (app-server-parameter "name")) :type "image/jpeg"))
```

`(app-server-upload)` は `(:file FILE :size BYTES :type STRING)` を返します。FILE は一時ファイルで、ハンドラが保存しなければ、応答とともに消えます。`(app-server-file NAME)` は、アプリケーションが保存しているファイル（`.data/files/`）のうちの1つです。NAME でそれ以外の場所を指すことはできません。`(app-server-files)` はその一覧を返し、`(app-server-send-file FILE :type :name)` はファイルを少しずつ読みながら応答として送ります。

ページは、フォームではなく、ファイルそのものを本文として送ります。elisp-react では `react-fetch` のオプション1つです。ファイルは Lisp を通らず、ファイル入力からサーバーへ直接送られます。

```elisp
(input (:type "file" :ref "file"
        :on-change (lambda (event) (react-set-state self :chosen (aref (plist-get event :files) 0)))))
...
(react-fetch "/api/photos" :method "POST" :file (react-ref self "file") :then ...)
```

[`examples/upload`](examples/upload) は、これで作ったファイル置き場です（[試す](https://modeverv.github.io/elisp-studio/?example=upload)）。計測では、300 MB が 1.2 秒で届き（毎秒 240 MB）、その間のサーバーのメモリ増加は 30 MB でした。同じファイルは 0.8 秒で戻り、チェックサムも一致しました。その間も、2人が低速でダウンロードしている間も、他のリクエストへの応答速度は変わりませんでした。studio のタブの中では、ファイルは base64 で運ばれてメモリに置かれます。上限は 32 MB で、アップロードを試すには十分です。

### ログイン

```elisp
('("POST" "/api/login")
 (let* ((sent (app-server-data body)) (name (car sent)) (password (cadr sent))
        (address (app-server-visitor-address)))
   (app-server-attempts-check name address)             ; 10分間に5回失敗していたら 429
   (app-server-defer
    (lambda (respond fail)
      (app-server-password-check-later
       password (app-stored-hash name)
       (lambda (right)
         (if (not right)
             (progn (app-server-attempts-failed name address)
                    (funcall fail "Wrong name or password" 401))
           (app-server-attempts-clear name)
           (app-server-session-start name)              ; Cookie を発行する（30日間）
           (funcall respond t))))))))
('("GET" "/api/me") (or (app-server-session) (app-server-refuse "Sign in first" 401)))
('("POST" "/api/logout") (app-server-session-end) t)
```

- **セッション**：`(app-server-session-start VISITOR)` は、セッションのランダムな名前を Cookie としてブラウザに渡します。サーバーが保存するのは、その名前のハッシュと、VISITOR（名前、番号、plist など任意の Lisp データ）と、期限です。データベースには、それだけでログインできてしまう情報が残りません。以後のリクエストでは、`(app-server-session)` が VISITOR を返します（ログインしていなければ nil）。`(app-server-session-end)` でログアウトします。`(app-server-session-end-all VISITOR)` は、その人のセッションをすべての端末で終了させます。パスワードを変更したときに使います。Cookie は `HttpOnly`（ページの Lisp からもスクリプトからも見えません）、`SameSite=Lax` で、プロキシが HTTPS 経由だと伝えてきたときは `Secure` も付きます。セッションは、始めてから30日で終わります（`app-server-session-days`、または第2引数の日数）。使っても期限は延びません。
- **試行回数の制限**：`(app-server-attempts-check NAME ADDRESS ...)` は、引数のどれかについて10分間に5回の失敗があると、429 と `Retry-After` で断ります（`app-server-attempts-max`、`app-server-attempts-seconds`）。`-failed` で失敗を記録し、`-clear` で消します。アカウント単位で数えると、多数のアドレスから1つのアカウントを狙う総当たりが止まります。アドレス単位で数えると、1つのアドレスから多数のアカウントを試す行為が止まります。`(app-server-visitor-address)` は、リバースプロキシが伝えてきたアドレスです。プロキシがない場合は全員がこのマシンに見えるので、アカウント単位の制限だけが効きます。
- **短いパスワード**：`app-server-password-min-length`（8文字）より短いパスワードは、ハッシュを作る時点で断ります。短いパスワードは、どんなハッシュでも守れないためです。
- **古いハッシュ**：回数を増やしたあとや方式を変えたあとは、`(app-server-password-needs-rehash-p HASH)` で、作り直すべきハッシュかどうかが分かります。作り直せるのは、パスワードが手元にある瞬間、つまり照合に成功した直後です。
- **存在する名前を教えない**：存在しないアカウントの照合にも、存在するアカウントの照合と同じ時間をかけます。

セッションと失敗の記録は、専用の SQLite データベース `.data/server.db` に入ります。ワーカー間で共有され、再起動しても誰もログアウトされません。SQLite のない Emacs では、代わりにメモリに持ちます。その場合は、再起動すると全員がログアウトされ、ワーカー間でも共有されません。

利用者がすでに別の場所にアカウントを持っているアプリケーションでは、これらは不要です。ログインはプロキシに任せ（Caddy の `forward_auth` や `basic_auth`、nginx の手前に置く oauth2-proxy など）、誰が来たかは、プロキシが付けるヘッダーから `(app-server-header "x-forwarded-user")` のように読み取ります（ヘッダー名はプロキシによります）。プロキシが、そのヘッダーをすべてのリクエストで上書きするように設定してください。そうしないと、閲覧者が自分でそのヘッダーを付けられます。

### トークン（JWT）

セッションは、誰がログインしたかをサーバーが覚えておく方式です。JWT はその逆で、署名つきの情報を閲覧者が持ち歩き、サーバーは何も覚えません。このサーバーにあるのはセッションで、JWT のための関数はありません。JWT について何ができるかは 2026-11-15 に試しました。試した内容は同梱しておらず、テストの対象でもありません。

| | |
|---|---|
| アプリケーション自身が署名し、自身で検証するトークン（HS256：秘密の鍵による HMAC-SHA-256） | `server.el` に30行足らずで書けます。使うのは、どの Emacs にもある `secure-hash`、`base64url-encode-string`、`json-serialize`、`json-parse-string` です。HMAC は `secure-hash` の上に6行で書けます。同じコードで、ネイティブの Emacs 31.1 とブラウザの Emacs 30.2 が、既知のトークンを検証し、鍵の違うもの、`alg: none`、期限切れを拒否しました。検証は未コンパイルで1回0.1ミリ秒です。 |
| 受け渡し | ページは `react-fetch` の `:headers (:authorization "Bearer …")` で送り、`server.el` は `(app-server-header "authorization")` で読みます。Chrome からネイティブのサーバーに対して試しました。studio のタブでも、このヘッダーは同じように `server.el` に届きます（ブラウザテストで確かめています）。 |
| ほかの誰かが署名したトークン（RS256、ES256：Google、Microsoft Entra ID など、OpenID Connect の提供者） | 検証できません。公開鍵による署名の検証が必要ですが、Emacs にはそのための関数がありません。ネイティブのサーバーなら `openssl` などのプログラムを呼ぶことになります（試していません）。ブラウザの Emacs には、呼べるプログラムがありません。こうした提供者によるログインは、プロキシに任せます（上の段落）。 |

アプリケーション自身のログインには、セッションのほうが向いています。ログアウトはその場で効き、必要ならすべての端末で効きます。署名つきのトークンは、期限が来るまで有効です。取り消したトークンの一覧をサーバーが持てば止められますが、それはセッションと同じことです。トークンで省けるのはワーカー間で共有する保存場所ですが、それはすでにあります。トークンが役に立つのは、このサーバーに問い合わせずに、別のプログラムが利用者を確かめる必要があるときです。HS256 では、そのプログラムにも同じ鍵が必要です。

書くときの注意：受け付けるアルゴリズムは1つに決め、トークンが名乗るアルゴリズムには従いません。`exp` を確かめます。2つの署名は、最初の違いで止まらない方法で比べます（両方の `secure-hash` を比べます）。鍵は、配信されない `.data/` か環境変数に置き、すべてのワーカーで同じものを使います（鍵を変えると、すべてのトークンが無効になります）。トークンがあっても、他サイトのページから API は使えません。そのリクエストは何を持っていても断られます。CORS の事前確認（preflight）も 403 で断ります。

### パスワード

パスワードそのものは保存しません。保存するのは、計算に時間のかかるハッシュです。データベースが盗まれても、毎秒10億回の速さでパスワードを探されないようにするためです。`server.el` はハッシュの作成（`app-server-password-hash-later`）と照合（上の `app-server-password-check-later`）を頼むだけで、計算がどこで行われるかを意識しません。

`(app-server-password-hash-later PASSWORD FUNCTION)` は、保存するハッシュを作ります。誰が計算するかは、サーバーがどこで動いているかで決まります。

| 動かす場所 | 計算するもの | 60万回の所要時間 |
|---|---|---|
| `python3` のあるマシンのネイティブ Emacs | 別プロセス。Python の `hashlib`（中身は OpenSSL の C 実装） | ログイン1回あたり 0.11 秒 |
| `python3` のないマシンのネイティブ Emacs | 2つ目の Emacs。`secure-hash` の上に書いた30行の Lisp | 2.2 秒 |
| studio のブラウザのタブ | ページ。ブラウザの Web Crypto | 0.07 秒 |

方式は、HMAC-SHA-256 による PBKDF2 の60万回（OWASP がこの方式に示している回数）です。3つのどれでも計算できる方式を選んでいます。3つは同じバイト列を返します。テストでは、Node.js の結果と RFC 7914 のテストベクトルに照らして確認しています。そのため、どれか1つが作ったハッシュは、他のどれでも照合できます。サーバーが待つことはありません。32件のログインが同時に来ている間も、他のリクエストは毎秒18,000件で処理されます。同時に計算するハッシュの数はコア数まで（`app-server-password-jobs`）で、残りは順番を待ちます。このマシンでは毎秒74件のログインを処理できます。誰が計算するかは、起動時にサーバーのログに出ます。

時間に加えてメモリも攻撃者に使わせるハッシュにするには、`server.el` に1行書きます。

```elisp
(setq app-server-password-algorithm 'scrypt)       ; N = 2^17, r = 8, p = 1：ログイン1回あたり 128 MB、0.34 秒
```

scrypt を計算できるのは `python3` だけで、それも `hashlib` が scrypt を持っている場合に限ります（macOS に付属のものは持っていません。Homebrew のものや Linux ディストリビューションのものは持っています）。持っていない環境と studio のタブでは、弱い方式に切り替えることはせず、「This server cannot make scrypt hashes」というエラーでリクエストが失敗します。ハッシュには作り方が書いてあるので（`pbkdf2-sha256$600000$SALT$HASH`、`scrypt$ln=17,r=8,p=1$SALT$HASH`）、設定を変えても既存のハッシュは有効なままです。どちらの形式も、同じ `app-server-password-check-later` で照合します。

bcrypt や Argon2 を使っていない理由：Python の標準ライブラリにもブラウザにもなく、探した範囲では Emacs Lisp で書かれたものも見つかりませんでした。見つかったのは、[kaesar-pbkdf2.el](https://github.com/mhayashi1120/Emacs-kaesar)（Lisp で書かれた PBKDF2、GPL）、[pg-el](https://github.com/emarsden/pg-el) の中の PBKDF2（GnuTLS 経由、PostgreSQL の SCRAM 認証用）、そしてモジュールとしてコンパイルが必要な libsodium のバインディング2つ（`crypto_box` だけを公開している [sodium.el](https://github.com/dakra/sodium.el) と、Rust で書かれた [esodium](https://codeberg.org/coopi/emacs-esodium)）です。数文字のパスワードは、どの方式でも弱いままです。

### 公開する

サーバーは 127.0.0.1 で待ち受け、暗号化しない HTTP を話します。アプリケーションをインターネットに出すときは、同じマシンでリバースプロキシを手前に置きます。HTTPS、HTTP/2、圧縮は Caddy か nginx が担当し、残りを Emacs が担当します（`vendor/` に置いたブラウザ用の Emacs は、圧縮済みのものを Emacs が送ります。「プロジェクトを取り出す」を参照）。サーバーには、公開されるアドレスを伝えます。

```sh
PUBLIC_ORIGIN=https://example.com ./run.sh
```

ダウンロードした ZIP の `server/deploy/` に設定が入っています。`Caddyfile`（4行）、`nginx.conf`、そして `run.sh` を動かし続ける systemd のユニットです。この構成のためにサーバーが行うことは次のとおりです。

| | |
|---|---|
| 公開オリジン | 他のサイトのページからの `/api/` へのリクエストは断ります。どのページが自分のアプリケーションのものかを `PUBLIC_ORIGIN` で伝えます。 |
| 閲覧者が誰か | `(app-server-header "x-forwarded-for")` と `"x-forwarded-proto"` はプロキシからの情報です。サーバーに届くのはこのマシンからの接続だけなので、信用できます。同梱の設定はどちらも、閲覧者が自分で付けたこれらのヘッダーを上書きします。 |
| Cookie とログイン | 上記のとおりです。オリジンの確認と `SameSite=Lax` により、他のサイトからのリクエストでは使えません。 |
| 接続の維持 | プロキシからの接続は、リクエストの間も開いたままです。先に送られたリクエストには、順番に応答します。 |
| 上限 | 本文は 1 MB まで（`serve-project-max-body`）、ヘッダーは 16 KB まで、接続は 512 本まで。長さの指定がない本文は断ります（nginx と Caddy は長さを付けて転送します）。ヘッダーが二通りに読めるリクエストも断ります。 |
| サーバー自身の名前 | `Host` がサーバー自身のアドレスでも公開アドレスでもないリクエストは断ります（421）。よそのページが自分のドメインをこのサーバーに向けて内容を読み取る、ということができません。 |
| 遅い、または黙っている接続 | 途中まで送られたリクエストは20秒、一度も何も送ってこない接続も20秒で切ります。リクエストの合間に休んでいる接続は180秒です（プロキシが接続を保つ時間より長くしてあります）。 |
| ファイル | `ETag` を付けて送り、変わっていないファイルには `304` で応答します。`server.el`、`server/`、`.data/`、隠しファイル、`*.sh`、およびシンボリックリンクでプロジェクトの外に出るものは送りません。すべての応答に、他のサイトのフレーム内に表示させない指定を付けます。 |
| ブラウザ用の Emacs | `vendor/` がある場合（`./fetch-emacs.sh` のあと）、同梱の設定では、プロキシが `/vendor/` を自分で送ります。設定の中のアプリケーションのディレクトリ（`/srv/app`）を合わせてください。Emacs は大きな応答を1つずつ送るので、この 5MB を Emacs が送る場合、同じ1秒に来る訪問者は20〜30人ほどが限度です。Caddy や nginx が送る場合は、100人が同時に来ても全員がファイルを受け取れました。 |
| 途中で切断する訪問者 | 応答の途中で接続が切れても、終わるのはその応答だけです。これは `run.sh` が保証しています。`run.sh` は SIGPIPE を無視する設定で Emacs を起動します（バッチモードの Emacs は自分ではそうしません）。サーバーは `run.sh` で起動し、`emacs --batch` を直接使わないでください。 |
| 大きな応答 | 1つずつ送ります。大きなファイルを要求して読まない訪問者は、枠を占有します。そういう訪問者が32人を超えると、ほかの訪問者は `503` を受け取ります。訪問者が次の 256KB を受け取るまでの猶予は30秒で（`serve-project-send-timeout`）、過ぎると接続を切ります。そのため、この状態が続くのは、誰かが続けている間だけです。nginx は応答を訪問者より先に読み取るので、サーバーをこの状況から守ります。Caddy は守りません。プロキシが自分で送るもの（`/vendor/`）は影響を受けません。 |
| ログ | 標準エラー出力に、リクエストごとに1行（メソッド、パス、ステータス、ミリ秒）。 |
| 複数のコア | `WORKERS=4 ./run.sh` で、4つの Emacs プロセスが4つのポートで起動し、プロキシがリクエストを振り分けます（方法は同梱の設定に書いてあります）。プロセスは `.data/` を共有します。SQLite は先行書き込みログ（WAL）に切り替わり、使用中のデータベースを待ちます。`app-server-write` はファイルを一度に置き換えます。ハンドラが Lisp の変数に持たせたものは、1つのワーカーしか知りません。セッションはデータベースに置いてください。ワーカーが1つ終了すると、スクリプトが全ワーカーを終了させ、systemd がまとめて起動し直します。 |
| アップロード | Caddy は、どの大きさの本文も届いた分から転送します。nginx では、同梱ファイルの `client_max_body_size` が上限です。 |
| バックアップ | `./backup.sh` は、サーバーを動かしたまま `.data/` をコピーします。データベースは SQLite 自身がコピーするので（`VACUUM INTO`）、書き込みの最中でも完全な状態のものが得られます。 |

同梱の設定を使い、Caddy 2.11（HTTPS、HTTP/2）と nginx 1.30 を手前に置いて確認しました。ページ、ログイン、あとからの応答、圧縮、`304` がすべて通ります。300 MB のファイルは、どちらを経由しても、送って取り戻した内容が一致しました（送り先は4つのワーカーで、送ったあとは全ワーカーからそのファイルが見えます）。Caddy 経由の2万リクエストの負荷（毎秒2万2千件）で失敗はありませんでした。6分間の混合負荷（250万リクエスト、うち SQLite への挿入が37万件）はエラーなしで終わりました。2回目の計測では、ガベージコレクション後に生きている Lisp オブジェクトの数が、どの種類の負荷のあとも開始時と同じでした（Lisp 側のリークはありません）。プロセスのメモリは 59 MB から 105 MB まで増え、そこで止まりました。確認したのは15分間であり、数週間ではありません。systemd のユニットは実行していません。`vendor/` に置いたブラウザ用の Emacs は、2026-11-15 に両方を経由して確認しました（Caddy 2.11、nginx 1.30、暗号化なしの HTTP）。Emacs が送る形と、現在の同梱設定のようにプロキシ自身が送る形の両方です。どちらの形でも、Chrome は Lisp ファイルを一部分ずつ読み、あとから `require` したライブラリ（`calc`）も届きます。初回のダウンロードは 4.8MB でした（圧縮済みのコピーがない場合は 16.9MB。Emacs が圧縮なしで送っていたときは、Caddy 経由で 14.3MB、nginx 経由で 14.4MB）。プロキシが `/vendor/` を送る形では、同時に100件の初回訪問（1,700リクエスト）がすべてのファイルを受け取りました。Emacs が送る形では、直接なら30件までは全員が受け取りました（サーバーの起動直後は、20件でも一部が失敗しました）。プロキシ経由では20件で一部が失敗しました。Chrome 157、Firefox 160、Safari 27.0、iPhone シミュレーター（iOS 26.5 と 27.0）の Safari で、プロジェクト自身のコピーからと公開サイトからの両方でテンプレートを動かしました。どれも必要なファイルだけを取得し、2回目はブラウザのキャッシュから起動しました。

[doc/security.md](doc/security.md)（英語）は、このサーバーのセキュリティ検査の記録です。OWASP ZAP、手作りの約100件のリクエスト、独立したコード監査で調べ、重大な問題2件と軽微な問題9件を見つけて修正しました。そのままにしたものも書いてあります。要点は次のとおりです。以前は、リクエスト1つで、送信者が選んだマシンへの SSH 接続をサーバーに開かせることができ、また閲覧者がサーバーのメモリを埋めることができました。どちらも現在はできず、再発するとテストが失敗します。

ないもの：ストリーミング応答と WebSocket、トークンのための関数と他サイトのページへの応答（上の「トークン」）、フォームによるアップロード（`multipart/form-data`。ページはファイルそのものを送ります）、ハンドラが送るファイルの一部分だけの送信（アップロードされた動画の途中からの再生はできません。プロジェクト自身のファイルは、一部分だけを要求できます）。このサーバーを本気で攻撃した人はまだいません。プロキシの後ろに置く数百行の Emacs Lisp であり、身内向けのアプリケーションのためのものです。

### このサーバーの速さ

1つの Emacs、1つのスレッドで、Node.js と同じ動き方をします。接続は OS の中で待ち、Emacs はリクエストを1つ受け取り、ハンドラを最後まで実行し、応答して、次を受け取ります。`server.el` とサーバー自身は、起動時にバイトコンパイルされます。Apple M4 Max、Emacs 31.1 で、ApacheBench を使って同時10接続で計測した結果です（`ab -n 10000 -c 10`。`-k` を付けると、プロキシと同じように接続を維持します）。

| リクエスト | 毎回新しい接続 | 接続を維持 |
|---|---|---|
| 小さな plist を返すだけのハンドラ | 19,700 | 28,000 |
| 本文を読んでそのまま返す POST | 21,200 | 27,300 |
| `(fib 20)` を計算するハンドラ（関数呼び出し2万2千回） | 2,720 | 2,790 |
| `app-server-read`（ファイルの読み込み） | 19,800 | 23,100 |
| SQLite の `SELECT` | 20,500 | 21,900 |
| SQLite の `INSERT`（ディスクへの書き込み） | 2,810 | 2,180 |
| 静的ファイル | 9,100 | 10,500 |
| ブラウザが持っている静的ファイル（`304`） | | 16,200 |

Caddy の後ろに複数のワーカーを置いた場合（`ab -k -c 40`）、計算をするハンドラは、ワーカー1つで毎秒2,630件、2つで5,320件、4つで10,500件と、コアの数だけ速くなります。SQLite の `SELECT` は17,000件から34,900件になります。4つのワーカーから同時に行った挿入は、すべて書き込まれました（15,000件中15,000件、毎秒約1万件）。

比較のために、同じマシンの Node.js 26 では、小さな応答が毎秒21,200件（接続を維持すると66,800件）、`fib(20)` が11,000件でした。Emacs は、同時1接続では毎秒7,300件、同時100接続では毎秒20,400件です。同じ瞬間に百を大きく超える接続が届くと、OS がサーバーのために保持する待ち行列を超えます。手前にプロキシがあれば、その心配はありません。

時間のかかるハンドラは、あとで応答しないかぎり、後ろに並んでいる全員を待たせます。シングルスレッドのイベントループに共通の性質です。他の何かに 100 ms かかるハンドラを、同じ方法で計測しました。

| ハンドラ | 同時10接続 | 50 | 100 |
|---|---|---|---|
| プログラムを実行して終了を待つ（`call-process`） | 毎秒9件 | 9件（半数が3秒以上待つ） | |
| `app-server-run` で実行し、あとで応答する | 86 | 426 | 840 |
| Emacs の中で待つ（`sleep-for`） | 89 | | 97% を断る（503） |
| `app-server-after` で、あとで応答する | 90 | | 869 |
| 他のサーバーに問い合わせて待つ（`url-retrieve-synchronously`） | 81 | | 98% を断る（503） |
| `app-server-fetch` で、あとで応答する | 91 | | 904 |

あとで応答する場合の件数は、単純に「接続数 ÷ 0.1 秒」です。誰も、誰かを待っていません。次の表は、50 接続がプログラムを要求し続けている間に、最初の表の「plist を返すだけのハンドラ」がどうなるかです。

| その間 | plist を返すだけのハンドラ | 最も遅いリクエスト |
|---|---|---|
| プログラムの終了を待つ | 毎秒184件 | 5.4 秒 |
| `app-server-run` でプログラムを実行する | 毎秒9,400件 | 6 ms |

あとで応答すること自体のコストは、ほぼありません。`app-server-defer` を返してすぐに応答するハンドラは毎秒19,700件です。Emacs の中での待ちには注意が必要です。`sleep-for` と `url-retrieve-synchronously` は、待っている間に次のリクエストを受け付け、そのリクエストは待っているハンドラの「内側」で実行されます。10件なら問題ありませんが、100件ではスタックを使い切ってサーバーが終了していました。現在は、32件を超えるとリクエストを 503 で断ります。

## プロジェクトを外に出す

- ヘッダーの **download .zip**：プロジェクトを1つのアーカイブにします。bash と GNU Emacs（29以降）があれば、それだけで動きます。

  ```text
  index.html, app.el, style.css, server.el    プロジェクト
  run.sh              ./run.sh [PORT]。Emacs がこのディレクトリの Web サーバーになる
  fetch-emacs.sh      任意。ブラウザ用の Emacs を vendor/ にダウンロードする（約170MB、curl が必要）
  backup.sh           サーバーが保持するもの（.data/）を、動かしたままコピーする
  server/             run.sh が Emacs に読み込ませるもの（HTTP サーバーと app-server.el、そのライセンス表示）
  README.txt
  ```

  `./run.sh` を実行すると、Emacs がページを配信し、ページからのリクエストに答えます。ブラウザの中でページの `app.el` を動かす Emacs は、通常はページが wasmacs のサイトからダウンロードします。`./fetch-emacs.sh` を実行したあとは、同じ Emacs が `vendor/` から配信するようになり、インターネットは不要になります。

  `vendor/` に置かれる量（約170MB）は、訪問者がダウンロードする量ではありません。訪問者が受け取るのは、Emacs 本体の約5MBと、Emacs 付属の Lisp ファイルのうちページが読んだものだけです（elisp-react のサンプルで最大7ファイル、0.5MB）。ブラウザはそれを次回のために保持します。プロキシを前に置いても置かなくても、プロジェクトのサーバーの次の2つの働きでそうなります。

  - **ファイルの一部分だけを送る。** ページは、パッケージの中でその Lisp ファイルがある部分だけを要求し（range リクエスト）、サーバーはその部分だけを送ります。`server.el` のないプロジェクトを置いた GitHub Pages、nginx、Caddy も同じように応えます。ファイル全体しか送らないサーバー（Python の `http.server`）からは、パッケージ全体の 146MB を1回ダウンロードします。
  - **圧縮済みのコピーを送る。** `fetch-emacs.sh` は、Emacs 本体の隣に gzip のコピーを置きます（`temacs.wasm.gz`、`bootstrap-emacs.pdmp.gz` など）。サーバーは、gzip を受け取れるブラウザにはコピーのほうを送ります。コピーがなければ、訪問者のダウンロードは 17MB になります。同梱の Caddy と nginx の設定を通しても 14MB です（最も大きいファイルを圧縮しないため）。

  `vendor/` には、スタジオと同じく Emacs 付属の Lisp がすべて入ります。そのため、スタジオで動いたものはサイトでも動きます。`app.el` が一部の処理でだけ `require` するライブラリ（`(require 'calc)` など）は、そのときに取得されます。`./fetch-emacs.sh --core` を使うと、コピーする量が減ります（約45MB）。入るのは言語とそのライブラリ（`cl-lib`、`seq`、`map`、`json`、`rx`、`generator`、`iso8601`、`url-util`、文字コード表。コンパイル済みのみ）で、エディタ用のライブラリとソースは入りません。Org、Calc、各言語のモードを `require` するページは、スタジオで動いていても、サイトでは「Cannot open load file」で失敗します。このオプションは、ディスクに余裕がないマシンで、ページを試したうえで使うものです。
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
npm run test:e2e:upload  # アップロードのサンプルを studio の中で動かす
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
- `run.sh` は 127.0.0.1 でだけ待ち受けます。公開する場合や、複数のコアを使う場合は、手前にリバースプロキシが必要です（あるものとないものは、上の「公開する」にあります）。
- studio のタブの中では、scrypt のハッシュは作成も照合もできず、アップロードできるファイルは 32 MB までです。Cookie は、studio を再読み込みするまで保持されます。タブはアプリケーションを書く場所であり、他の人に向けて動かす場所ではありません。

## ライセンス

MIT ライセンスです（[LICENSE](LICENSE)）。ライセンスの表示を残せば、自由に使えます。対象は、studio とプロジェクトサーバー（`lisp/app-server.el`、`tools/serve-project.el`）です。

自分のアプリケーションの一部になるものには、条件が何もありません（[0BSD](template/LICENSE)）。テンプレート、サンプル、そしてダウンロードしたプロジェクトに `tools/project/` から入るファイル（`run.sh`、`fetch-emacs.sh`、`backup.sh`、デプロイ用の設定、`README.txt`）です。ダウンロードしたプロジェクトに付くライセンス表示は `server/LICENSE` の1つだけで、`server/` にある2つのサーバー用ファイルのためのものです。

残りは、Emacs が GNU GPL（バージョン3以降）であることから決まります。

- **MIT で問題がない理由**：サーバー用ファイルとテンプレートは Emacs Lisp で、GNU Emacs の中で動きます。GPL は、[GPL のプログラムと結合されるコード](https://www.gnu.org/licenses/gpl-faq.html#GPLAndPlugins)に、GPL と両立するライセンスを求めます。MIT はその1つで（FSF の一覧では [Expat ライセンス](https://www.gnu.org/licenses/license-list.html#Expat)という名前です）、0BSD も同じです。
- **このリポジトリにも、ダウンロードしたプロジェクトにも、Emacs は含まれていません。** ブラウザの Emacs は [wasmacs](https://github.com/modeverv/wasmacs) のサイトから読み込まれ、サーバーの Emacs はそのマシンにインストールされているものです。
- **`./fetch-emacs.sh` を実行すると、状況が変わります。** ブラウザの Emacs が `vendor/` にコピーされるので、`vendor/` を配信するサイトは、GPL のもとで GNU Emacs を配布することになります。GPL が求めるものは、スクリプトが一緒に取ってきます。`vendor/wasmacs/licenses/` にライセンスの全文と `NOTICE.txt` が入り、`NOTICE.txt` にはそのビルドのソースの場所が書いてあります。このディレクトリは、コピーと一緒に置いたままにしてください。
- **自分で書いたファイル**：`app.el` は Emacs の中で動き、Emacs の Lisp ライブラリを使い、すべての閲覧者に送られます。FSF の解釈では、[そうしたプログラム](https://www.gnu.org/licenses/gpl-faq.html#IfInterpreterIsGPL)を公開するときは、GPL と両立するライセンスにする必要があります。MIT、0BSD、GPL そのもののいずれでも条件を満たします。`server.el` は自分のサーバーに置いたままです。誰にも渡さないものには、この条件はかかりません。
