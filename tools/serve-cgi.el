;;; serve-cgi.el --- answer one request to /api/ as a CGI program  -*- lexical-binding: t; -*-

;; Copyright (c) 2026 modeverv
;; SPDX-License-Identifier: MIT

;; For a host that runs programs as CGI and allows no server of one's own
;; (a shared host such as Sakura's rental server, which ends resident
;; processes): each request to /api/ starts an Emacs, which answers it with
;; the project's server.el and ends.  The host's web server sends the
;; project's other files itself.  It runs on GNU Emacs 27.2 and later.
;;
;; app.cgi, in the directory of index.html, starts it:
;;
;;   #!/bin/sh
;;   APP_DIRECTORY=$HOME/my-app        # server.el, and server/ with this file
;;   APP_DATA=$HOME/my-app/data        # what the server keeps; its log
;;   APP_MYSQL=$HOME/my-app/my.cnf     # optional: the data in MySQL
;;   PUBLIC_ORIGIN=https://example.com # the address of the pages
;;   export APP_DIRECTORY APP_DATA APP_MYSQL PUBLIC_ORIGIN
;;   exec /usr/local/bin/emacs --batch -Q -l "$APP_DIRECTORY/server/serve-cgi.el" -f serve-cgi-main
;;
;; and .htaccess there sends /api/... to it:
;;
;;   RewriteEngine On
;;   RewriteRule ^api/(.*)$ app.cgi/api/$1 [L,QSA]
;;   CGIPassAuth On
;;
;; A request goes through serve-project.el's own handling, so it meets the
;; same checks (a page of another site, another host, CORS) and gets the
;; same headers as under run.sh.  Nothing stays from one request to the
;; next: keep data with `app-server-write' or in the database
;; (`app-server-sql-select' and the rest); sessions are in the database.
;; The process may be ended at any moment: a change that is more than one
;; statement belongs in `app-server-sql-transaction'.

;;; Code:

(require 'cl-lib)
(require 'subr-x)

;; Compiled files are taken when they are there and newer than the source
;; (a deployment compiles them once: they save a good part of each start).
(setq load-prefer-newer t)
(load (expand-file-name "serve-project" (file-name-directory (or load-file-name buffer-file-name))) nil t)

(defvar serve-cgi-timeout 25
  "Seconds an answer may take (one that comes later), then it is a 504.
Less than the host gives a CGI program.")

(defvar serve-cgi-log "requests.log"
  "The log, in the data directory: one line per request.  nil: none.")

(defvar serve-cgi--status nil "The status sent, once the answer has gone.")

(defun serve-cgi--headers ()
  "The request's headers, from the CGI variables: ((NAME . VALUE) ...).
What the visitor says about itself in X-Forwarded-* is dropped; what the
host knows (REMOTE_ADDR, HTTPS) is said in their place."
  (let (headers)
    (dolist (entry process-environment)
      (when (string-match "\\`HTTP_\\([A-Z0-9_]+\\)=" entry)
        (let ((name (downcase (replace-regexp-in-string "_" "-" (match-string 1 entry))))
              (value (substring entry (match-end 0))))
          (unless (string-prefix-p "x-forwarded-" name)
            (push (cons name value) headers)))))
    (dolist (variable '(("CONTENT_TYPE" . "content-type") ("CONTENT_LENGTH" . "content-length")))
      (let ((value (getenv (car variable))))
        (when (and value (not (string-empty-p value)))
          (push (cons (cdr variable) value) headers))))
    (let ((address (getenv "REMOTE_ADDR")))
      (when address (push (cons "x-forwarded-for" address) headers)))
    (push (cons "x-forwarded-proto" (if (equal (getenv "HTTPS") "on") "https" "http")) headers)
    (nreverse headers)))

(defun serve-cgi--body (length)
  "The body of the request: LENGTH bytes of the standard input."
  (if (<= length 0)
      ""
    (with-temp-buffer
      (set-buffer-multibyte nil)
      (let ((coding-system-for-read 'binary))
        ;; Not a range of it: the input is no regular file.
        (insert-file-contents-literally "/dev/stdin"))
      (when (> (buffer-size) length) (delete-region (1+ length) (point-max)))
      (buffer-string))))

(defun serve-cgi--file-bytes (file)
  "The bytes of FILE, or of (FILE START END)."
  (with-temp-buffer
    (set-buffer-multibyte nil)
    (if (consp file)
        (insert-file-contents-literally (car file) nil (nth 1 file) (nth 2 file))
      (insert-file-contents-literally file))
    (buffer-string)))

(defun serve-cgi--write (status type body headers file)
  "Write the answer: STATUS (\"200 OK\"), TYPE, BODY (bytes), HEADERS, FILE."
  (unless serve-cgi--status
    (setq serve-cgi--status status)
    (let ((head (encode-coding-string
                 (concat "Status: " status "\r\n"
                         (and type (format "Content-Type: %s\r\n" type))
                         (mapconcat (lambda (header) (concat (car header) ": " (cdr header) "\r\n")) headers "")
                         "\r\n")
                 'utf-8))
          (content (cond (file (serve-cgi--file-bytes file))
                         ((multibyte-string-p body) (encode-coding-string body 'utf-8))
                         (t body))))
      ;; `princ' would write bytes above 127 as characters: this writes them as they are.
      (send-string-to-terminal (concat head content)))))

(defun serve-cgi--load-server ()
  "Load the project's server.el, compiled into the data directory.
It is compiled again when server.el is newer; the compiled file replaces
the old one in one step, for the requests that start meanwhile."
  (let ((server (expand-file-name "server.el" serve-project-directory))
        (compiled (expand-file-name "server.elc" app-server-data-directory)))
    (when (file-readable-p server)
      (unless (file-newer-than-file-p compiled server)
        (make-directory app-server-data-directory t)
        (let* ((fresh (make-temp-file (expand-file-name "server-" app-server-data-directory) nil ".elc"))
               (byte-compile-dest-file-function (lambda (_source) fresh))
               (byte-compile-verbose nil)
               (byte-compile-warnings nil))
          (if (ignore-errors (byte-compile-file server))
              (rename-file fresh compiled t)
            (ignore-errors (delete-file fresh)))))
      (if (file-newer-than-file-p compiled server)
          (load compiled nil t)
        (load server nil t)))))

(defun serve-cgi--start ()
  "Set up what serve-project.el and app-server.el need, from the environment."
  (let ((directory (file-name-as-directory
                    (expand-file-name (or (getenv "APP_DIRECTORY") default-directory))))
        (mysql (getenv "APP_MYSQL")))
    (setq serve-project-directory directory
          serve-project--root directory
          serve-project--true-root (file-name-as-directory (file-truename directory))
          app-server-data-directory (file-name-as-directory
                                     (expand-file-name (or (getenv "APP_DATA") ".data/") directory))
          ;; Many processes, one at each request: nothing is known to the next.
          app-server-shared t
          app-server-explain-errors nil
          app-server-mysql-keep t
          serve-project-log nil
          serve-project-respond-function #'serve-cgi--write)
    (when (and mysql (not (string-empty-p mysql)))
      (setq app-server-mysql mysql))
    (app-server-use-project directory)
    (serve-cgi--load-server)))

(defun serve-cgi--log (method target started)
  (when (and serve-cgi-log app-server-data-directory)
    (ignore-errors
      (let ((coding-system-for-write 'utf-8-unix))
        (write-region (format "%s %s %s %s %dms\n" (format-time-string "%FT%T%z") method
                              (replace-regexp-in-string "[\n\r ]" "_" target)
                              (car (split-string (or serve-cgi--status "-")))
                              (round (* 1000 (- (float-time) started))))
                      nil (expand-file-name serve-cgi-log app-server-data-directory) t 'silent)))))

(defun serve-cgi-main ()
  "Answer the request of the CGI variables and the standard input, and end."
  (let* ((started (float-time))
         (method (or (getenv "REQUEST_METHOD") "GET"))
         (query (getenv "QUERY_STRING"))
         (target (concat (or (getenv "PATH_INFO") "")
                         (and query (not (string-empty-p query)) (concat "?" query))))
         (length (string-to-number (or (getenv "CONTENT_LENGTH") "0"))))
    (condition-case err
        (progn
          (serve-cgi--start)
          (cond
           ((not (string-prefix-p "/api/" target))
            (serve-cgi--write "404 Not Found" "text/plain" "not found" serve-project-default-headers nil))
           ((> length serve-project-max-body)
            (serve-cgi--write "413 Content Too Large" "text/plain" "the request is too large"
                              serve-project-default-headers nil))
           (t
            (serve-project--handle nil method target (serve-cgi--headers) (serve-cgi--body length))
            ;; An answer that comes later (`app-server-defer'): wait here.
            (let ((deadline (+ started serve-cgi-timeout)))
              (while (and (not serve-cgi--status) (< (float-time) deadline))
                (accept-process-output nil 0.05)))
            (unless serve-cgi--status
              (serve-cgi--write "504 Gateway Timeout" "text/plain" "the answer did not come in time"
                                serve-project-default-headers nil)))))
      (error
       (message "serve-cgi: %s" (error-message-string err))
       (serve-cgi--write "500 Internal Server Error" "text/plain" "the server failed"
                         (and (boundp 'serve-project-default-headers) serve-project-default-headers) nil)))
    (when (and app-server--mysql-process (process-live-p app-server--mysql-process))
      (app-server--mysql-close app-server--mysql-process))
    (serve-cgi--log method target started)
    (kill-emacs 0)))

(provide 'serve-cgi)
;;; serve-cgi.el ends here
