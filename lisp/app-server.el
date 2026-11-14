;;; app-server.el --- what a project's server.el runs on  -*- lexical-binding: t; -*-

;; A project may have a server side: a file server.el that defines
;;
;;   (defun app-server-handle (method path body) ...)
;;
;; METHOD is "GET", "POST", ...; PATH is the request's path, "/api/...",
;; without its query (`app-server-parameter' gives the values of
;; ?name=value); BODY is the text of the request (`app-server-data' reads it
;; as Lisp data).  The function returns Lisp
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
;;   `app-server-data'                            the body, read as data
;;   `app-server-parameter'                       ?name=value
;;   `app-server-refuse'                          answer with an error status
;;   `app-server-header', `app-server-cookie'     what came with the request
;;   `app-server-set-header', `app-server-set-cookie', `app-server-delete-cookie'
;;   `app-server-token'                           a random name for a session
;;   `app-server-password-hash-later', `app-server-password-check-later'
;;                                                see "Passwords" below
;;   `app-server-session-start', `app-server-session', `app-server-session-end',
;;   `app-server-attempts-check'                  see "Signing in" below
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

;; What a page sends is data, never a program.  Reading it with Emacs's
;; reader has a cost of its own, though: every name the reader has not seen
;; before becomes a symbol that Emacs keeps for good, so a visitor who
;; sends bodies full of new names fills the server's memory (measured: 80
;; requests, 500 MB).  `app-server-data' reads without that.

(defun app-server-data (text &optional default)
  "The Lisp data that TEXT, the body of a request, is the printed form of.
An empty TEXT is DEFAULT.  The data is strings, numbers, lists, vectors
and symbols that this Emacs already knows (the keywords and names
server.el itself uses, nil and t).  Anything else is refused: a name
nobody here uses, a structure that goes round in circles or is too
large, an object that is not plain data.  Nothing a visitor sends stays
in Emacs afterwards.  Use this, not `read', on what comes from outside."
  (if (string-match-p "\\`[ \t\r\n]*\\'" text)
      default
    (let* ((own (obarray-make 31))
           (value (let ((obarray own))
                    (condition-case nil
                        (car (read-from-string text))
                      (error (error "The request is not Lisp data")))))
           (left 200000))
      (cl-labels
          ((clean (data depth)
             (when (or (> depth 64) (< (setq left (1- left)) 0))
               (error "The request holds too much data"))
             (cond ((stringp data) (substring-no-properties data))
                   ((numberp data) data)
                   ((symbolp data)
                    (let ((name (symbol-name data)))
                      (cond ((equal name "nil") nil)
                            ((intern-soft name))      ; the symbol this Emacs knows by that name
                            (t (error "The request names something unknown: %s"
                                      (truncate-string-to-width name 40))))))
                   ((consp data)
                    ;; Along the list in a loop, so that a long list is not a deep one.
                    (let ((result nil))
                      (while (consp data)
                        (push (clean (car data) (1+ depth)) result)
                        (setq data (cdr data))
                        (when (< (setq left (1- left)) 0) (error "The request holds too much data")))
                      (let ((list (nreverse result)))
                        (when data (setcdr (last list) (clean data (1+ depth))))
                        list)))
                   ((and (vectorp data) (not (byte-code-function-p data)))
                    (apply #'vector (mapcar (lambda (element) (clean element (1+ depth))) data)))
                   (t (error "The request holds something that is not data")))))
        (clean value 0)))))

(defvar app-server-explain-errors t
  "Non-nil: the text of any error in a handler is the response.
That is for writing the application.  A server for others sets it to nil:
then only what server.el says on purpose (`error', `app-server-refuse')
reaches the visitor, and what went wrong inside (a file's path, a
database's message) goes to the log.")

(defun app-server--file-missing-text (err)
  "What the visitor is told about ERR, a `file-missing' condition.
server.el signals it on purpose for what is not there; Emacs signals it
for a file it did not find, with the file's whole name."
  (if (or app-server-explain-errors (not (member "No such file or directory" (cdr err))))
      (error-message-string err)
    (message "app-server: %s" (error-message-string err))
    "Not found"))

(defun app-server--error-text (err)
  "What the visitor is told about ERR, a condition a handler signalled."
  (cond ((or app-server-explain-errors (memq (car err) '(error user-error)))
         (error-message-string err))
        (t (message "app-server: %s" (error-message-string err))
           (if (eq (car err) 'file-missing) "Not found" "The request could not be answered"))))

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
        (file-missing (funcall answer 404 (app-server--file-missing-text err)))
        (error (funcall answer 400 (app-server--error-text err)))))))

(defun app-server-upload-file ()
  "For the host: a new temporary file to take an upload into."
  (let ((directory (expand-file-name "uploads/" app-server-data-directory)))
    (make-directory directory t)
    (expand-file-name (app-server-token 16) directory)))

(defun app-server-token (&optional bytes)
  "A random string nobody can guess: BYTES (default 32) random bytes in hex.
For the names of sessions and the like; `random' is not for that.  The
bytes are the system's (/dev/urandom); in the studio's browser tab that
is the browser's own generator."
  (let* ((bytes (or bytes 32))
         (data (with-temp-buffer
                 (set-buffer-multibyte nil)
                 (condition-case nil
                     ;; No start position: Emacs 30 refuses one for a device.
                     (insert-file-contents-literally "/dev/urandom" nil nil bytes)
                   ;; Emacs 29 does not read part of a device at all.
                   (error (erase-buffer)
                          (ignore-errors
                            (let ((coding-system-for-read 'binary))
                              (call-process "head" "/dev/urandom" t nil "-c" (number-to-string bytes))))))
                 (buffer-string))))
    (unless (= (length data) bytes) (error "This system gives no random bytes"))
    (mapconcat (lambda (byte) (format "%02x" byte)) data "")))

;;;; Passwords

;; A password is never kept: what is kept is a hash made to be slow, so
;; that whoever gets hold of the database cannot try a billion guesses a
;; second.
;;
;;   ('("POST" "/api/login")
;;    (let* ((sent (app-server-data body)) (name (car sent)) (password (cadr sent)))
;;      (app-server-defer
;;       (lambda (respond fail)
;;         (app-server-password-check-later
;;          password (app-stored-hash name)
;;          (lambda (right)
;;            (if (not right)
;;                (funcall fail "Wrong name or password" 401)
;;              (app-server-set-cookie "session" (app-new-session name))
;;              (funcall respond t))))))))
;;
;; server.el asks with `app-server-password-hash-later' and
;; `app-server-password-check-later'; where the arithmetic is done depends
;; on where the server runs, and server.el does not see the difference:
;;
;;   a native Emacs    another process: python3 (its hashlib is OpenSSL's C),
;;                     or, where there is no python3, a second Emacs running
;;                     the Lisp below
;;   the studio's tab  the page, with the browser's own Web Crypto
;;
;; The hash is PBKDF2 with HMAC-SHA-256 (RFC 8018), 600,000 rounds (OWASP's
;; number for it), which all three can compute, with the same result.
;; `app-server-password-algorithm' can be `scrypt' instead, which costs an
;; attacker memory as well as time; only python3 computes that, so it is
;; for a server that has one.  A hash says how it was made
;; ("pbkdf2-sha256$600000$SALT$HASH", "scrypt$ln=17,r=8,p=1$SALT$HASH"), so
;; hashes made before a change of these settings stay valid.

(defvar app-server-password-algorithm 'pbkdf2-sha256
  "How new password hashes are made: `pbkdf2-sha256' or `scrypt'.
`scrypt' needs a python3 whose hashlib has it, on the server; the
studio's browser tab cannot compute it.")

(defvar app-server-password-rounds 600000
  "How many rounds a new PBKDF2 hash gets.")

(defvar app-server-password-scrypt "ln=17,r=8,p=1"
  "The cost of a new scrypt hash: N = 2^ln (here 128 MB of memory), r, p.")

(defvar app-server-password-python "python3"
  "The Python that hashes passwords for a native server, or nil for none.
Without one, a second Emacs does it, some twenty times slower.")

(defvar app-server-password-jobs (max 1 (if (fboundp 'num-processors) (num-processors) 2))
  "How many passwords are hashed at the same time; more wait their turn.")

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

(defun app-server--password-parse (hash)
  "The parts of HASH, (ALGORITHM PARAMETERS SALT DIGEST), or nil if it is none.
A hash whose cost is beyond reason is none either: checking it would
keep the machine busy for whoever wrote it."
  (let* ((parts (and (stringp hash) (split-string hash "\\$")))
         (cost (nth 1 parts)))
    (and (= (length parts) 4)
         (string-match-p "\\`[0-9a-f]+\\'" (nth 2 parts))
         (string-match-p "\\`[0-9a-f]+\\'" (nth 3 parts))
         (pcase (nth 0 parts)
           ("pbkdf2-sha256" (and (string-match-p "\\`[0-9]\\{1,8\\}\\'" cost)
                                 (<= 1 (string-to-number cost) 10000000)))
           ("scrypt" (and (string-match "\\`ln=\\([0-9]\\{1,2\\}\\),r=\\([0-9]\\{1,2\\}\\),p=\\([0-9]\\{1,2\\}\\)\\'" cost)
                          (<= 1 (string-to-number (match-string 1 cost)) 20)
                          (<= 1 (string-to-number (match-string 2 cost)) 32)
                          (<= 1 (string-to-number (match-string 3 cost)) 16))))
         parts)))

(defvar app-server-password-min-length 8
  "The shortest password that is hashed.  A shorter one is refused: no
hash makes a short password hard to guess.")

(defun app-server--password-acceptable (password)
  "Refuse the request if PASSWORD is not one to make a hash of."
  (unless (and (stringp password) (>= (length password) app-server-password-min-length))
    (app-server-refuse (format "A password needs at least %d characters" app-server-password-min-length)))
  (when (> (length password) 1024)
    (app-server-refuse "A password has at most 1024 characters")))

(defun app-server-password-needs-rehash-p (hash)
  "Non-nil if HASH was made with other settings than hashes are made with now.
After `app-server-password-rounds' was raised or
`app-server-password-algorithm' changed, old hashes still check; when a
visitor has just signed in with one, the password is at hand to make a
new one with (`app-server-password-hash-later') and store that."
  (let ((parts (app-server--password-parse hash)))
    (not (and parts
              (equal (nth 0 parts) (symbol-name app-server-password-algorithm))
              (equal (nth 1 parts) (app-server--password-parameters))))))

(defun app-server--same-p (one other)
  "Non-nil if the strings ONE and OTHER are equal.
All of them is compared: how long this takes says nothing about where
the first difference is."
  (and (stringp one) (stringp other) (= (length one) (length other))
       (let ((difference 0))
         (dotimes (index (length one))
           (setq difference (logior difference (logxor (aref one index) (aref other index)))))
         (= difference 0))))

(defun app-server--password-parameters ()
  "The cost of a new hash, as its second part says it."
  (pcase app-server-password-algorithm
    ('pbkdf2-sha256 (number-to-string app-server-password-rounds))
    ('scrypt app-server-password-scrypt)
    (_ (error "Not a way to hash passwords: %S" app-server-password-algorithm))))

;; Here, in this Emacs: for a script.  A handler would hold up everyone.

(defun app-server-password-hash (password)
  "A hash of PASSWORD, to keep instead of it.
It reads \"pbkdf2-sha256$ROUNDS$SALT$HASH\".  Takes seconds, during which
this Emacs does nothing else; in a handler use
`app-server-password-hash-later'."
  (app-server--password-acceptable password)
  (let ((salt (app-server-token 16)))
    (format "pbkdf2-sha256$%d$%s$%s" app-server-password-rounds salt
            (app-server--pbkdf2 (encode-coding-string password 'utf-8) salt app-server-password-rounds))))

(defun app-server-password-check (password hash)
  "Non-nil if PASSWORD is the one HASH was made of.
Takes as long as making the hash did; in a handler use
`app-server-password-check-later'.  Only for PBKDF2 hashes: this Emacs
cannot compute scrypt."
  (let ((parts (app-server--password-parse hash)))
    (and parts
         (if (equal (car parts) "pbkdf2-sha256")
             (app-server--same-p
              (app-server--pbkdf2 (encode-coding-string password 'utf-8) (nth 2 parts)
                                  (string-to-number (nth 1 parts)))
              (nth 3 parts))
           (error "A %s hash is checked with `app-server-password-check-later'" (car parts))))))

;; Elsewhere, while this Emacs goes on: for a handler.

(defvar app-server-kdf-function #'app-server--kdf-process
  "Function of (ALGORITHM PARAMETERS PASSWORD SALT THEN) that hashes.
It returns at once; THEN is called with the 32 bytes in hex, or with nil
when this host cannot compute ALGORITHM.  The hosts differ in this:
another process under a native Emacs, the page in the studio's tab.")

(defun app-server-password-hash-later (password function)
  "Hash PASSWORD without holding up the server; FUNCTION gets the hash.
For use inside `app-server-defer'.  A password shorter than
`app-server-password-min-length' is refused."
  (app-server--password-acceptable password)
  (let ((algorithm (symbol-name app-server-password-algorithm))
        (parameters (app-server--password-parameters))
        (salt (app-server-token 16)))
    (funcall app-server-kdf-function algorithm parameters password salt
             (app-server--guard
              (lambda (digest)
                (unless digest (error "This server cannot make %s hashes" algorithm))
                (funcall function (format "%s$%s$%s$%s" algorithm parameters salt digest)))))
    nil))

(defun app-server-password-check-later (password hash function)
  "Check PASSWORD against HASH without holding up the server.
FUNCTION gets t or nil.  For use inside `app-server-defer'."
  (let ((parts (app-server--password-parse hash))
        (function (app-server--guard function)))
    (if (not (and parts (stringp password) (<= (length password) 1024)))
        ;; No such account, most likely.  The answer takes as long as a
        ;; real check, or its speed would tell which names exist.
        (funcall app-server-kdf-function "pbkdf2-sha256" (number-to-string app-server-password-rounds)
                 "no password" "00" (lambda (_digest) (funcall function nil)))
      (funcall app-server-kdf-function (nth 0 parts) (nth 1 parts) password (nth 2 parts)
               (app-server--guard
                (lambda (digest)
                  (unless digest (error "This server cannot check %s hashes" (nth 0 parts)))
                  (funcall function (app-server--same-p digest (nth 3 parts)))))))
    nil))

;; Under a native Emacs: another process.

(defvar app-server-run-function)

(defconst app-server--kdf-script "\
import sys, hashlib, base64
algorithm, cost, salt, password = sys.stdin.read().split('\\n')[:4]
password = base64.b64decode(password)
salt = salt.encode()
if algorithm == 'pbkdf2-sha256':
    digest = hashlib.pbkdf2_hmac('sha256', password, salt, int(cost))
elif algorithm == 'scrypt':
    cost = dict(part.split('=') for part in cost.split(','))
    n, r, p = 1 << int(cost['ln']), int(cost['r']), int(cost['p'])
    digest = hashlib.scrypt(password, salt=salt, n=n, r=r, p=p, maxmem=132 * n * r * p + 1048576, dklen=32)
else:
    sys.exit(3)
sys.stdout.write(digest.hex())
"
  "What python3 runs to hash: the request on standard input, hex out.
The password comes by the pipe, not on the command line, where other
users of the machine could read it.")

(defvar app-server--kdf-python 'unknown
  "(PROGRAM ALGORITHM...) for the Python that hashes, or nil for none.")

(defun app-server--kdf-python ()
  "Find out, once, whether there is a Python and what its hashlib can do."
  (when (eq app-server--kdf-python 'unknown)
    (setq app-server--kdf-python
          (let ((program (and app-server-password-python (executable-find app-server-password-python))))
            (and program
                 (with-temp-buffer
                   (and (eq 0 (ignore-errors
                                (call-process program nil t nil "-c" "\
import hashlib
hashlib.pbkdf2_hmac('sha256', b'x', b'y', 1)
print('pbkdf2-sha256')
try:
    hashlib.scrypt(b'x', salt=b'y', n=2, r=1, p=1, dklen=8)
    print('scrypt')
except Exception:
    pass
")))
                        (cons program (split-string (buffer-string)))))))))
  app-server--kdf-python)

(defun app-server-password-hasher ()
  "A line for the log: what hashes passwords on this server."
  (let ((python (app-server--kdf-python)))
    (if python
        (format "%s (%s)" (car python) (string-join (cdr python) ", "))
      "a second Emacs (pbkdf2-sha256)")))

(defvar app-server--kdf-running 0)
(defvar app-server--kdf-waiting nil "Hashing that waits its turn: (JOB . THEN), oldest first.")

(defun app-server--kdf-next ()
  "Start waiting jobs, as many as may run at the same time."
  (while (and app-server--kdf-waiting (< app-server--kdf-running app-server-password-jobs))
    (let* ((next (pop app-server--kdf-waiting))
           (then (cdr next))
           (finished nil)
           (finish (lambda (digest)
                     (unless finished
                       (setq finished t)
                       (cl-decf app-server--kdf-running)
                       (unwind-protect
                           (funcall then (and (stringp digest) (string-match-p "\\`[0-9a-f]\\{64\\}\\'" digest)
                                              digest))
                         (app-server--kdf-next))))))
      (cl-incf app-server--kdf-running)
      (condition-case err
          (funcall (car next) finish)
        (error (message "app-server: hashing: %s" (error-message-string err))
               (funcall finish nil))))))

(defun app-server--kdf-process (algorithm parameters password salt then)
  "`app-server-kdf-function' for a native Emacs: python3, or a second Emacs."
  (let* ((python (app-server--kdf-python))
         (secret (base64-encode-string (encode-coding-string password 'utf-8) t))
         (command (cond ((member algorithm (cdr python))
                         (list (car python) "-c" app-server--kdf-script))
                        ((equal algorithm "pbkdf2-sha256")
                         (list (expand-file-name invocation-name invocation-directory) "--batch" "-Q"
                               "-l" app-server--file "--eval" "(app-server--password-child)")))))
    (if (not command)
        (funcall then nil)
      (setq app-server--kdf-waiting
            (append app-server--kdf-waiting
                    (list (cons (lambda (finish)
                                  (funcall app-server-run-function command
                                           (concat algorithm "\n" parameters "\n" salt "\n" secret "\n")
                                           (lambda (result)
                                             (funcall finish (and (eq (plist-get result :status) 0)
                                                                  (plist-get result :output))))))
                                then))))
      (app-server--kdf-next))))

(defun app-server--password-child ()
  "In the second Emacs: hash what standard input asks for, print the hex."
  (let ((lines (split-string (with-temp-buffer (insert-file-contents "/dev/stdin") (buffer-string)) "\n")))
    (unless (equal (nth 0 lines) "pbkdf2-sha256") (kill-emacs 3))
    (princ (app-server--pbkdf2 (base64-decode-string (nth 3 lines)) (nth 2 lines)
                               (string-to-number (nth 1 lines))))))

;;;; Signing in: sessions, and a limit on guesses

;; What signing in needs besides the password check: something that says
;; "this visitor is Ada" on later requests, and a stop to guessing.
;;
;;   ('("POST" "/api/login")
;;    (let* ((sent (app-server-data body)) (name (car sent)) (password (cadr sent))
;;           (address (app-server-visitor-address)))
;;      (app-server-attempts-check name address)        ; 429 after five failures in ten minutes
;;      (app-server-defer
;;       (lambda (respond fail)
;;         (app-server-password-check-later
;;          password (app-stored-hash name)
;;          (lambda (right)
;;            (if (not right)
;;                (progn (app-server-attempts-failed name address)
;;                       (funcall fail "Wrong name or password" 401))
;;              (app-server-attempts-clear name)
;;              (app-server-session-start name)         ; a cookie, for thirty days
;;              (funcall respond t))))))))
;;   ('("GET" "/api/me") (or (app-server-session) (app-server-refuse "Sign in first" 401)))
;;   ('("POST" "/api/logout") (app-server-session-end) t)
;;
;; Both are kept in an SQLite database of their own (.data/server.db), so
;; several workers share them and a restart does not sign everyone out.
;; In an Emacs without SQLite they are kept in memory.

(defvar app-server-session-days 30 "How long a session lasts.")
(defvar app-server-session-cookie "session" "The name of the session's cookie.")
(defvar app-server-attempts-max 5
  "How many failures are let through for one name or address.")
(defvar app-server-attempts-seconds 600
  "The time in which `app-server-attempts-max' failures stop further tries.")

(defvar app-server--memory (make-hash-table :test 'equal)
  "Sessions and attempts, in an Emacs without SQLite.")
(defvar app-server--own-tables nil "Non-nil once the tables of server.db exist.")

(defun app-server--own-database ()
  "The database of sessions and attempts, or nil in an Emacs without SQLite."
  (when (and (fboundp 'sqlite-available-p) (sqlite-available-p))
    (let ((database (app-server-database "server")))
      (unless app-server--own-tables
        (sqlite-execute database "CREATE TABLE IF NOT EXISTS sessions (
                                    token TEXT PRIMARY KEY, visitor TEXT NOT NULL, expires REAL NOT NULL)")
        (sqlite-execute database "CREATE TABLE IF NOT EXISTS attempts (name TEXT NOT NULL, at REAL NOT NULL)")
        (sqlite-execute database "CREATE INDEX IF NOT EXISTS attempts_name ON attempts (name)")
        (setq app-server--own-tables t))
      database)))

(defun app-server--print (data)
  (let ((print-length nil) (print-level nil)) (prin1-to-string data)))

(defun app-server-session-start (visitor &optional days)
  "Start a session for VISITOR: from now on `app-server-session' is VISITOR.
VISITOR is Lisp data that says who it is: a name, a number, a plist.
The browser gets a cookie with a random name for the session, good for
DAYS (default `app-server-session-days'); the server keeps a hash of
that name, so its database does not hold what would let someone in.
Returns VISITOR."
  (let* ((token (app-server-token))
         (key (secure-hash 'sha256 token))
         (seconds (* 86400 (or days app-server-session-days)))
         (expires (+ (float-time) seconds))
         (database (app-server--own-database)))
    (if database
        (progn
          ;; Also the moment to forget what has run out.
          (sqlite-execute database "DELETE FROM sessions WHERE expires < ?" (list (float-time)))
          (sqlite-execute database "INSERT INTO sessions (token, visitor, expires) VALUES (?, ?, ?)"
                          (list key (app-server--print visitor) expires)))
      (puthash (concat "session " key) (cons (app-server--print visitor) expires) app-server--memory))
    (app-server-set-cookie app-server-session-cookie token :max-age (round seconds))
    visitor))

(defun app-server--session-key ()
  (let ((token (app-server-cookie app-server-session-cookie)))
    (and token (string-match-p "\\`[0-9a-f]\\{64\\}\\'" token) (secure-hash 'sha256 token))))

(defun app-server-session ()
  "Who the visitor of the request being answered is, or nil if not signed in.
The value is what `app-server-session-start' was given."
  (let* ((key (app-server--session-key))
         (database (and key (app-server--own-database)))
         (found (cond ((not key) nil)
                      (database (car (sqlite-select database "SELECT visitor, expires FROM sessions WHERE token = ?"
                                                    (list key))))
                      (t (let ((kept (gethash (concat "session " key) app-server--memory)))
                           (and kept (list (car kept) (cdr kept))))))))
    (and found (> (nth 1 found) (float-time))
         (car (read-from-string (nth 0 found))))))

(defun app-server-session-end ()
  "End the session of the request being answered (sign out)."
  (let* ((key (app-server--session-key))
         (database (and key (app-server--own-database))))
    (cond ((not key))
          (database (sqlite-execute database "DELETE FROM sessions WHERE token = ?" (list key)))
          (t (remhash (concat "session " key) app-server--memory))))
  (app-server-delete-cookie app-server-session-cookie)
  nil)

(defun app-server-session-end-all (visitor)
  "End every session of VISITOR, on every device.
For when a password was changed: whoever knew the old one is out."
  (let ((database (app-server--own-database))
        (printed (app-server--print visitor)))
    (if database
        (sqlite-execute database "DELETE FROM sessions WHERE visitor = ?" (list printed))
      (maphash (lambda (key kept)
                 (when (and (string-prefix-p "session " key) (equal (car kept) printed))
                   (remhash key app-server--memory)))
               app-server--memory)))
  nil)

(defun app-server-visitor-address ()
  "The address the visitor comes from, as the reverse proxy says, or nil.
Without a proxy there is none to tell apart: everyone is this machine."
  (let ((forwarded (app-server-header "x-forwarded-for")))
    ;; The last entry is the one the proxy next to this server wrote.
    (and forwarded (car (last (split-string forwarded "," t "[ \t]+"))))))

(defun app-server--attempt-names (names)
  "NAMES (strings, or nil for none) as they are kept: hashed."
  (mapcar (lambda (name) (secure-hash 'sha256 (encode-coding-string (downcase name) 'utf-8)))
          (delq nil (copy-sequence names))))

(defun app-server--attempts (name since)
  "The times of the failures for NAME (hashed) after SINCE, oldest first."
  (let ((database (app-server--own-database)))
    (if database
        (mapcar #'car (sqlite-select database "SELECT at FROM attempts WHERE name = ? AND at > ? ORDER BY at"
                                     (list name since)))
      (seq-filter (lambda (at) (> at since)) (gethash (concat "attempts " name) app-server--memory)))))

(defun app-server-attempts-check (&rest names)
  "Refuse the request (429) if there were too many failures for one of NAMES.
NAMES are strings that say whose attempt this is: the account's name,
the visitor's address (`app-server-visitor-address'); nil is none.  Too
many is `app-server-attempts-max' within `app-server-attempts-seconds'."
  (let ((since (- (float-time) app-server-attempts-seconds)))
    (dolist (name (app-server--attempt-names names))
      (let ((failures (app-server--attempts name since)))
        (when (>= (length failures) app-server-attempts-max)
          (let ((wait (max 1 (ceiling (- (+ (car failures) app-server-attempts-seconds) (float-time))))))
            (app-server-set-header "Retry-After" (number-to-string wait))
            (app-server-refuse (format "Too many attempts. Try again in %d minutes" (ceiling wait 60.0))
                               429)))))))

(defun app-server-attempts-failed (&rest names)
  "Note a failed attempt for each of NAMES (see `app-server-attempts-check')."
  (let ((database (app-server--own-database))
        (now (float-time)))
    (when database
      (sqlite-execute database "DELETE FROM attempts WHERE at < ?" (list (- now app-server-attempts-seconds))))
    (dolist (name (app-server--attempt-names names))
      (if database
          (sqlite-execute database "INSERT INTO attempts (name, at) VALUES (?, ?)" (list name now))
        (puthash (concat "attempts " name)
                 (append (app-server--attempts name (- now app-server-attempts-seconds)) (list now))
                 app-server--memory))))
  nil)

(defun app-server-attempts-clear (&rest names)
  "Forget the failures for NAMES: for the account that has just signed in."
  (let ((database (app-server--own-database)))
    (dolist (name (app-server--attempt-names names))
      (if database
          (sqlite-execute database "DELETE FROM attempts WHERE name = ?" (list name))
        (remhash (concat "attempts " name) app-server--memory))))
  nil)

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
        (file-missing
         (if fail
             (funcall fail (app-server--file-missing-text err) 404)
           (message "app-server: %s" (error-message-string err))))
        (error
         (if fail
             (funcall fail (app-server--error-text err))
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
      (file-missing (funcall answer 404 (app-server--file-missing-text err)))
      (error (funcall answer 400 (app-server--error-text err))))))

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
          (file-missing (funcall fail (app-server--file-missing-text err) 404))
          (error (funcall fail (app-server--error-text err))))
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
        ;; Passwords: the browser's Web Crypto does PBKDF2.  Should the page
        ;; have none, this Emacs does it itself, slowly.
        app-server-kdf-function
        (lambda (algorithm parameters password salt then)
          (app-server--tab-command
           "kdf" (list :algorithm algorithm :parameters parameters :password password :salt salt)
           (lambda (ok value)
             (funcall then (cond ((and ok (stringp value)) value)
                                 ((equal algorithm "pbkdf2-sha256")
                                  (app-server--pbkdf2 (encode-coding-string password 'utf-8) salt
                                                      (string-to-number parameters))))))))
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
