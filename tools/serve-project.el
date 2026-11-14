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

(require 'cl-lib)
(require 'subr-x)
(require 'bytecomp)

(defvar serve-project-directory default-directory "The project.")
(defvar serve-project-port 8018)
(defvar serve-project--process nil)

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

(defun serve-project--file (path)
  "The file of the project that the URL PATH names, or nil."
  (let* ((root (file-name-as-directory (expand-file-name serve-project-directory)))
         (file (expand-file-name (substring (decode-coding-string (url-unhex-string path) 'utf-8) 1) root)))
    (when (file-directory-p file) (setq file (expand-file-name "index.html" file)))
    (and (string-prefix-p (file-truename root) (file-truename file))
         (not (string-match-p "\\(?:\\`\\|/\\)\\." (file-relative-name file root)))
         ;; The server's own program is not for download.
         (not (string-match-p "\\`server\\(?:\\.el\\|/\\)" (file-relative-name file root)))
         (file-regular-p file)
         file)))

(defun serve-project--respond (process status type body)
  ;; An answer that comes later may find that the visitor has left.
  (when (process-live-p process)
    (process-send-string
     process
     (concat (format "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
                     status type (string-bytes body))
             body))
    (delete-process process)))

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
  '((200 . "OK") (400 . "Bad Request") (404 . "Not Found") (500 . "Internal Server Error")
    (504 . "Gateway Timeout")))

(defun serve-project--answer (process status text)
  "Send the answer of server.el: STATUS and TEXT, printed Lisp data."
  (serve-project--respond process (format "%d %s" status (or (cdr (assq status serve-project--reasons)) "Error"))
                          "application/x-emacs-lisp; charset=utf-8"
                          (encode-coding-string text 'utf-8)))

(defun serve-project--handle (process method target headers body)
  (let ((path (car (split-string target "?")))
        (origin (cdr (assoc "origin" headers))))
    (message "serve-project: %s %s" method path)
    (cond
     ((string-prefix-p "/api/" path)
      (if (and origin (not (member origin (list (format "http://127.0.0.1:%d" serve-project-port)
                                                (format "http://localhost:%d" serve-project-port)))))
          (serve-project--respond process "403 Forbidden" "application/x-emacs-lisp; charset=utf-8"
                                  "\"requests from other sites are refused\"")
        ;; A handler may answer later (`app-server-defer'): then there is no
        ;; answer yet, the connection stays open and this server goes on.
        (let ((answer (app-server-respond method target (decode-coding-string body 'utf-8)
                                          (lambda (status text) (serve-project--answer process status text)))))
          (when answer (serve-project--answer process (aref answer 0) (aref answer 1))))))
     ((not (member method '("GET" "HEAD")))
      (serve-project--respond process "405 Method Not Allowed" "text/plain" "method not allowed"))
     (t
      (let ((file (serve-project--file path)))
        (if (not file)
            (serve-project--respond process "404 Not Found" "text/plain" "not found")
          (serve-project--respond
           process "200 OK"
           (or (cdr (assoc (file-name-extension file) serve-project--types)) "application/octet-stream")
           (let ((bytes (with-temp-buffer
                          (set-buffer-multibyte nil)
                          (insert-file-contents-literally file)
                          (buffer-string))))
             (if (and (equal (file-name-extension file) "html") (serve-project--vendored-p))
                 (encode-coding-string (serve-project--page (decode-coding-string bytes 'utf-8)) 'utf-8)
               bytes)))))))))

(defun serve-project--filter (process chunk)
  "Collect a request on PROCESS; answer it when it is complete."
  (process-put process :input (concat (process-get process :input) chunk))
  (let* ((input (process-get process :input))
         (end (string-search "\r\n\r\n" input)))
    (when end
      (let* ((lines (split-string (substring input 0 end) "\r\n"))
             (request (split-string (car lines) " "))
             (headers (mapcar (lambda (line)
                                (let ((colon (string-search ":" line)))
                                  (cons (downcase (substring line 0 colon))
                                        (string-trim (substring line (1+ (or colon -1)))))))
                              (cdr lines)))
             (length (string-to-number (or (cdr (assoc "content-length" headers)) "0")))
             (body (substring input (+ end 4))))
        (cond ((> length 65536)
               (serve-project--respond process "413 Content Too Large" "text/plain" "too large"))
              ((< (string-bytes body) length))   ; more to come
              ((process-get process :handled))   ; being answered
              ((>= serve-project--nesting serve-project-max-nesting)
               (serve-project--respond process "503 Service Unavailable" "text/plain" "busy"))
              (t
               (process-put process :handled t)
               (condition-case err
                   (let ((serve-project--nesting (1+ serve-project--nesting)))
                     (serve-project--handle process (nth 0 request) (or (nth 1 request) "/") headers
                                            (substring body 0 length)))
                 (error
                  (message "serve-project: %s" (error-message-string err))
                  (ignore-errors
                    (serve-project--respond process "500 Internal Server Error" "text/plain" "error"))))))))))

(defun serve-project-start ()
  "Serve `serve-project-directory' on 127.0.0.1:`serve-project-port'."
  (interactive)
  (when (process-live-p serve-project--process) (delete-process serve-project--process))
  (setq serve-project-directory (file-name-as-directory (expand-file-name serve-project-directory))
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
  (setq serve-project--process
        ;; The number is the length of the queue of connections that wait to
        ;; be accepted (Emacs's default, 5, turns a burst of requests away).
        (make-network-process :name "serve-project" :server 256 :host "127.0.0.1" :family 'ipv4
                              :service serve-project-port :coding 'binary :noquery t
                              :filter #'serve-project--filter))
  (message "serve-project: http://127.0.0.1:%d/ (%s)" serve-project-port serve-project-directory))

(defun serve-project-run ()
  "Start the server and serve until Emacs is killed (for batch mode)."
  (serve-project-start)
  (while t
    ;; An error in a handler that ran later (a timer, a sentinel) must not
    ;; end the server.
    (condition-case err
        (accept-process-output nil 1)
      (error (message "serve-project: %s" (error-message-string err))))))

(provide 'serve-project)
;;; serve-project.el ends here
