;;; serve-project.el --- run a studio project under a native Emacs  -*- lexical-binding: t; -*-

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
;; /vendor/, and nothing is fetched from the internet.
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

(defvar serve-project-max-body (* 1024 1024) "The largest request body, in bytes.")
(defvar serve-project-max-header 16384 "The largest request line and headers, in bytes.")
(defvar serve-project-request-timeout 20
  "Seconds a visitor has to send a request once it has begun.")
(defvar serve-project-idle-timeout 180
  "Seconds a connection may stay open without a request.
Longer than a proxy keeps its idle connections (Caddy: 120 s, nginx: 60 s),
so that it is the proxy that closes them.")
(defvar serve-project-log t "Non-nil: one line per request on standard error.")

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
         (file (expand-file-name (substring (decode-coding-string (url-unhex-string path) 'utf-8) 1) root)))
    (when (file-directory-p file) (setq file (expand-file-name "index.html" file)))
    (and (string-prefix-p root file)
         (let ((relative (substring file (length root))))
           (and (not (string-match-p "\\(?:\\`\\|/\\)\\." relative))
                ;; The server's own program is not for download.
                (not (string-match-p "\\`server\\(?:\\.el\\|/\\)" relative))))
         (file-regular-p file)
         (serve-project--inside-p file)
         file)))

(defun serve-project--respond (process status type body &optional headers close)
  "Send a response on PROCESS: STATUS (\"200 OK\"), TYPE, BODY (bytes).
HEADERS is a list of (NAME . VALUE).  The connection stays open for the
next request if the visitor asked for that, unless CLOSE."
  ;; An answer that comes later may find that the visitor has left.
  (when (process-live-p process)
    (let ((keep (and (not close) (process-get process :keep)))
          (bare (string-prefix-p "304" status)))
      (process-send-string
       process
       (concat (encode-coding-string
                (concat "HTTP/1.1 " status "\r\n"
                        (and (not bare) (format "Content-Type: %s\r\nContent-Length: %d\r\n" type (string-bytes body)))
                        "X-Content-Type-Options: nosniff\r\n"
                        (mapconcat (lambda (header) (concat (car header) ": " (cdr header) "\r\n")) headers "")
                        (if keep "Connection: keep-alive\r\n" "Connection: close\r\n")
                        "\r\n")
                'utf-8)
               (if (or bare (process-get process :head)) "" body)))
      (when (and serve-project-log (process-get process :method))
        (message "serve-project: %s %s %s %dms" (process-get process :method) (process-get process :path)
                 (substring status 0 3) (* 1000 (- (float-time) (process-get process :started)))))
      (if (not keep)
          (delete-process process)
        (process-put process :busy nil)
        (process-put process :method nil)
        (process-put process :since (float-time))
        ;; The next request may be here already.
        (unless (string-empty-p (process-get process :input))
          (run-at-time 0 nil #'serve-project--next process))))))

(defun serve-project--refuse (process status)
  "Answer what is not a request this server takes, and close the connection."
  (process-put process :busy t)
  (process-put process :head nil)
  (serve-project--respond process status "text/plain" (substring status 4) nil t))

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

(defun serve-project--answer (process status text headers)
  "Send the answer of server.el: STATUS, TEXT (printed Lisp data), HEADERS."
  (serve-project--respond process (format "%d %s" status (or (cdr (assq status serve-project--reasons)) "Error"))
                          "application/x-emacs-lisp; charset=utf-8"
                          (encode-coding-string text 'utf-8)
                          (cons '("Cache-Control" . "no-store") headers)))

(defun serve-project--own-origin-p (origin)
  "Non-nil if pages of ORIGIN are this application's own."
  (member origin (append (list (format "http://127.0.0.1:%d" serve-project-port)
                               (format "http://localhost:%d" serve-project-port))
                         serve-project-origins)))

(defun serve-project--handle (process method target headers body)
  (let ((path (car (split-string target "?")))
        (origin (cdr (assoc "origin" headers)))
        (request-headers headers))
    (cond
     ((string-prefix-p "/api/" path)
      (if (and origin (not (serve-project--own-origin-p origin)))
          (serve-project--answer process 403 "\"requests from other sites are refused\"" nil)
        ;; A handler may answer later (`app-server-defer'): then there is no
        ;; answer yet, the connection stays open and this server goes on.
        (let ((answer (app-server-respond
                       method target (decode-coding-string body 'utf-8)
                       (lambda (status text headers) (serve-project--answer process status text headers))
                       headers)))
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
                 (tag (format "\"%x-%x%s\"" (file-attribute-size attributes)
                              (time-convert (file-attribute-modification-time attributes) 'integer)
                              (if page "-v" "")))
                 (headers (list (cons "ETag" tag) '("Cache-Control" . "no-cache"))))
            (if (equal (cdr (assoc "if-none-match" request-headers)) tag)
                (serve-project--respond process "304 Not Modified" nil "" headers)
              (serve-project--respond
               process "200 OK"
               (or (cdr (assoc (file-name-extension file) serve-project--types)) "application/octet-stream")
               (let ((bytes (with-temp-buffer
                              (set-buffer-multibyte nil)
                              (insert-file-contents-literally file)
                              (buffer-string))))
                 (if page
                     (encode-coding-string (serve-project--page (decode-coding-string bytes 'utf-8)) 'utf-8)
                   bytes))
               headers)))))))))

(defun serve-project--next (process)
  "Take the next request that PROCESS has sent completely, if any, and answer it."
  (when (and (process-live-p process) (not (process-get process :busy)))
    (let* ((input (process-get process :input))
           (end (string-search "\r\n\r\n" input)))
      (cond
       ((> (or end (length input)) serve-project-max-header)
        (serve-project--refuse process "431 Request Header Fields Too Large"))
       ((not end))                      ; more to come
       (t
        (let* ((lines (split-string (substring input 0 end) "\r\n"))
               (request (split-string (car lines) " "))
               (headers (delq nil (mapcar (lambda (line)
                                            (let ((colon (string-search ":" line)))
                                              (and colon
                                                   (cons (downcase (substring line 0 colon))
                                                         (string-trim (substring line (1+ colon)))))))
                                          (cdr lines))))
               (stated (cdr (assoc "content-length" headers)))
               (length (if stated (string-to-number stated) 0))
               (start (+ end 4))
               (connection (downcase (or (cdr (assoc "connection" headers)) ""))))
          (cond
           ((not (and (= (length request) 3)
                      (string-prefix-p "/" (nth 1 request))
                      (string-match-p "\\`HTTP/1\\.[01]\\'" (nth 2 request))
                      (or (not stated) (string-match-p "\\`[0-9]+\\'" stated))))
            (serve-project--refuse process "400 Bad Request"))
           ;; A body without a stated length (chunked) is not read.
           ((assoc "transfer-encoding" headers)
            (serve-project--refuse process "411 Length Required"))
           ((> length serve-project-max-body)
            (serve-project--refuse process "413 Content Too Large"))
           ((< (- (length input) start) length)
            ;; The body is on its way; some senders wait to be told to go on.
            (when (and (string-match-p "100-continue" (downcase (or (cdr (assoc "expect" headers)) "")))
                       (not (process-get process :continued)))
              (process-put process :continued t)
              (process-send-string process "HTTP/1.1 100 Continue\r\n\r\n")))
           (t
            (process-put process :input (substring input (+ start length)))
            (process-put process :busy t)
            (process-put process :continued nil)
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
                    (serve-project--handle process (nth 0 request) (nth 1 request) headers
                                           (substring input start (+ start length))))
                (error
                 (message "serve-project: %s" (error-message-string err))
                 (ignore-errors
                   (serve-project--respond process "500 Internal Server Error" "text/plain" "error")))))))))))))

(defun serve-project--filter (process chunk)
  "Collect what PROCESS sends; answer a request when it is complete."
  (let ((input (process-get process :input)))
    ;; The time a request has to arrive runs from its first byte.
    (when (and (string-empty-p (or input "")) (not (process-get process :busy)))
      (process-put process :since (float-time)))
    (process-put process :input (concat input chunk)))
  (serve-project--next process))

(defun serve-project--sweep ()
  "Close the connections that wait too long: half a request, or nothing at all."
  (let ((now (float-time)))
    (dolist (process (process-list))
      (when (and (process-get process :serve-project)
                 (eq (process-status process) 'open)
                 (not (process-get process :busy)))
        (let ((waited (- now (or (process-get process :since) now))))
          (cond ((string-empty-p (or (process-get process :input) ""))
                 (when (> waited serve-project-idle-timeout) (delete-process process)))
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
        app-server-data-directory (expand-file-name ".data/" serve-project-directory))
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
                              :log (lambda (_server connection _message)
                                     (process-put connection :since (float-time)))
                              :filter #'serve-project--filter))
  (when serve-project--sweeper (cancel-timer serve-project--sweeper))
  (let ((every (max 1 (min 5 serve-project-request-timeout serve-project-idle-timeout))))
    (setq serve-project--sweeper (run-at-time every every #'serve-project--sweep)))
  (message "serve-project: http://127.0.0.1:%d/ (%s)%s" serve-project-port serve-project-directory
           (if serve-project-origins
               (format ", published as %s" (string-join serve-project-origins ", "))
             "")))

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
