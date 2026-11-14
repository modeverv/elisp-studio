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
;; About the request and the answer, beyond the three arguments:
;;
;;   `app-server-parameter'                       ?name=value
;;   `app-server-refuse'                          answer with an error status
;;   `app-server-header', `app-server-cookie'     what came with the request
;;   `app-server-set-header', `app-server-set-cookie', `app-server-delete-cookie'
;;   `app-server-token'                           a random name for a session
;;   `app-server-password-hash-later', `app-server-password-check-later'
;;                                                see "Passwords" below
;;   `app-server-upload', `app-server-keep-upload', `app-server-file',
;;   `app-server-send-file'                       files (see "Files" below)
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

(defvar app-server-shared nil
  "Non-nil when several server processes share the data directory.
\(WORKERS=4 ./run.sh.)  What a handler keeps in a Lisp variable is then
known to one of them only: keep it with `app-server-write' or in the
database.")

(defun app-server-write (name value)
  "Keep the Lisp VALUE under NAME.  Returns VALUE.
The file is replaced in one step: a reader sees the old value or the new
one, never half of one."
  (let* ((file (app-server--data-file name))
         (print-length nil) (print-level nil)
         (coding-system-for-write 'utf-8-unix)
         (new (progn (make-directory (file-name-directory file) t)
                     (make-temp-file (concat file ".")))))
    (with-temp-file new
      (prin1 value (current-buffer))
      (insert "\n"))
    (set-file-modes new #o644)
    (rename-file new file t))
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
        ;; Another process may be writing (several workers, or the sqlite3
        ;; tool): wait for it instead of failing at once.
        (sqlite-pragma database "busy_timeout = 5000")
        ;; With several workers: readers and the one writer do not block
        ;; one another.
        (when app-server-shared (sqlite-pragma database "journal_mode = WAL"))
        (setf (alist-get name app-server--databases nil nil #'equal) database)
        database))))

(defvar app-server--tab nil "Non-nil in a server that lives in a browser tab.")

;;;; The request being answered

(cl-defstruct (app-server--request (:constructor app-server--request-create))
  parameters            ; the query: an alist (NAME VALUE)
  headers               ; alist (NAME . VALUE), names in lower case
  upload                ; (:file FILE :size BYTES :type STRING) when the body is a file
  response-headers)     ; list of (NAME . VALUE), newest first

(defvar app-server--request nil
  "The request being answered, also while functions of a deferred request run.")

(defun app-server--current-request ()
  (or app-server--request (error "No request is being answered")))

(defun app-server-parameter (name &optional default)
  "The value of ?NAME=... in the request being answered, or DEFAULT."
  (or (cadr (assoc name (app-server--request-parameters (app-server--current-request)))) default))

(define-error 'app-server-refusal "The request is refused")

(defun app-server-refuse (message &optional status)
  "Refuse the request being answered: MESSAGE is the response.
STATUS is the HTTP status, 400 by default: 401 for a visitor who has to
sign in, 403 for one who may not, 404 for what is not there."
  (signal 'app-server-refusal (list message (or status 400))))

(defun app-server-header (name)
  "The value of the header NAME of the request being answered, or nil.
Behind a reverse proxy, \"x-forwarded-for\" and \"x-forwarded-proto\" are
what the proxy says about the visitor; they can be believed because the
server only listens to this machine."
  (cdr (assoc (downcase name) (app-server--request-headers (app-server--current-request)))))

(defun app-server-cookie (name)
  "The value of the cookie NAME that came with the request, or nil."
  (let ((header (app-server-header "cookie")) value)
    (dolist (pair (and header (split-string header ";" t "[ \t]+")))
      (let ((equals (string-search "=" pair)))
        (when (and equals (not value) (equal (substring pair 0 equals) name))
          (setq value (decode-coding-string (url-unhex-string (substring pair (1+ equals))) 'utf-8)))))
    value))

(defun app-server-set-header (name value)
  "Send the header NAME: VALUE with the answer to the request."
  (unless (string-match-p "\\`[A-Za-z0-9-]+\\'" name)
    (error "Not a header name: %S" name))
  (when (member (downcase name) '("content-length" "content-type" "connection" "transfer-encoding"))
    (error "The server sets %s itself" name))
  ;; A line break in a value would start a header of the sender's choosing.
  (when (string-match-p "[\0-\x1f\x7f]" value)
    (error "A header value cannot contain control characters"))
  (push (cons name value) (app-server--request-response-headers (app-server--current-request)))
  nil)

(defun app-server-set-cookie (name value &rest attributes)
  "Give the visitor's browser the cookie NAME with VALUE (a string).
ATTRIBUTES is a plist:

:max-age SECONDS   how long the browser keeps it; without, until it closes
:path STRING       \"/\" by default
:http-only FLAG    hidden from the page's scripts; t by default
:secure FLAG       only over HTTPS; by default, when the request came
                   over HTTPS (the proxy's X-Forwarded-Proto)
:same-site STRING  \"Lax\" (default), \"Strict\" or \"None\""
  (unless (string-match-p "\\`[A-Za-z0-9_-]+\\'" name)
    (error "Not a cookie name: %S" name))
  (let ((path (or (plist-get attributes :path) "/"))
        (same-site (or (plist-get attributes :same-site) "Lax"))
        (max-age (plist-get attributes :max-age)))
    (unless (member same-site '("Lax" "Strict" "None")) (error "Not a SameSite value: %S" same-site))
    (when (string-match-p "[;\0-\x1f\x7f]" path) (error "Not a cookie path: %S" path))
    (app-server-set-header
     "Set-Cookie"
     (concat name "=" (url-hexify-string value) "; Path=" path
             (and max-age (format "; Max-Age=%d" max-age))
             (and (if (plist-member attributes :http-only) (plist-get attributes :http-only) t) "; HttpOnly")
             (and (if (plist-member attributes :secure)
                      (plist-get attributes :secure)
                    (equal (app-server-header "x-forwarded-proto") "https"))
                  "; Secure")
             "; SameSite=" same-site))))

(defun app-server-delete-cookie (name)
  "Make the visitor's browser forget the cookie NAME."
  (app-server-set-cookie name "" :max-age 0))

;;;; Files: what visitors send, and sending files back

;; The body of a request is text for the handler, a megabyte at most.  A
;; file is something else: the server writes it to disk as it arrives and
;; the handler gets its name.  Which requests bring a file is for server.el
;; to say, before any of it is taken:
;;
;;   (defun app-server-upload-p (method path size)
;;     (and (equal path "/api/photos") (app-visitor) (< size (* 200 1024 1024))))
;;
;;   ('("POST" "/api/photos")
;;    (let ((name (concat (app-server-token 8) ".jpg")))
;;      (app-server-keep-upload name)
;;      name))
;;   ('("GET" "/api/photo")
;;    (app-server-send-file (app-server-file (app-server-parameter "name")) :type "image/jpeg"))
;;
;; The page sends the file itself as the body (fetch with a File), not a
;; form.

(defun app-server-upload ()
  "The file that came as the body of the request being answered, or nil.
A plist (:file FILE :size BYTES :type STRING): FILE is a temporary file,
gone when the request is answered unless the handler moved it away
\(`app-server-keep-upload').  A request brings a file when server.el
defines `app-server-upload-p' and that says so."
  (app-server--request-upload (app-server--current-request)))

(defun app-server-file (name)
  "The file NAME among the files this application keeps.
NAME is letters, digits, dots, hyphens and underscores, not starting with
a dot: a name that came from a visitor cannot point anywhere else."
  (unless (string-match-p "\\`[A-Za-z0-9_-][A-Za-z0-9._-]*\\'" name)
    (error "Not a name for a kept file: %S" name))
  (let ((directory (expand-file-name "files/" app-server-data-directory)))
    (make-directory directory t)
    (expand-file-name name directory)))

(defun app-server-files ()
  "The names of the files this application keeps, in alphabetical order."
  (let ((directory (expand-file-name "files/" app-server-data-directory)))
    (and (file-directory-p directory) (directory-files directory nil "\\`[^.]"))))

(defun app-server-keep-upload (name)
  "Keep the file that came with the request as `(app-server-file NAME)'.
Returns its size in bytes."
  (let ((upload (or (app-server-upload) (error "This request brought no file"))))
    (rename-file (plist-get upload :file) (app-server-file name) t)
    (plist-get upload :size)))

(cl-defstruct (app-server--file-answer (:constructor app-server--file-answer-create))
  file type name)

(defun app-server-send-file (file &rest options)
  "Answer the request with FILE: return this from `app-server-handle'.
\(Or pass it to the RESPOND of `app-server-defer'.)  OPTIONS is a plist:
:type STRING is its media type (\"application/octet-stream\" by default);
with :name STRING the browser saves it under that name instead of
showing it.  FILE is usually
`(app-server-file NAME)'; do not make a file name out of what a visitor
sent in any other way."
  (unless (file-regular-p file) (signal 'file-missing (list "No such file" (file-name-nondirectory file))))
  (app-server--file-answer-create :file file :type (plist-get options :type) :name (plist-get options :name)))

(defun app-server--answer-body (data)
  "What a host sends for DATA, the handler's answer: printed text, or
\(:file FILE :type TYPE :name NAME) for `app-server-send-file'."
  (if (app-server--file-answer-p data)
      (list :file (app-server--file-answer-file data)
            :type (or (app-server--file-answer-type data) "application/octet-stream")
            :name (app-server--file-answer-name data))
    (let ((print-length nil) (print-level nil))
      (prin1-to-string data))))

(defun app-server-upload-accept (method path size headers)
  "For the host: does the request that begins with HEADERS bring a file?
The value is t (take the body into a file), nil (it is an ordinary
request) or, when server.el refused it, the answer [STATUS TEXT HEADERS]."
  (when (fboundp 'app-server-upload-p)
    (let* ((question (string-search "?" path))
           (app-server--request
            (app-server--request-create
             :parameters (and question (url-parse-query-string (substring path (1+ question))))
             :headers headers))
           (answer (lambda (status message)
                     (vector status (prin1-to-string message)
                             (reverse (app-server--request-response-headers app-server--request))))))
      (condition-case err
          (and (funcall 'app-server-upload-p method (if question (substring path 0 question) path) size) t)
        (app-server-refusal (funcall answer (nth 2 err) (nth 1 err)))
        (file-missing (funcall answer 404 (error-message-string err)))
        (error (funcall answer 400 (error-message-string err)))))))

(defun app-server-upload-file ()
  "For the host: a new temporary file to take an upload into."
  (let ((directory (expand-file-name "uploads/" app-server-data-directory)))
    (make-directory directory t)
    (expand-file-name (app-server-token 16) directory)))

(defun app-server-token (&optional bytes)
  "A random string nobody can guess: BYTES (default 32) random bytes in hex.
For the names of sessions and the like; `random' is not for that.  (In
the studio's browser tab, which nobody else can reach, it is what there
is: that Emacs has no better source.)"
  (let* ((bytes (or bytes 32))
         (data (with-temp-buffer
                 (set-buffer-multibyte nil)
                 (condition-case nil
                     (insert-file-contents-literally "/dev/urandom" nil 0 bytes)
                   ;; An older Emacs does not read part of a device.
                   (error (erase-buffer)
                          (ignore-errors
                            (let ((coding-system-for-read 'binary))
                              (call-process "head" "/dev/urandom" t nil "-c" (number-to-string bytes))))))
                 (buffer-string))))
    (cond ((= (length data) bytes))
          (app-server--tab
           (random t)
           (setq data (apply #'unibyte-string (cl-loop repeat bytes collect (random 256)))))
          (t (error "This system gives no random bytes")))
    (mapconcat (lambda (byte) (format "%02x" byte)) data "")))

;;;; Passwords

;; A password is never kept: what is kept is a hash made to be slow, so
;; that whoever gets hold of the database cannot try a billion guesses a
;; second.  This is PBKDF2 with HMAC-SHA-256 (RFC 8018), 600,000 rounds
;; (OWASP's number for it), written with Emacs's own `secure-hash'.
;;
;; Slow means slow for the server too: about three seconds of one core.
;; So that nobody else waits, `app-server-password-hash-later' and
;; `app-server-password-check-later' give the work to a second Emacs:
;;
;;   ('("POST" "/api/login")
;;    (pcase-let ((`(,name ,password) (car (read-from-string body))))
;;      (app-server-defer
;;       (lambda (respond fail)
;;         (app-server-password-check-later
;;          password (app-stored-hash name)
;;          (lambda (right)
;;            (if (not right)
;;                (funcall fail "Wrong name or password" 401)
;;              (app-server-set-cookie "session" (app-new-session name))
;;              (funcall respond t))))))))

(defvar app-server-password-rounds 600000
  "How many rounds a new password hash gets.
A hash says how many it has, so hashes made with another number stay
valid.")

(defconst app-server--file (or load-file-name buffer-file-name)
  "This file, for the second Emacs that hashes passwords.")

(defun app-server--pbkdf2 (password salt rounds)
  "PBKDF2-HMAC-SHA-256 of PASSWORD and SALT, unibyte strings: 32 bytes in hex."
  (let* ((key (if (> (length password) 64) (secure-hash 'sha256 password nil nil t) password))
         (block (concat key (make-string (- 64 (length key)) 0)))
         (inner (apply #'unibyte-string (mapcar (lambda (byte) (logxor byte #x36)) block)))
         (outer (apply #'unibyte-string (mapcar (lambda (byte) (logxor byte #x5c)) block)))
         (u (secure-hash 'sha256
                         (concat outer (secure-hash 'sha256 (concat inner salt (unibyte-string 0 0 0 1))
                                                    nil nil t))
                         nil nil t))
         (total (vconcat u)))
    (dotimes (_ (1- rounds))
      (setq u (secure-hash 'sha256 (concat outer (secure-hash 'sha256 (concat inner u) nil nil t))
                           nil nil t))
      (dotimes (index 32) (aset total index (logxor (aref total index) (aref u index)))))
    (mapconcat (lambda (byte) (format "%02x" byte)) total "")))

;; Its loop runs millions of times: compiled, whatever loaded this file.
(defvar byte-compile-warnings)
(unless (byte-code-function-p (symbol-function 'app-server--pbkdf2))
  (ignore-errors
    (require 'bytecomp)
    (let ((byte-compile-warnings nil))
      (byte-compile 'app-server--pbkdf2))))

(defun app-server-password-hash (password)
  "A hash of PASSWORD, to keep instead of it.
It reads \"pbkdf2-sha256$ROUNDS$SALT$HASH\".  Takes seconds, during which
this Emacs does nothing else; in a handler use
`app-server-password-hash-later'."
  (let ((salt (app-server-token 16)))
    (format "pbkdf2-sha256$%d$%s$%s" app-server-password-rounds salt
            (app-server--pbkdf2 (encode-coding-string password 'utf-8) salt app-server-password-rounds))))

(defun app-server-password-check (password hash)
  "Non-nil if PASSWORD is the one HASH was made of (`app-server-password-hash').
Takes as long as making the hash did; in a handler use
`app-server-password-check-later'."
  (let ((parts (split-string (or hash "") "\\$")))
    (and (= (length parts) 4)
         (equal (nth 0 parts) "pbkdf2-sha256")
         (string-match-p "\\`[0-9]+\\'" (nth 1 parts))
         (let ((mine (app-server--pbkdf2 (encode-coding-string password 'utf-8) (nth 2 parts)
                                         (string-to-number (nth 1 parts))))
               (theirs (nth 3 parts))
               (difference 0))
           ;; Compare all of it: how long this takes says nothing about
           ;; where the first difference is.
           (and (= (length mine) (length theirs))
                (progn (dotimes (index (length mine))
                         (setq difference (logior difference (logxor (aref mine index) (aref theirs index)))))
                       (= difference 0)))))))

(defun app-server--password-later (form function)
  "Evaluate FORM, which hashes, in a second Emacs; FUNCTION gets its value.
Without programs to run (the studio's browser tab) it is done here."
  (if app-server--tab
      (funcall function (apply (car form) (nthcdr 2 form)))
    (app-server-run
     (list (expand-file-name invocation-name invocation-directory) "--batch" "-Q"
           "-l" app-server--file "--eval" "(app-server--password-child)")
     ;; The password goes in by the pipe, not on the command line, where
     ;; other users of the machine could read it.
     :input (base64-encode-string (encode-coding-string (prin1-to-string form) 'utf-8) t)
     :then (lambda (result)
             (unless (eq (plist-get result :status) 0) (error "The password could not be hashed"))
             (funcall function (car (read-from-string (plist-get result :output))))))))

(defun app-server--password-child ()
  "In the second Emacs: evaluate the form on standard input, print its value."
  (let* ((text (with-temp-buffer (insert-file-contents "/dev/stdin") (buffer-string)))
         (form (car (read-from-string (decode-coding-string (base64-decode-string text) 'utf-8)))))
    ;; Only the two forms this file sends.
    (unless (memq (car form) '(app-server-password-hash app-server-password-check))
      (kill-emacs 2))
    (setq app-server-password-rounds (nth 1 form))
    (prin1 (apply (car form) (nthcdr 2 form)))))

(defun app-server-password-hash-later (password function)
  "Hash PASSWORD without holding up the server; FUNCTION gets the hash.
For use inside `app-server-defer'."
  (app-server--password-later (list 'app-server-password-hash app-server-password-rounds password)
                              (app-server--guard function)))

(defun app-server-password-check-later (password hash function)
  "Check PASSWORD against HASH without holding up the server.
FUNCTION gets t or nil.  For use inside `app-server-defer'."
  (app-server--password-later (list 'app-server-password-check app-server-password-rounds password hash)
                              (app-server--guard function)))

;;;; Answering later

(cl-defstruct (app-server--deferred (:constructor app-server--deferred-create))
  function)

(defvar app-server-deferred-timeout 30
  "Seconds after which a deferred request is answered with an error (504).")

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
  (let ((fail app-server--fail)
        (request app-server--request))
    (lambda (&rest arguments)
      (condition-case err
          (let ((app-server--fail fail)
                (app-server--request request))
            (apply function arguments))
        (app-server-refusal
         (when fail (funcall fail (nth 1 err) (nth 2 err))))
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

(defun app-server-respond (method path body &optional later headers upload)
  "Answer one request with `app-server-handle'.
PATH may end in a query (?name=value&...).  HEADERS is the request's
headers, an alist (NAME . VALUE) with the names in lower case.  The value
is a vector [STATUS TEXT HEADERS]: the HTTP status, the response body
(printed Lisp data) and the headers the handler asked for, a list of
\(NAME . VALUE).  When the handler answers with a file
\(`app-server-send-file'), TEXT is (:file FILE :type TYPE :name NAME).
UPLOAD is (:file FILE :size BYTES :type STRING) when the body went into a
file (`app-server-upload-accept'); BODY is then empty.

If the handler defers its answer (`app-server-defer'), the value is nil
and LATER, a function of (STATUS TEXT HEADERS), is called when the answer
is there.  A host that passes no LATER cannot wait: the request fails."
  (let* ((print-length nil) (print-level nil)
         (question (string-search "?" path))
         (app-server--request
          (app-server--request-create
           :parameters (and question (url-parse-query-string (substring path (1+ question))))
           :headers headers :upload upload))
         (path (if question (substring path 0 question) path))
         (answer (lambda (status data)
                   (vector status (app-server--answer-body data)
                           (reverse (app-server--request-response-headers app-server--request))))))
    (condition-case err
        (if (fboundp 'app-server-handle)
            (let ((value (funcall 'app-server-handle method path body)))
              (cond ((not (app-server--deferred-p value)) (funcall answer 200 value))
                    ((not later) (funcall answer 500 "This server cannot answer later"))
                    (t (app-server--start-deferred value later))))
          (funcall answer 404 "This application has no server.el"))
      (app-server-refusal (funcall answer (nth 2 err) (nth 1 err)))
      (file-missing (funcall answer 404 (error-message-string err)))
      (error (funcall answer 400 (error-message-string err))))))

(defun app-server--start-deferred (deferred later)
  "Run DEFERRED's function; LATER (STATUS TEXT HEADERS) gets the answer, once.
Returns nil, or [STATUS TEXT HEADERS] if the function answered right away."
  (let* ((answered nil)
         (request app-server--request)
         (timeout nil)
         (answer (lambda (status data)
                   (unless answered
                     (setq answered t)
                     (when timeout (cancel-timer timeout))
                     (funcall later status (app-server--answer-body data)
                              (reverse (app-server--request-response-headers request))))))
         (respond (lambda (data) (funcall answer 200 data)))
         (fail (lambda (message &optional status) (funcall answer (or status 400) message)))
         (now nil))
    ;; Until the function has returned, an answer is the value of
    ;; `app-server-respond' itself rather than something for LATER.
    (let ((later-for-real later))
      (setq later (lambda (status text headers) (setq now (vector status text headers))))
      (let ((app-server--fail fail))
        (condition-case err
            (funcall (app-server--deferred-function deferred) respond fail)
          (app-server-refusal (funcall fail (nth 1 err) (nth 2 err)))
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
  "The files of the data directory and of files/ in it (kept uploads).
Without SQLite's transient journals and uploads that are under way."
  (and (file-directory-p app-server-data-directory)
       (seq-filter (lambda (file) (and (file-regular-p file) (not (string-suffix-p "-journal" file))))
                   (append (directory-files app-server-data-directory t "\\`[^.]")
                           (let ((kept (expand-file-name "files/" app-server-data-directory)))
                             (and (file-directory-p kept) (directory-files kept t "\\`[^.]")))))))

(defun app-server--data-name (file)
  "FILE of the data directory as the studio names it: NAME or files/NAME."
  (file-relative-name file app-server-data-directory))

(defun app-server--signature ()
  "A string that changes when the data directory's files do."
  (mapconcat (lambda (file)
               (let ((attributes (file-attributes file)))
                 (format "%s:%d:%s" (app-server--data-name file)
                         (file-attribute-size attributes)
                         (format-time-string "%s%N" (file-attribute-modification-time attributes)))))
             (app-server--data-files) "|"))

(defun app-server--dump ()
  "The data directory: a vector of [FILE-NAME BASE64-CONTENT]."
  (vconcat
   (mapcar (lambda (file)
             (vector (app-server--data-name file)
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
            (unless (string-match-p "\\`\\(?:files/\\)?[A-Za-z0-9_-][A-Za-z0-9_.-]*\\'" (aref entry 0))
              (error "Not a data file name: %S" (aref entry 0)))
            (make-directory (file-name-directory (expand-file-name (aref entry 0) app-server-data-directory)) t)
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
        ;; This Emacs is some ten times slower than a native one and nobody
        ;; else can reach it: hashes made here are for trying things out.
        app-server-password-rounds 10000
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
\(:commands [[ID COMMAND ARGUMENT] ...] :finished [[ID STATUS TEXT HEADERS] ...])."
  (prog1 (list :commands (vconcat (mapcar #'vconcat (nreverse app-server--tab-commands)))
               :finished (vconcat (mapcar #'vconcat (nreverse app-server--tab-finished))))
    (setq app-server--tab-commands nil app-server--tab-finished nil)))

(defun app-server--tab-headers (headers)
  "The response HEADERS, a list of (NAME . VALUE), as [[NAME VALUE] ...]."
  (vconcat (mapcar (lambda (header) (vector (car header) (cdr header))) headers)))

(defun app-server--tab-body (body)
  "BODY of an answer for the page: text, or a file as (:base64 ... :type ...)."
  (if (stringp body)
      body
    (list :base64 (with-temp-buffer
                    (set-buffer-multibyte nil)
                    (insert-file-contents-literally (plist-get body :file))
                    (base64-encode-string (buffer-string) t))
          :type (plist-get body :type) :name (plist-get body :name))))

(defun app-server-tab-request (method path body &optional headers upload)
  "Answer a request of the page's application.
HEADERS is a plist (:cookie \"...\" :content-type \"...\").  UPLOAD, when the
body is not text, is (:base64 STRING :type STRING).  The value is
\(:answer [STATUS BODY HEADERS]) or, when the answer comes later,
\(:pending ID); in both cases with the :commands and :finished of
`app-server--tab-events'.  In an answer, HEADERS is [[NAME VALUE] ...] and
BODY is text or (:base64 STRING :type STRING :name STRING) for a file."
  (let* ((id (cl-incf app-server--tab-next))
         (alist (cl-loop for (name value) on headers by #'cddr
                         collect (cons (downcase (substring (symbol-name name) 1)) value)))
         (bytes (and upload (base64-decode-string (plist-get upload :base64))))
         (accept (and bytes (app-server-upload-accept method path (length bytes) alist)))
         (file (and (eq accept t) (app-server-upload-file)))
         (done (lambda () (when file (ignore-errors (delete-file file)))))
         (answer
          (cond
           ((vectorp accept) accept)
           ;; Not a file for server.el: text, if it is not too much of it.
           ((and bytes (not accept) (> (length bytes) (* 1024 1024)))
            (vector 413 "Content Too Large" nil))
           (t
            (when file
              (let ((coding-system-for-write 'binary))
                (write-region bytes nil file nil 'silent)))
            (app-server-respond
             method path (cond (file "") (bytes (decode-coding-string bytes 'utf-8)) (t body))
             (lambda (status body headers)
               (push (list id status (app-server--tab-body body) (app-server--tab-headers headers))
                     app-server--tab-finished)
               (funcall done))
             alist
             (and file (list :file file :size (length bytes)
                             :type (or (plist-get upload :type) "application/octet-stream"))))))))
    (when answer (funcall done))
    (append (if answer
                (list :answer (vector (aref answer 0) (app-server--tab-body (aref answer 1))
                                      (app-server--tab-headers (aref answer 2))))
              (list :pending id))
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
