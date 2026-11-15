;;; serve-project.el --- run a studio project under a native Emacs  -*- lexical-binding: t; -*-

;; Copyright (c) 2026 modeverv
;; SPDX-License-Identifier: MIT

;; A project made in the studio is a directory: index.html, app.el,
;; style.css, and perhaps server.el.  This file makes a native Emacs the web
;; server of such a directory: it serves the files, and it answers
;; /api/... with the project's server.el, the same file that ran in the
;; browser tab while the project was written (lisp/app-server.el).
;;
;;   tools/serve-project.sh DIRECTORY [PORT]
;;
;; The page still runs its Emacs Lisp in the visitor's browser; this Emacs
;; is the server side.  What the server keeps (`app-server-write',
;; `app-server-database') goes to DIRECTORY/.data/, which is not served.
;;
;; The Emacs for the browser normally comes from the wasmacs site.  When
;; DIRECTORY/vendor/ holds a copy (fetch-emacs.sh in a downloaded project
;; puts one there), this server serves that instead: index.html is sent with
;; its links to the elisp-react and wasmacs sites turned into links to
;; /vendor/, and nothing is fetched from the internet.  That Emacs reads its
;; Lisp files one by one, each as a part of one large file: a request with
;; a Range header gets that part.  A file that has a compressed copy next
;; to it (NAME.gz; fetch-emacs.sh makes them) is sent as that copy to a
;; browser that takes gzip.
;;
;; It listens on 127.0.0.1.  A request body is data for server.el; this
;; file evaluates nothing it receives.  Requests to /api/ that a page of
;; another site makes are refused.
;;
;; To publish the application, put a reverse proxy (Caddy, nginx) on the
;; same machine in front of it and name the public origin:
;;
;;   PUBLIC_ORIGIN=https://example.com tools/serve-project.sh DIRECTORY
;;
;; The proxy does HTTPS and compression.  This server keeps connections
;; open for it, reads what it forwards (`app-server-header': x-forwarded-for,
;; x-forwarded-proto, cookie), limits and times out requests, and lets the
;; browser keep unchanged files (ETag).

(require 'cl-lib)
(require 'subr-x)
(require 'bytecomp)

(defvar serve-project-directory default-directory "The project.")
(defvar serve-project-port 8018)
(defvar serve-project--process nil)
(defvar serve-project--sweeper nil)

(defvar serve-project-origins
  (mapcar (lambda (origin) (string-trim-right origin "/+"))
          (split-string (or (getenv "PUBLIC_ORIGIN") "") "[ ,]+" t))
  "The origins under which a reverse proxy publishes this server.
Pages of these origins may use /api/, besides the pages this server
serves itself.  From the environment: PUBLIC_ORIGIN=https://example.com
\(several: separated by commas).")

(defvar serve-project-max-body (* 1024 1024)
  "The largest request body that is text for the handler, in bytes.")
(defvar serve-project-max-upload (* 4 1024 1024 1024)
  "The largest body that is taken into a file, in bytes.
Which requests bring a file, and how large it may be, is for server.el to
say (`app-server-upload-p'); this is the limit beyond that.")
(defvar serve-project-max-header 16384 "The largest request line and headers, in bytes.")
(defvar serve-project-request-timeout 20
  "Seconds a visitor has to send a request once it has begun.")
(defvar serve-project-idle-timeout 180
  "Seconds a connection may stay open without a request.
Longer than a proxy keeps its idle connections (Caddy: 120 s, nginx: 60 s),
so that it is the proxy that closes them.")
(defvar serve-project-log t "Non-nil: one line per request on standard error.")
(defvar serve-project-workers (max 1 (string-to-number (or (getenv "WORKERS") "1")))
  "How many server processes share the project (WORKERS=4 ./run.sh).
Each is an Emacs of its own on a port of its own, on a core of its own;
the reverse proxy in front spreads the requests over them.")

;; A handler that waits inside Emacs (`sleep-for', `url-retrieve-synchronously')
;; lets the next request in while it waits: that one runs inside the first,
;; and the first cannot finish before it.  Enough of them exhaust the
;; stack, so beyond this depth requests are turned away (503).  A handler
;; that has to wait should answer later instead: `app-server-defer'.
(defvar serve-project-max-nesting 32)
(defvar serve-project--nesting 0)

;; app-server.el: next to this file (a downloaded project), or in lisp/ of
;; the elisp-studio repository.
(let ((here (file-name-directory (or load-file-name buffer-file-name))))
  (load (if (file-readable-p (expand-file-name "app-server.el" here))
            (expand-file-name "app-server.el" here)
          (expand-file-name "../lisp/app-server.el" here))
        nil t))

(defconst serve-project--types
  '(("html" . "text/html; charset=utf-8") ("css" . "text/css; charset=utf-8")
    ("js" . "text/javascript") ("json" . "application/json")
    ("el" . "text/plain; charset=utf-8") ("png" . "image/png") ("svg" . "image/svg+xml")
    ("wasm" . "application/wasm") ("mjs" . "text/javascript")))

(defvar serve-project--root nil "The project directory, expanded, with a final slash.")
(defvar serve-project--true-root nil "`serve-project--root' with symbolic links resolved.")

(defun serve-project--inside-p (file)
  "Non-nil if FILE, a name below the project directory, is a file in it.
A symbolic link in the project may not lead out of it.  (Asking for the
true name of every file would cost more than reading it, so that is done
only for names with a link in them.)"
  (let ((directory serve-project--root)
        (link nil))
    (dolist (part (split-string (substring file (length serve-project--root)) "/" t))
      (setq directory (concat directory part))
      (when (file-symlink-p directory) (setq link t))
      (setq directory (concat directory "/")))
    (or (not link)
        (string-prefix-p serve-project--true-root (file-truename file)))))

(defun serve-project--file (path)
  "The file of the project that the URL PATH names, or nil."
  (let* ((root serve-project--root)
         (name (decode-coding-string (url-unhex-string path) 'utf-8))
         ;; Emacs can treat names like /ssh:host:/file as files on other
         ;; machines, and others as compressed or encrypted.  Not here: a
         ;; name in a request is a file of this project or nothing.
         (file-name-handler-alist nil)
         (case-fold-search t)
         (file (and (not (string-match-p "[\0-\x1f\x7f]" name))
                    (expand-file-name (substring name 1) root))))
    ;; (The project directory itself comes back without its final slash.)
    (when (equal file (directory-file-name root)) (setq file root))
    ;; The name is judged before the disk is asked anything about it.
    (when (and file (string-prefix-p root file))
      (let ((relative (substring file (length root))))
        (and (not (string-match-p "\\(?:\\`\\|/\\)\\." relative))
             ;; The server's own program and the scripts that run it are
             ;; not for download.
             (not (string-match-p "\\`server\\(?:\\.elc?\\|/\\)" relative))
             (not (string-match-p "\\.sh\\'" relative))
             (progn (when (file-directory-p file) (setq file (expand-file-name "index.html" file)))
                    (file-regular-p file))
             (serve-project--inside-p file)
             file)))))

(defconst serve-project--piece (* 1024 1024) "Files are sent in pieces of this size.")

(defun serve-project--respond (process status type body &optional headers close file)
  "Send a response on PROCESS: STATUS (\"200 OK\"), TYPE, BODY (bytes).
HEADERS is a list of (NAME . VALUE).  The connection stays open for the
next request if the visitor asked for that, unless CLOSE.  With FILE, the
body is that file's content, read and sent piece by piece; (FILE START END)
is the part of it from byte START up to END."
  ;; An upload that the handler did not keep goes away with the answer.
  (serve-project--forget-upload process)
  ;; An answer that comes later may find that the visitor has left.
  (when (process-live-p process)
    (let* ((keep (and (not close) (process-get process :keep)))
           (bare (string-prefix-p "304" status))
           (from (if (consp file) (nth 1 file) 0))
           (to (and (consp file) (nth 2 file)))
           (file (if (consp file) (car file) file))
           (size (cond (to (- to from))
                       (file (file-attribute-size (file-attributes file)))
                       (t (string-bytes body)))))
      (process-send-string
       process
       (concat (encode-coding-string
                (concat "HTTP/1.1 " status "\r\n"
                        (and (not bare) (format "Content-Type: %s\r\nContent-Length: %d\r\n" type size))
                        "X-Content-Type-Options: nosniff\r\n"
                        ;; Not inside a frame of another site (clickjacking),
                        ;; and no word to other sites about where one came from.
                        "X-Frame-Options: SAMEORIGIN\r\n"
                        "Content-Security-Policy: frame-ancestors 'self'; form-action 'self'; base-uri 'self'; object-src 'none'\r\n"
                        "Referrer-Policy: same-origin\r\n"
                        (mapconcat (lambda (header) (concat (car header) ": " (cdr header) "\r\n")) headers "")
                        (if keep "Connection: keep-alive\r\n" "Connection: close\r\n")
                        "\r\n")
                'utf-8)
               (if (or bare file (process-get process :head)) "" body)))
      (when (and file (not bare) (not (process-get process :head)))
        (let ((sent 0))
          (while (and (< sent size) (process-live-p process))
            (process-send-string
             process
             (with-temp-buffer
               (set-buffer-multibyte nil)
               (insert-file-contents-literally file nil (+ from sent) (+ from (min size (+ sent serve-project--piece))))
               (buffer-string)))
            (setq sent (+ sent serve-project--piece)))))
      (when (and serve-project-log (process-get process :method))
        (message "serve-project: %s %s %s %dms" (process-get process :method)
                 (replace-regexp-in-string "[^!-~]" "?" (process-get process :path))
                 (substring status 0 3) (* 1000 (- (float-time) (process-get process :started)))))
      (cond ((not (process-live-p process)))
            ;; A body that was refused is still on its way.  Closing now
            ;; would reset the connection under the sender, who would then
            ;; not see the answer: take what comes and drop it.
            ((and (not keep) (> (or (process-get process :linger) 0) 0))
             (process-put process :discard (process-get process :linger))
             (process-put process :linger nil)
             (process-put process :busy nil)
             (process-put process :method nil)
             (process-put process :since (float-time)))
            ((not keep) (delete-process process))
            (t
             (process-put process :busy nil)
             (process-put process :method nil)
             (process-put process :served t)
             (process-put process :since (float-time))
             ;; The next request may be here already.
             (unless (string-empty-p (process-get process :input))
               (run-at-time 0 nil #'serve-project--next process)))))))

(defun serve-project--forget-upload (process)
  "Delete the file of PROCESS's upload, if it is still where it was put."
  (let ((upload (process-get process :upload)))
    (when upload
      (process-put process :upload nil)
      (process-put process :upload-left nil)
      (ignore-errors (delete-file (plist-get upload :file))))))

(defun serve-project--sentinel (process _event)
  "A visitor who leaves in the middle of an upload leaves nothing behind."
  (unless (process-live-p process) (serve-project--forget-upload process)))

(defvar serve-project-max-connections 512
  "How many connections are open at most.
One more, and an idle one is closed.  (An Emacs
cannot have many more than a thousand; a reverse proxy uses a few.)")

(defun serve-project--connections ()
  "The connections of visitors."
  (seq-filter (lambda (process)
                (and (process-get process :serve-project) (eq (process-status process) 'open)))
              (process-list)))

(defun serve-project--accepted (_server connection _message)
  "A visitor has connected.  Make room if that is one connection too many."
  ;; (When no more can be accepted, this is called without a connection.)
  (when (processp connection)
    (process-put connection :since (float-time))
    (let ((all (serve-project--connections)))
      (when (> (length all) serve-project-max-connections)
        (let ((idle (seq-filter (lambda (process)
                                  (not (or (eq process connection) (process-get process :busy)
                                           (process-get process :upload-left))))
                                all)))
          ;; First those that never asked for anything (a flood of silent
          ;; connections is made of them), then those that rest between
          ;; requests; among each, the one that waited longest.
          (delete-process
           (if idle
               (car (sort idle (lambda (one other)
                                 (let ((new-one (not (process-get one :served)))
                                       (new-other (not (process-get other :served))))
                                   (if (eq new-one new-other)
                                       (< (or (process-get one :since) 0) (or (process-get other :since) 0))
                                     new-one)))))
             connection)))))))

(defun serve-project--refuse (process status &optional coming)
  "Answer what is not a request this server takes, and close the connection.
COMING is how many bytes of its body have not arrived yet."
  (process-put process :busy t)
  (process-put process :head nil)
  (process-put process :linger (and coming (<= coming serve-project-max-upload) coming))
  (serve-project--respond process status "text/plain" (substring status 4) nil t))

(defun serve-project--range (header size)
  "The part of a file of SIZE bytes that the Range HEADER asks for.
\(START END), END not included; `none' if the file has no such part; nil
without a header, or with one that is not one range of bytes (HTTP allows
the whole file as the answer then).  The browser's Emacs reads its Lisp
files this way: each one is a part of one large file."
  (when (and header (string-match "\\`bytes=\\([0-9]\\{1,15\\}\\)-\\([0-9]\\{0,15\\}\\)\\'" header))
    (let ((start (string-to-number (match-string 1 header)))
          (end (if (string-empty-p (match-string 2 header))
                   (1- size)
                 (string-to-number (match-string 2 header)))))
      (cond ((>= start size) 'none)
            ((< end start) nil)
            (t (list start (1+ (min end (1- size)))))))))

(defun serve-project--gzip-p (header)
  "Non-nil if the Accept-Encoding HEADER of a request takes gzip."
  (and header
       (let ((case-fold-search t))
         (and (string-match "\\(?:\\`\\|[ ,\t]\\)gzip\\(?:[ \t]*;[ \t]*q=\\([0-9.]+\\)\\)?[ \t]*\\(?:,\\|\\'\\)" header)
              (not (and (match-string 1 header)
                        (zerop (string-to-number (match-string 1 header)))))))))

(defun serve-project--packed (path file)
  "The gzip-compressed copy of FILE, the file that the URL PATH names, or nil.
That is the file next to it with .gz added to its name, if this server
would send that file to whoever asked for it by name, and if it is not
older than FILE.  fetch-emacs.sh keeps such copies of the browser's Emacs,
which is 16 MB as it is and 5 MB compressed; the server does not compress
anything itself."
  (let ((packed (serve-project--file (concat path ".gz"))))
    (and packed
         (equal packed (concat file ".gz"))
         (not (file-newer-than-file-p file packed))
         packed)))

(defun serve-project--vendored-p ()
  "Non-nil if the project has its own copy of the browser's Emacs."
  (file-readable-p (expand-file-name "vendor/elisp-react/js/elisp-react.js" serve-project-directory)))

(defun serve-project--page (html)
  "The page HTML, using the copies in /vendor/ instead of the public sites."
  (let ((case-fold-search t))
    (setq html (replace-regexp-in-string "https://modeverv\\.github\\.io/elisp-react/" "/vendor/elisp-react/" html t t))
    (if (string-match "<head[^>]*>" html)
        (replace-match (concat (match-string 0 html)
                               "\n    <meta name=\"elisp-react:wasmacs\" content=\"/vendor/wasmacs/\">")
                       t t html)
      html)))

(defconst serve-project--reasons
  '((200 . "OK") (400 . "Bad Request") (401 . "Unauthorized") (403 . "Forbidden") (404 . "Not Found")
    (409 . "Conflict") (429 . "Too Many Requests") (500 . "Internal Server Error") (504 . "Gateway Timeout")))

(defun serve-project--answer (process status text headers &optional close)
  "Send the answer of server.el: STATUS, TEXT (printed Lisp data), HEADERS.
TEXT is (:file FILE :type TYPE :name NAME) when the answer is a file."
  (let ((line (format "%d %s" status (or (cdr (assq status serve-project--reasons)) "Error")))
        ;; Answers of the application are for its own pages to read.
        (headers (append '(("Cache-Control" . "no-store") ("Cross-Origin-Resource-Policy" . "same-origin"))
                         headers)))
    (if (stringp text)
        (serve-project--respond process line "application/x-emacs-lisp; charset=utf-8"
                                (encode-coding-string text 'utf-8) headers close)
      (let ((name (plist-get text :name)))
        (serve-project--respond
         process line (plist-get text :type) ""
         (if name
             (cons (cons "Content-Disposition"
                         (format "attachment; filename=\"%s\""
                                 (replace-regexp-in-string "[^A-Za-z0-9._ -]" "_" name)))
                   headers)
           headers)
         close (plist-get text :file))))))

(defun serve-project--own-origin-p (origin)
  "Non-nil if pages of ORIGIN are this application's own."
  (member origin (append (list (format "http://127.0.0.1:%d" serve-project-port)
                               (format "http://localhost:%d" serve-project-port))
                         serve-project-origins)))

(defun serve-project--own-host-p (host)
  "Non-nil if HOST, the Host header of a request, is a name of this server.
A page of another site can make its own name point to this machine (DNS
rebinding) and then read what this server answers; its requests carry
that name."
  (or (not host)
      (member (downcase host)
              (append (list (format "127.0.0.1:%d" serve-project-port) (format "localhost:%d" serve-project-port)
                            (format "[::1]:%d" serve-project-port))
                      (mapcan (lambda (origin)
                                (let ((host (downcase (replace-regexp-in-string "\\`[a-z]+://" "" origin))))
                                  ;; With and without the port: proxies pass either.
                                  (list host (replace-regexp-in-string ":[0-9]+\\'" "" host))))
                              serve-project-origins)))))

(defun serve-project--foreign-p (headers)
  "Non-nil if the request with HEADERS was made by a page of another site."
  (let ((origin (cdr (assoc "origin" headers))))
    (or (and origin (not (serve-project--own-origin-p origin)))
        ;; Browsers say so themselves, also for requests without an Origin
        ;; (a picture, a link): no page of another site has business here.
        (equal (cdr (assoc "sec-fetch-site" headers)) "cross-site"))))

(defun serve-project--handle (process method target headers body &optional upload)
  (let ((path (car (split-string target "?")))
        (request-headers headers))
    (cond
     ((not (serve-project--own-host-p (cdr (assoc "host" headers))))
      (serve-project--respond process "421 Misdirected Request" "text/plain" "this server is not that host"))
     ((string-prefix-p "/api/" path)
      (if (serve-project--foreign-p headers)
          (serve-project--answer process 403 "\"requests from other sites are refused\"" nil)
        ;; A handler may answer later (`app-server-defer'): then there is no
        ;; answer yet, the connection stays open and this server goes on.
        (let ((answer (app-server-respond
                       method target (decode-coding-string body 'utf-8)
                       (lambda (status text headers) (serve-project--answer process status text headers))
                       ;; What a proxy says about the visitor counts only
                       ;; when there is a proxy; otherwise the visitor wrote it.
                       (if serve-project-origins
                           headers
                         (seq-remove (lambda (header) (string-prefix-p "x-forwarded-" (car header))) headers))
                       upload)))
          (when answer (serve-project--answer process (aref answer 0) (aref answer 1) (aref answer 2))))))
     ((not (member method '("GET" "HEAD")))
      (serve-project--respond process "405 Method Not Allowed" "text/plain" "method not allowed"))
     (t
      (let ((file (serve-project--file path)))
        (if (not file)
            (serve-project--respond process "404 Not Found" "text/plain" "not found")
          ;; The browser may keep the file but asks each time whether it
          ;; changed; the answer to that is short.
          (let* ((attributes (file-attributes file))
                 (page (and (equal (file-name-extension file) "html") (serve-project--vendored-p)))
                 ;; A compressed copy is sent in place of the file to a
                 ;; browser that takes one, but not a part of it: the
                 ;; parts that are asked for are parts of the file.
                 (copy (and (not page) (serve-project--packed path file)))
                 (packed (and copy
                              (not (assoc "range" request-headers))
                              (serve-project--gzip-p (cdr (assoc "accept-encoding" request-headers)))
                              copy))
                 (tag (format "\"%x-%x%s\"" (file-attribute-size attributes)
                              (time-convert (file-attribute-modification-time attributes) 'integer)
                              (cond (page "-v") (packed "-gz") (t ""))))
                 (headers (append (list (cons "ETag" tag) '("Cache-Control" . "no-cache"))
                                  (and copy '(("Vary" . "Accept-Encoding")))
                                  (and packed '(("Content-Encoding" . "gzip"))))))
            (if (equal (cdr (assoc "if-none-match" request-headers)) tag)
                (serve-project--respond process "304 Not Modified" nil "" headers)
              (let* ((type (or (cdr (assoc (file-name-extension file) serve-project--types))
                               "application/octet-stream"))
                     (size (file-attribute-size attributes))
                     ;; A page is rewritten on its way out: it has no parts.
                     (range (and (not page) (serve-project--range (cdr (assoc "range" request-headers)) size))))
                (cond
                 ((eq range 'none)
                  (serve-project--respond process "416 Range Not Satisfiable" "text/plain" "no such part"
                                          (cons (cons "Content-Range" (format "bytes */%d" size)) headers)))
                 (range
                  (serve-project--respond
                   process "206 Partial Content" type ""
                   (cons (cons "Content-Range" (format "bytes %d-%d/%d" (car range) (1- (cadr range)) size)) headers)
                   nil (cons file range)))
                 (packed
                  (serve-project--respond process "200 OK" type "" headers nil packed))
                 ((and (not page) (> size serve-project--piece))
                  (serve-project--respond process "200 OK" type "" headers nil file))
                 (t
                  (serve-project--respond
                   process "200 OK" type
                   (let ((bytes (with-temp-buffer
                                  (set-buffer-multibyte nil)
                                  (insert-file-contents-literally file)
                                  (buffer-string))))
                     (if page
                         (encode-coding-string (serve-project--page (decode-coding-string bytes 'utf-8)) 'utf-8)
                       bytes))
                   headers))))))))))))

(defun serve-project--begin (process request headers body &optional upload)
  "Answer the REQUEST (METHOD TARGET VERSION) that PROCESS has sent completely."
  (let ((connection (downcase (or (cdr (assoc "connection" headers)) ""))))
    (process-put process :busy t)
    (process-put process :continued nil)
    (process-put process :asked nil)
    (process-put process :keep (if (equal (nth 2 request) "HTTP/1.1")
                                   (not (string-match-p "close" connection))
                                 (string-match-p "keep-alive" connection)))
    (process-put process :head (equal (nth 0 request) "HEAD"))
    (process-put process :method (nth 0 request))
    (process-put process :path (car (split-string (nth 1 request) "?")))
    (process-put process :started (float-time))
    (if (>= serve-project--nesting serve-project-max-nesting)
        (serve-project--respond process "503 Service Unavailable" "text/plain" "busy")
      (condition-case err
          (let ((serve-project--nesting (1+ serve-project--nesting)))
            (serve-project--handle process (nth 0 request) (nth 1 request) headers body upload))
        (error
         (message "serve-project: %s" (error-message-string err))
         (ignore-errors
           (serve-project--respond process "500 Internal Server Error" "text/plain" "error")))))))

(defun serve-project--continue (process headers)
  "Tell a sender that waits for it to go on with the body."
  (when (and (string-match-p "100-continue" (downcase (or (cdr (assoc "expect" headers)) "")))
             (not (process-get process :continued)))
    (process-put process :continued t)
    (process-send-string process "HTTP/1.1 100 Continue\r\n\r\n")))

(defun serve-project--upload-p (process request headers length)
  "Does REQUEST bring a file?  t, nil, or the answer that refuses it.
server.el is asked once per request, when the headers are there."
  (let ((asked (process-get process :asked)))
    (if asked
        (car asked)
      (let* ((answer (and (> length 0)
                          (member (nth 0 request) '("POST" "PUT"))
                          (string-prefix-p "/api/" (nth 1 request))
                          (serve-project--own-host-p (cdr (assoc "host" headers)))
                          (not (serve-project--foreign-p headers))
                          (app-server-upload-accept (nth 0 request) (nth 1 request) length headers))))
        (process-put process :asked (list answer))
        answer))))

(defun serve-project--take (process bytes)
  "Add BYTES to the upload of PROCESS; when it is complete, answer the request."
  (let* ((upload (process-get process :upload))
         (left (process-get process :upload-left))
         (mine (min left (length bytes))))
    (when (> mine 0)
      (let ((coding-system-for-write 'binary))
        (write-region (if (= mine (length bytes)) bytes (substring bytes 0 mine)) nil
                      (plist-get upload :file) t 'silent)))
    (process-put process :upload-left (- left mine))
    (process-put process :since (float-time))
    (when (= left mine)
      ;; What follows the file is the next request.
      (process-put process :input (substring bytes mine))
      (process-put process :upload-left nil)
      (let ((request (process-get process :request)))
        (serve-project--begin process (car request) (cdr request) "" upload)))))

(defun serve-project--next (process)
  "Take the next request that PROCESS has sent completely, if any, and answer it."
  (when (and (process-live-p process) (not (process-get process :busy))
             (not (process-get process :upload-left)))
    (let* ((input (process-get process :input))
           (end (string-search "\r\n\r\n" input)))
      (cond
       ((> (or end (length input)) serve-project-max-header)
        (serve-project--refuse process "431 Request Header Fields Too Large"))
       ((not end))                      ; more to come
       (t
        (let* ((lines (split-string (substring input 0 end) "\r\n"))
               (request (split-string (car lines) " "))
               ;; A header is "Name: value" and nothing else.  Lines that
               ;; another server might read differently (a space before the
               ;; colon, a continuation line, control characters) end the
               ;; request: two servers that disagree about where a request
               ;; ends can be made to hand one visitor another's answer.
               (malformed nil)
               (headers (mapcar (lambda (line)
                                  (if (string-match "\\`\\([!#$%&'*+.^_`|~0-9A-Za-z-]+\\):[ \t]*\\([^\0-\x08\x0a-\x1f\x7f]*\\)\\'" line)
                                      (cons (downcase (match-string 1 line)) (string-trim-right (match-string 2 line)))
                                    (setq malformed t)
                                    (cons "" "")))
                                (cdr lines)))
               (lengths (seq-filter (lambda (header) (equal (car header) "content-length")) headers))
               (stated (cdr (car lengths)))
               (length (if stated (string-to-number stated) 0))
               (start (+ end 4))
               (upload nil))
          (cond
           ((not (and (= (length request) 3)
                      (not malformed)
                      (<= (length lengths) 1)
                      (let ((case-fold-search nil)) (string-match-p "\\`[A-Z]+\\'" (nth 0 request)))
                      (string-prefix-p "/" (nth 1 request))
                      (string-match-p "\\`HTTP/1\\.[01]\\'" (nth 2 request))
                      (or (not stated) (string-match-p "\\`[0-9]+\\'" stated))))
            (serve-project--refuse process "400 Bad Request"))
           ;; A body without a stated length (chunked) is not read.
           ((assoc "transfer-encoding" headers)
            (serve-project--refuse process "411 Length Required"))
           ;; A file?  server.el says, having seen the headers only.
           ((vectorp (setq upload (serve-project--upload-p process request headers length)))
            (process-put process :busy t)
            (process-put process :keep nil)
            (process-put process :head nil)
            (let ((coming (- length (- (length input) start))))
              (process-put process :linger (and (<= coming serve-project-max-upload) coming)))
            (serve-project--answer process (aref upload 0) (aref upload 1) (aref upload 2) t))
           ((> length (if upload serve-project-max-upload serve-project-max-body))
            (serve-project--refuse process "413 Content Too Large" (- length (- (length input) start))))
           (upload
            (process-put process :input "")
            (process-put process :upload (list :file (app-server-upload-file) :size length
                                               :type (or (cdr (assoc "content-type" headers))
                                                         "application/octet-stream")))
            (process-put process :upload-left length)
            (process-put process :request (cons request headers))
            (serve-project--continue process headers)
            (serve-project--take process (substring input start)))
           ((< (- (length input) start) length)
            ;; The body is on its way; some senders wait to be told to go on.
            (serve-project--continue process headers))
           (t
            (process-put process :input (substring input (+ start length)))
            (serve-project--begin process request headers
                                  (substring input start (+ start length)))))))))))

(defun serve-project--filter (process chunk)
  "Collect what PROCESS sends; answer a request when it is complete."
  (cond
   ((process-get process :upload-left) (serve-project--take process chunk))
   ((process-get process :discard)
    ;; The rest of a body that was refused.
    (let ((left (- (process-get process :discard) (length chunk))))
      (if (<= left 0)
          (delete-process process)
        (process-put process :discard left)
        (process-put process :since (float-time)))))
   (t
    (let ((input (process-get process :input)))
      ;; The time a request has to arrive runs from its first byte.
      (when (and (string-empty-p (or input "")) (not (process-get process :busy)))
        (process-put process :since (float-time)))
      (process-put process :input (concat input chunk)))
    (serve-project--next process))))

(defun serve-project--sweep ()
  "Close the connections that wait too long: half a request, or nothing at all."
  (let ((now (float-time)))
    (dolist (process (process-list))
      (when (and (process-get process :serve-project)
                 (eq (process-status process) 'open)
                 (not (process-get process :busy)))
        (let ((waited (- now (or (process-get process :since) now))))
          (cond ((process-get process :discard)
                 (when (> waited serve-project-request-timeout) (delete-process process)))
                ((process-get process :upload-left)
                 ;; An upload may take as long as it takes, while it moves.
                 (when (> waited serve-project-request-timeout)
                   (serve-project--refuse process "408 Request Timeout")))
                ((string-empty-p (or (process-get process :input) ""))
                 ;; A connection that has asked for something may rest; one
                 ;; that never said a word is not kept for long.
                 (when (> waited (if (process-get process :served)
                                     serve-project-idle-timeout
                                   serve-project-request-timeout))
                   (delete-process process)))
                ((> waited serve-project-request-timeout)
                 (serve-project--refuse process "408 Request Timeout"))))))))

(defun serve-project--compile ()
  "Byte-compile this server's own functions, which were loaded as source.
They run for every request; compiled, the server answers half again as
many."
  (let ((byte-compile-warnings nil)
        (byte-compile-verbose nil))
    (mapatoms
     (lambda (symbol)
       (when (and (string-match-p "\\`\\(?:serve-project\\|app-server\\)-" (symbol-name symbol))
                  (fboundp symbol))
         (let ((function (symbol-function symbol)))
           (when (and (functionp function)
                      (not (or (byte-code-function-p function) (subrp function) (symbolp function))))
             (ignore-errors (byte-compile symbol)))))))))

(defun serve-project-start ()
  "Serve `serve-project-directory' on 127.0.0.1:`serve-project-port'."
  (interactive)
  (when (process-live-p serve-project--process) (delete-process serve-project--process))
  (setq serve-project-directory (file-name-as-directory (expand-file-name serve-project-directory))
        serve-project--root serve-project-directory
        serve-project--true-root (file-name-as-directory (file-truename serve-project-directory))
        app-server-data-directory (expand-file-name ".data/" serve-project-directory)
        app-server-shared (> serve-project-workers 1)
        ;; What goes wrong inside is for the log, not for the visitor.
        app-server-explain-errors nil)
  ;; Uploads that a server that was stopped left half done.
  (let ((uploads (expand-file-name "uploads/" app-server-data-directory)))
    (when (and (file-directory-p uploads) (= serve-project-workers 1))
      (dolist (file (directory-files uploads t "\\`[^.]")) (ignore-errors (delete-file file)))))
  (when (and (> serve-project-workers 1)
             (not (and (fboundp 'sqlite-available-p) (sqlite-available-p))))
    (message "serve-project: WARNING: this Emacs has no SQLite, so each of the %d workers keeps its own sessions: a visitor signed in at one is unknown to the others"
             serve-project-workers))
  (let ((server (expand-file-name "server.el" serve-project-directory))
        (compiled (expand-file-name "server.elc" app-server-data-directory)))
    (when (file-readable-p server)
      ;; Byte-compiled, handlers that compute run several times faster.  The
      ;; compiled file goes to the data directory, which is not served.
      (make-directory app-server-data-directory t)
      (if (let ((byte-compile-dest-file-function (lambda (_source) compiled))
                (byte-compile-verbose nil))
            (ignore-errors (byte-compile-file server)))
          (load compiled nil t)
        (load server nil t))))
  (serve-project--compile)
  (setq serve-project--process
        ;; The number is the length of the queue of connections that wait to
        ;; be accepted (Emacs's default, 5, turns a burst of requests away).
        (make-network-process :name "serve-project" :server 256 :host "127.0.0.1" :family 'ipv4
                              :service serve-project-port :coding 'binary :noquery t
                              :plist '(:serve-project t :input "")
                              :log #'serve-project--accepted
                              :filter #'serve-project--filter
                              :sentinel #'serve-project--sentinel))
  (when serve-project--sweeper (cancel-timer serve-project--sweeper))
  (let ((every (max 1 (min 5 serve-project-request-timeout serve-project-idle-timeout))))
    (setq serve-project--sweeper (run-at-time every every #'serve-project--sweep)))
  (message "serve-project: http://127.0.0.1:%d/ (%s)%s" serve-project-port serve-project-directory
           (if serve-project-origins
               (format ", published as %s" (string-join serve-project-origins ", "))
             ""))
  (message "serve-project: passwords are hashed by %s" (app-server-password-hasher)))

(defun serve-project-run ()
  "Start the server and serve until Emacs is killed (for batch mode)."
  ;; Collect garbage less often than an editor would: with the default, one
  ;; request in a hundred waits 9 ms for it.  This costs some 15 MB.
  (setq gc-cons-threshold (max gc-cons-threshold (* 16 1024 1024)))
  (serve-project-start)
  (while t
    ;; An error in a handler that ran later (a timer, a sentinel) must not
    ;; end the server.
    (condition-case err
        (accept-process-output nil 1)
      (error (message "serve-project: %s" (error-message-string err))))))

(provide 'serve-project)
;;; serve-project.el ends here
