;;; app-server.el --- what a project's server.el runs on  -*- lexical-binding: t; -*-

;; A project may have a server side: a file server.el that defines
;;
;;   (defun app-server-handle (method path body) ...)
;;
;; METHOD is "GET", "POST", ...; PATH is the request's path, "/api/...";
;; BODY is the text of the request.  The function returns Lisp data, which
;; is printed as the response (the page reads it back with `read').  An
;; error it signals becomes a 400 response with the error's message, the
;; error `file-missing' a 404.
;;
;; The same server.el runs in two places:
;;
;;   in the studio   in a third Emacs in the browser tab; the application's
;;                   requests to /api/... are handed to it directly
;;   for real        in a native Emacs that is a web server
;;                   (tools/serve-project.el)
;;
;; This file is loaded before server.el in both.  It gives the server a
;; place to keep data: `app-server-read' and `app-server-write'.

;;; Code:

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

(defun app-server-respond (method path body)
  "Answer one request with `app-server-handle'.
The value is a vector [STATUS TEXT]: the HTTP status and the response
body, printed Lisp data."
  (let ((print-length nil) (print-level nil))
    (condition-case err
        (if (fboundp 'app-server-handle)
            (vector 200 (prin1-to-string (funcall 'app-server-handle method path body)))
          (vector 404 (prin1-to-string "This application has no server.el")))
      (file-missing (vector 404 (prin1-to-string (error-message-string err))))
      (error (vector 400 (prin1-to-string (error-message-string err)))))))

;;;; For the studio: the data of a server that lives in a browser tab

(defun app-server--dump ()
  "Everything `app-server-write' keeps: a vector of [NAME TEXT]."
  (vconcat
   (and (file-directory-p app-server-data-directory)
        (mapcar (lambda (file)
                  (vector (file-name-base file)
                          (with-temp-buffer
                            (insert-file-contents file)
                            (buffer-string))))
                (directory-files app-server-data-directory t "\\.eld\\'")))))

(defun app-server--restore (entries)
  "Put back what `app-server--dump' returned."
  (make-directory app-server-data-directory t)
  (let ((coding-system-for-write 'utf-8-unix))
    (mapc (lambda (entry)
            (with-temp-file (app-server--data-file (aref entry 0))
              (insert (aref entry 1))))
          entries))
  nil)

(provide 'app-server)
;;; app-server.el ends here
