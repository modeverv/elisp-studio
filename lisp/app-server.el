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
;; A handler that has to wait for something (another server, a moment to
;; pass) need not make everyone else wait.  It returns `app-server-defer':
;;
;;   ('("GET" "/api/rates")
;;    (app-server-defer
;;     (lambda (respond _fail)
;;       (app-server-fetch "https://example.com/rates.json"
;;                         :then (lambda (response)
;;                                 (funcall respond (plist-get response :text)))))))
;;
;; The request stays open, the server goes on with other requests, and the
;; answer is sent when RESPOND is called.  There are three things to wait
;; for: `app-server-fetch' (another server), `app-server-after' (a moment)
;; and, under a native Emacs only, `app-server-run' (a program).
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

(require 'cl-lib)
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

;;;; Answering later

(cl-defstruct (app-server--deferred (:constructor app-server--deferred-create))
  function)

(defvar app-server-deferred-timeout 30
  "Seconds after which a deferred request is answered with an error (504).")

(defvar app-server--tab nil "Non-nil in a server that lives in a browser tab.")

(defvar app-server--fail nil
  "While code of a deferred request runs: the function that fails that request.")

(defun app-server-defer (function)
  "Return this from `app-server-handle' to answer the request later.
FUNCTION is called at once with two functions, RESPOND and FAIL.  It
starts whatever the answer depends on (`app-server-fetch',
`app-server-after') and returns; the server then goes on with other
requests.  The request is answered when (funcall RESPOND DATA) is
called, or (funcall FAIL MESSAGE [STATUS]); whichever comes first
counts.  An error in the functions that run later fails the request, and
so does `app-server-deferred-timeout'."
  (app-server--deferred-create :function function))

(defun app-server--guard (function)
  "FUNCTION, wrapped for running later on behalf of the current request.
An error it signals fails that request instead of being lost."
  (let ((fail app-server--fail))
    (lambda (&rest arguments)
      (condition-case err
          (let ((app-server--fail fail))
            (apply function arguments))
        (error
         (if fail
             (funcall fail (error-message-string err))
           (message "app-server: %s" (error-message-string err))))))))

;; What there is to wait for.  The two hosts do these differently: a native
;; Emacs has timers and its own HTTP client; in a browser tab the page does
;; both (see "For the studio" below).

(defvar app-server-after-function
  (lambda (seconds function) (run-at-time seconds nil function))
  "Function of (SECONDS FUNCTION) that calls FUNCTION after SECONDS.")

(defvar app-server-fetch-function #'app-server--url-fetch
  "Function of (URL METHOD HEADERS BODY THEN CATCH) that makes an HTTP request.
THEN is called with (:status N :ok BOOLEAN :text STRING), or CATCH with a
message when there was no response.")

(defvar app-server-run-function #'app-server--make-process
  "Function of (COMMAND INPUT THEN) that runs a program; see `app-server-run'.")

(defun app-server-after (seconds function)
  "Call FUNCTION, without arguments, after SECONDS.  Returns at once."
  (funcall app-server-after-function seconds (app-server--guard function))
  nil)

(defun app-server-fetch (url &rest options)
  "Make an HTTP request to URL; return at once.  OPTIONS is a plist:

:method STRING   \"GET\" by default
:headers PLIST   (:content-type \"application/json\")
:body STRING
:then FUNCTION   (RESPONSE), a plist (:status 200 :ok t :text \"...\");
                 an HTTP error status is a response too, with :ok nil
:catch FUNCTION  (MESSAGE), when there was no response at all; without
                 it, that fails the deferred request"
  (let ((then (plist-get options :then))
        (catch (plist-get options :catch)))
    (funcall app-server-fetch-function url
             (or (plist-get options :method) "GET")
             (plist-get options :headers)
             (plist-get options :body)
             (app-server--guard (or then #'ignore))
             (app-server--guard (or catch (lambda (message) (error "%s: %s" url message))))))
  nil)

(defun app-server-run (command &rest options)
  "Run a program without waiting for it; return at once.
COMMAND is a list: the program and its arguments (no shell reads it).
OPTIONS is a plist:

:input STRING    what the program reads
:then FUNCTION   (RESULT), a plist (:status 0 :output \"...\"), when the
                 program has ended

This is how a server gives long work to another process, a second Emacs
for instance, and stays free meanwhile.  Only a native Emacs can: in the
studio's browser tab there are no programs, and the request fails."
  (funcall app-server-run-function command (plist-get options :input)
           (app-server--guard (or (plist-get options :then) #'ignore)))
  nil)

(defun app-server--make-process (command input then)
  "`app-server-run' for a native Emacs."
  (let* ((buffer (generate-new-buffer " *app-server-run*"))
         (process
          (make-process
           :name "app-server-run" :buffer buffer :command command :connection-type 'pipe
           :noquery t :coding 'utf-8
           :sentinel (lambda (process _event)
                       (unless (process-live-p process)
                         (let ((output (with-current-buffer buffer (buffer-string))))
                           (kill-buffer buffer)
                           (funcall then (list :status (process-exit-status process) :output output))))))))
    (when input (process-send-string process input))
    (process-send-eof process)))

(defun app-server--url-fetch (url method headers body then catch)
  "`app-server-fetch' for a native Emacs: url.el, without waiting."
  (require 'url)
  (let ((url-request-method method)
        (url-request-data (and body (encode-coding-string body 'utf-8)))
        (url-request-extra-headers
         (let (list)
           (while headers
             (push (cons (substring (symbol-name (car headers)) 1) (format "%s" (cadr headers))) list)
             (setq headers (cddr headers)))
           list)))
    (url-retrieve
     url
     (lambda (status)
       (let ((buffer (current-buffer))
             (code (and (boundp 'url-http-response-status) url-http-response-status))
             (end (and (boundp 'url-http-end-of-headers) url-http-end-of-headers)))
         (unwind-protect
             (if (and (integerp code) end)
                 (funcall then (list :status code :ok (and (>= code 200) (< code 300) t)
                                     :text (decode-coding-string
                                            (buffer-substring-no-properties (min (1+ end) (point-max)) (point-max))
                                            'utf-8)))
               (funcall catch (format "%s" (or (plist-get status :error) "no response"))))
           (kill-buffer buffer))))
     nil t t)))

;;;; Requests

(defun app-server-respond (method path body &optional later)
  "Answer one request with `app-server-handle'.
PATH may end in a query (?name=value&...).  The value is a vector
[STATUS TEXT]: the HTTP status and the response body, printed Lisp data.

If the handler defers its answer (`app-server-defer'), the value is nil
and LATER, a function of (STATUS TEXT), is called when the answer is
there.  A host that passes no LATER cannot wait: the request fails."
  (let* ((print-length nil) (print-level nil)
         (question (string-search "?" path))
         (app-server--parameters
          (and question (url-parse-query-string (substring path (1+ question)))))
         (path (if question (substring path 0 question) path)))
    (condition-case err
        (if (fboundp 'app-server-handle)
            (let ((value (funcall 'app-server-handle method path body)))
              (cond ((not (app-server--deferred-p value))
                     (vector 200 (prin1-to-string value)))
                    ((not later)
                     (vector 500 (prin1-to-string "This server cannot answer later")))
                    (t (app-server--start-deferred value later))))
          (vector 404 (prin1-to-string "This application has no server.el")))
      (file-missing (vector 404 (prin1-to-string (error-message-string err))))
      (error (vector 400 (prin1-to-string (error-message-string err)))))))

(defun app-server--start-deferred (deferred later)
  "Run DEFERRED's function; LATER (STATUS TEXT) gets the answer, once.
Returns nil, or [STATUS TEXT] if the function failed right away."
  (let* ((answered nil)
         (timeout nil)
         (answer (lambda (status data)
                   (unless answered
                     (setq answered t)
                     (when timeout (cancel-timer timeout))
                     (let ((print-length nil) (print-level nil))
                       (funcall later status (prin1-to-string data))))))
         (respond (lambda (data) (funcall answer 200 data)))
         (fail (lambda (message &optional status) (funcall answer (or status 400) message)))
         (now nil))
    ;; Until the function has returned, an answer is the value of
    ;; `app-server-respond' itself rather than something for LATER.
    (let ((later-for-real later))
      (setq later (lambda (status text) (setq now (vector status text))))
      (let ((app-server--fail fail))
        (condition-case err
            (funcall (app-server--deferred-function deferred) respond fail)
          (error (funcall fail (error-message-string err))))
        ;; In a browser tab the page gives up by itself.
        (unless (or answered app-server--tab)
          (setq timeout (run-at-time app-server-deferred-timeout nil fail
                                     "The server did not answer in time" 504))))
      (setq later later-for-real))
    now))

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

;;;; For the studio: waiting, in a server that lives in a browser tab

;; That Emacs runs only while it answers a call of the page; it has no
;; timers and no network of its own.  So the page waits for it: what
;; `app-server-after' and `app-server-fetch' ask for is collected here, the
;; page does it (setTimeout, fetch) and reports back, and deferred answers
;; that are complete are collected for the page to deliver.

(defvar app-server--tab-next 0)
(defvar app-server--tab-commands nil "Work for the page: (ID COMMAND ARGUMENT), newest first.")
(defvar app-server--tab-waiting (make-hash-table) "ID -> function (OK VALUE) for the page's report.")
(defvar app-server--tab-finished nil "Deferred answers that are ready: (ID STATUS TEXT), newest first.")

(defun app-server--tab-command (command argument function)
  (let ((id (cl-incf app-server--tab-next)))
    (puthash id function app-server--tab-waiting)
    (push (list id command argument) app-server--tab-commands)))

(defun app-server-use-tab-host ()
  "Let the page do the waiting (this Emacs lives in a browser tab)."
  (setq app-server--tab t
        app-server-after-function
        (lambda (seconds function)
          (app-server--tab-command "timeout" (round (* 1000 seconds)) (lambda (_ok _value) (funcall function))))
        app-server-run-function
        (lambda (&rest _) (error "A server in a browser tab cannot run programs"))
        app-server-fetch-function
        (lambda (url method headers body then catch)
          (app-server--tab-command "fetch" (list :url url :method method :headers headers :body body)
                                   (lambda (ok value) (funcall (if ok then catch) value))))))

(defun app-server--tab-events ()
  "What happened since the last call, for the page:
\(:commands [[ID COMMAND ARGUMENT] ...] :finished [[ID STATUS TEXT] ...])."
  (prog1 (list :commands (vconcat (mapcar #'vconcat (nreverse app-server--tab-commands)))
               :finished (vconcat (mapcar #'vconcat (nreverse app-server--tab-finished))))
    (setq app-server--tab-commands nil app-server--tab-finished nil)))

(defun app-server-tab-request (method path body)
  "Answer a request of the page's application.
The value is (:answer [STATUS TEXT]) or, when the answer comes later,
\(:pending ID); in both cases with the :commands and :finished of
`app-server--tab-events'."
  (let* ((id (cl-incf app-server--tab-next))
         (answer (app-server-respond method path body
                                     (lambda (status text) (push (list id status text) app-server--tab-finished)))))
    (append (if answer (list :answer answer) (list :pending id))
            (app-server--tab-events))))

(defun app-server-tab-report (id ok value)
  "The page has done the command ID: OK and VALUE are its result.
Returns `app-server--tab-events'."
  (let ((function (gethash id app-server--tab-waiting)))
    (remhash id app-server--tab-waiting)
    (when function (funcall function ok value)))
  (app-server--tab-events))

(provide 'app-server)
;;; app-server.el ends here
