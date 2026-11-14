;;; app-server.el --- what a project's server.el runs on  -*- lexical-binding: t; -*-

;; A project may have a server side: a file server.el that defines
;;
;;   (defun app-server-handle (method path body) ...)
;;
;; METHOD is "GET", "POST", ...; PATH is the request's path, "/api/...",
;; without its query (`app-server-parameter' gives the values of
;; ?name=value); BODY is the text of the request.  The function returns Lisp
;; data, which is printed as the response (the page reads it back with
;; `read').  An error it signals becomes a 400 response with the error's
;; message, the error `file-missing' a 404.
;;
;; The same server.el runs in two places:
;;
;;   in the studio   in a third Emacs in the browser tab; the application's
;;                   requests to /api/... are handed to it directly
;;   for real        in a native Emacs that is a web server
;;                   (tools/serve-project.el)
;;
;; This file is loaded before server.el in both.  It gives the server
;; places to keep data:
;;
;;   `app-server-read', `app-server-write'   Lisp values in files
;;   `app-server-database'                   an SQLite database, for
;;                                           `sqlite-execute' and `sqlite-select'
;;
;; SQLite is part of Emacs (29 and later, when Emacs was built with it; the
;; Emacs of wasmacs is).

;;; Code:

(require 'seq)
(require 'url-util)

(defvar app-server-data-directory "/data/"
  "Where `app-server-write' keeps its files.")

(defun app-server--data-file (name)
  (unless (string-match-p "\\`[A-Za-z0-9_-]+\\'" name)
    (error "Not a name for server data: %S" name))
  (expand-file-name (concat name ".eld") app-server-data-directory))

(defun app-server-read (name &optional default)
  "The Lisp value kept under NAME, or DEFAULT."
  (let ((file (app-server--data-file name)))
    (if (file-readable-p file)
        (with-temp-buffer
          (insert-file-contents file)
          (read (current-buffer)))
      default)))

(defun app-server-write (name value)
  "Keep the Lisp VALUE under NAME.  Returns VALUE."
  (let ((file (app-server--data-file name))
        (print-length nil) (print-level nil)
        (coding-system-for-write 'utf-8-unix))
    (make-directory (file-name-directory file) t)
    (with-temp-file file
      (prin1 value (current-buffer))
      (insert "\n")))
  value)

(defvar app-server--databases nil "Alist: name -> open SQLite database.")

(defun app-server-database (&optional name)
  "The SQLite database NAME (default \"app\") of this application.
It is a file in the server's data directory, opened on first use and
kept open.  Use it with `sqlite-execute' and `sqlite-select'; pass values
as parameters (\"... WHERE id = ?\" (list id)), never by building SQL
text from what a page sent."
  (unless (and (fboundp 'sqlite-available-p) (sqlite-available-p))
    (error "This Emacs has no SQLite support"))
  (let* ((name (or name "app"))
         (open (cdr (assoc name app-server--databases))))
    (if (and open (sqlitep open))
        open
      (unless (string-match-p "\\`[A-Za-z0-9_-]+\\'" name)
        (error "Not a name for a database: %S" name))
      (make-directory app-server-data-directory t)
      (let ((database (sqlite-open (expand-file-name (concat name ".db") app-server-data-directory))))
        (setf (alist-get name app-server--databases nil nil #'equal) database)
        database))))

(defvar app-server--parameters nil "The query of the request being answered: an alist.")

(defun app-server-parameter (name &optional default)
  "The value of ?NAME=... in the request being answered, or DEFAULT."
  (or (cadr (assoc name app-server--parameters)) default))

(defun app-server-respond (method path body)
  "Answer one request with `app-server-handle'.
PATH may end in a query (?name=value&...).  The value is a vector
[STATUS TEXT]: the HTTP status and the response body, printed Lisp data."
  (let* ((print-length nil) (print-level nil)
         (question (string-search "?" path))
         (app-server--parameters
          (and question (url-parse-query-string (substring path (1+ question)))))
         (path (if question (substring path 0 question) path)))
    (condition-case err
        (if (fboundp 'app-server-handle)
            (vector 200 (prin1-to-string (funcall 'app-server-handle method path body)))
          (vector 404 (prin1-to-string "This application has no server.el")))
      (file-missing (vector 404 (prin1-to-string (error-message-string err))))
      (error (vector 400 (prin1-to-string (error-message-string err)))))))

;;;; For the studio: the data of a server that lives in a browser tab

;; The tab's server keeps its data directory in memory.  The studio saves
;; it in the browser after a request that changed it and gives it back to
;; the next server.

(defun app-server--data-files ()
  "The files of the data directory, without SQLite's transient journals."
  (and (file-directory-p app-server-data-directory)
       (seq-remove (lambda (file) (string-suffix-p "-journal" file))
                   (directory-files app-server-data-directory t "\\`[^.]"))))

(defun app-server--signature ()
  "A string that changes when the data directory's files do."
  (mapconcat (lambda (file)
               (let ((attributes (file-attributes file)))
                 (format "%s:%d:%s" (file-name-nondirectory file)
                         (file-attribute-size attributes)
                         (format-time-string "%s%N" (file-attribute-modification-time attributes)))))
             (app-server--data-files) "|"))

(defun app-server--dump ()
  "The data directory: a vector of [FILE-NAME BASE64-CONTENT]."
  (vconcat
   (mapcar (lambda (file)
             (vector (file-name-nondirectory file)
                     (with-temp-buffer
                       (set-buffer-multibyte nil)
                       (insert-file-contents-literally file)
                       (base64-encode-string (buffer-string) t))))
           (app-server--data-files))))

(defun app-server--restore (entries)
  "Put back what `app-server--dump' returned."
  (make-directory app-server-data-directory t)
  (let ((coding-system-for-write 'no-conversion))
    (mapc (lambda (entry)
            (unless (string-match-p "\\`[A-Za-z0-9_.-]+\\'" (aref entry 0))
              (error "Not a data file name: %S" (aref entry 0)))
            (with-temp-file (expand-file-name (aref entry 0) app-server-data-directory)
              (set-buffer-multibyte nil)
              (insert (base64-decode-string (aref entry 1)))))
          entries))
  nil)

(provide 'app-server)
;;; app-server.el ends here
