;;; server.el --- the server side of your application  -*- lexical-binding: t; -*-

;; Requests of the page to /api/... come here.  Return Lisp data: the page
;; gets it printed and reads it back.  Signal an error to refuse a request.
;;
;; In the studio this file runs in an Emacs of its own inside the browser
;; tab, and saving it takes effect at once.  The same file runs under a
;; native Emacs as a real web server: tools/serve-project.sh in elisp-studio.
;;
;; `app-server-read' and `app-server-write' keep Lisp data between requests.

(defun app-messages ()
  "The messages the server keeps."
  (app-server-read "messages" '("Hello from the server's Emacs")))

(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/messages") (app-messages))
    ('("POST" "/api/messages")
     ;; The body is a printed string.  `read' makes data of it; nothing a
     ;; page sends is ever evaluated.
     (let ((text (car (read-from-string body))))
       (unless (and (stringp text) (not (string-empty-p (string-trim text))))
         (error "A message needs some text"))
       (app-server-write "messages" (append (app-messages) (list (string-trim text))))))
    (_ (signal 'file-missing (list "No such API" path)))))
