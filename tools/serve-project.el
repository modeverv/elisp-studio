;;; serve-project.el --- run a studio project under a native Emacs  -*- lexical-binding: t; -*-

;; A project made in the studio is a directory: index.html, app.el,
;; style.css, and perhaps server.el.  This file makes a native Emacs the web
;; server of such a directory: it serves the files, and it answers
;; /api/... with the project's server.el, the same file that ran in the
;; browser tab while the project was written (lisp/app-server.el).
;;
;;   tools/serve-project.sh DIRECTORY [PORT]
;;
;; The page still runs its Emacs Lisp in the visitor's browser (the Emacs
;; of the wasmacs site); this Emacs is the server side only.  What the
;; server keeps with `app-server-write' goes to DIRECTORY/.data/, which is
;; not served.
;;
;; It listens on 127.0.0.1.  A request body is data for server.el; this
;; file evaluates nothing it receives.  Requests to /api/ that a page of
;; another site makes are refused.

(require 'cl-lib)
(require 'subr-x)

(defvar serve-project-directory default-directory "The project.")
(defvar serve-project-port 8018)
(defvar serve-project--process nil)

(load (expand-file-name "../lisp/app-server.el" (file-name-directory (or load-file-name buffer-file-name))) nil t)

(defconst serve-project--types
  '(("html" . "text/html; charset=utf-8") ("css" . "text/css; charset=utf-8")
    ("js" . "text/javascript") ("json" . "application/json")
    ("el" . "text/plain; charset=utf-8") ("png" . "image/png") ("svg" . "image/svg+xml")))

(defun serve-project--file (path)
  "The file of the project that the URL PATH names, or nil."
  (let* ((root (file-name-as-directory (expand-file-name serve-project-directory)))
         (file (expand-file-name (substring (decode-coding-string (url-unhex-string path) 'utf-8) 1) root)))
    (when (file-directory-p file) (setq file (expand-file-name "index.html" file)))
    (and (string-prefix-p (file-truename root) (file-truename file))
         (not (string-match-p "\\(?:\\`\\|/\\)\\." (file-relative-name file root)))
         ;; The server's own program is not for download.
         (not (equal (file-relative-name file root) "server.el"))
         (file-regular-p file)
         file)))

(defun serve-project--respond (process status type body)
  (process-send-string
   process
   (concat (format "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
                   status type (string-bytes body))
           body))
  (delete-process process))

(defconst serve-project--reasons '((200 . "OK") (400 . "Bad Request") (404 . "Not Found")))

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
        (let ((answer (app-server-respond method path (decode-coding-string body 'utf-8))))
          (serve-project--respond
           process (format "%d %s" (aref answer 0) (cdr (assq (aref answer 0) serve-project--reasons)))
           "application/x-emacs-lisp; charset=utf-8"
           (encode-coding-string (aref answer 1) 'utf-8)))))
     ((not (member method '("GET" "HEAD")))
      (serve-project--respond process "405 Method Not Allowed" "text/plain" "method not allowed"))
     (t
      (let ((file (serve-project--file path)))
        (if (not file)
            (serve-project--respond process "404 Not Found" "text/plain" "not found")
          (serve-project--respond
           process "200 OK"
           (or (cdr (assoc (file-name-extension file) serve-project--types)) "application/octet-stream")
           (with-temp-buffer
             (set-buffer-multibyte nil)
             (insert-file-contents-literally file)
             (buffer-string)))))))))

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
              ((>= (string-bytes body) length)
               (condition-case err
                   (serve-project--handle process (nth 0 request) (or (nth 1 request) "/") headers
                                          (substring body 0 length))
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
  (let ((server (expand-file-name "server.el" serve-project-directory)))
    (when (file-readable-p server) (load server nil t)))
  (setq serve-project--process
        (make-network-process :name "serve-project" :server t :host "127.0.0.1" :family 'ipv4
                              :service serve-project-port :coding 'binary :noquery t
                              :filter #'serve-project--filter))
  (message "serve-project: http://127.0.0.1:%d/ (%s)" serve-project-port serve-project-directory))

(defun serve-project-run ()
  "Start the server and serve until Emacs is killed (for batch mode)."
  (serve-project-start)
  (while t (accept-process-output nil 1)))

(provide 'serve-project)
;;; serve-project.el ends here
