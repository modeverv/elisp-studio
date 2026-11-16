;;; server.el --- accounts, each one's todos and their files, kept in SQL  -*- lexical-binding: t; -*-

;; Accounts are a name and a password; each account has its own todos.
;; The same file runs in the studio (SQLite, in the browser tab), under
;; run.sh (SQLite in .data/), and on a shared host whose data is in MySQL
;; (tools/serve-cgi.el with APP_MYSQL): `app-server-sql-select' and the rest
;; go to either.  Only the tables are written twice.
;;
;; A request may be a process of its own (a CGI), ended at any moment:
;; nothing is kept in Lisp variables, and the tables are made the first
;; time they are missing.  Everything a page sends goes into SQL as a
;; parameter, never as SQL text; every todo query names the account, so
;; nobody reaches another's todos.
;;
;; A todo may have files (10 MB each): kept in the data directory, outside
;; the web root (`app-server-keep-upload'), and sent only to their account.
;; A job (`app-server-defjob') deletes the todos that were done more than
;; 30 days ago, with their files: under run.sh every day by itself, on a
;; shared host from cron (job.sh).

(defconst todos-tables
  '((mysql
     "CREATE TABLE IF NOT EXISTS todo_users (
        id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32) NOT NULL UNIQUE,
        hash VARCHAR(255) NOT NULL, created DOUBLE NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
     "CREATE TABLE IF NOT EXISTS todo_items (
        id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(200) NOT NULL,
        done TINYINT NOT NULL DEFAULT 0, created DOUBLE NOT NULL, KEY todo_items_user (user_id),
        FOREIGN KEY (user_id) REFERENCES todo_users (id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
     "CREATE TABLE IF NOT EXISTS todo_files (
        id INT AUTO_INCREMENT PRIMARY KEY, item_id INT NOT NULL, user_id INT NOT NULL,
        name VARCHAR(255) NOT NULL, size BIGINT NOT NULL, file_key VARCHAR(64) NOT NULL,
        created DOUBLE NOT NULL, KEY todo_files_item (item_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
     "CREATE TABLE IF NOT EXISTS todo_done (
        item_id INT NOT NULL PRIMARY KEY, at DOUBLE NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
    (sqlite
     "CREATE TABLE IF NOT EXISTS todo_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL, created REAL NOT NULL)"
     "CREATE TABLE IF NOT EXISTS todo_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL)"
     "CREATE INDEX IF NOT EXISTS todo_items_user ON todo_items (user_id)"
     "CREATE TABLE IF NOT EXISTS todo_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        name TEXT NOT NULL, size INTEGER NOT NULL, file_key TEXT NOT NULL, created REAL NOT NULL)"
     "CREATE INDEX IF NOT EXISTS todo_files_item ON todo_files (item_id)"
     "CREATE TABLE IF NOT EXISTS todo_done (item_id INTEGER PRIMARY KEY, at REAL NOT NULL)"))
  "The tables, for each kind of database.")

(defun todos-error-text (err)
  (format "%s" (cdr err)))

(defun todos-sql (function &rest arguments)
  "FUNCTION (`app-server-sql-select' and the rest) on ARGUMENTS.
The tables are made when the database says they are missing."
  (condition-case err
      (apply function arguments)
    (error
     (if (string-match-p "1146\\|no such table" (todos-error-text err))
         (progn (dolist (sql (cdr (assq (app-server-sql-backend) todos-tables)))
                  (app-server-sql-execute sql))
                (apply function arguments))
       (signal (car err) (cdr err))))))

(defun todos-duplicate-p (err)
  "Non-nil if ERR says a name is taken (MySQL 1062, SQLite UNIQUE)."
  (string-match-p "1062\\|UNIQUE constraint" (todos-error-text err)))

(defun todos-me ()
  "The account of this request, (:id ID :name NAME), or a 401."
  (or (app-server-session) (app-server-refuse "Sign in first" 401)))

(defun todos-list (me)
  "The todos of the account ME, oldest first, each with its files."
  (let ((files (todos-sql #'app-server-sql-select
                          "SELECT id, item_id, name, size FROM todo_files WHERE user_id = ? ORDER BY id"
                          (list (plist-get me :id)))))
    (mapcar (lambda (row)
              (list :id (nth 0 row) :title (nth 1 row) :done (equal (nth 2 row) 1)
                    :files (delq nil (mapcar (lambda (file)
                                               (and (equal (nth 1 file) (nth 0 row))
                                                    (list :id (nth 0 file) :name (nth 2 file) :size (nth 3 file))))
                                             files))))
            (todos-sql #'app-server-sql-select
                       "SELECT id, title, done FROM todo_items WHERE user_id = ? ORDER BY id"
                       (list (plist-get me :id))))))

(defun todos-delete-items (ids)
  "Delete the todos IDS, with their files: the rows and what is on disk."
  (dolist (id ids)
    (dolist (file (todos-sql #'app-server-sql-select "SELECT file_key FROM todo_files WHERE item_id = ?" (list id)))
      (ignore-errors (delete-file (app-server-file (car file)))))
    (app-server-sql-transaction
      (todos-sql #'app-server-sql-execute "DELETE FROM todo_files WHERE item_id = ?" (list id))
      (todos-sql #'app-server-sql-execute "DELETE FROM todo_done WHERE item_id = ?" (list id))
      (todos-sql #'app-server-sql-execute "DELETE FROM todo_items WHERE id = ?" (list id)))))

(defun todos-own-items (me where &optional params)
  "The ids of the todos of ME that match WHERE (SQL, with PARAMS)."
  (mapcar #'car (todos-sql #'app-server-sql-select
                           (concat "SELECT id FROM todo_items WHERE user_id = ? AND " where)
                           (cons (plist-get me :id) params))))

;;;; Files of todos

(defconst todos-largest (* 10 1024 1024) "The largest file a todo takes.")

(defun app-server-upload-p (method path size)
  "A file comes with POST /api/todos/attach: from someone signed in, 10 MB at most."
  (and (equal (list method path) '("POST" "/api/todos/attach"))
       (todos-me)
       (or (<= size todos-largest) (app-server-refuse "A file is 10 MB at most" 413))))

(defun todos-attach (me)
  "Keep the file of this request with the todo ?id=, under the name ?name=."
  (let* ((id (string-to-number (app-server-parameter "id" "0")))
         (name (string-trim (app-server-parameter "name" ""))))
    (unless (todos-own-items me "id = ?" (list id)) (app-server-refuse "Not a todo" 404))
    (when (or (string-empty-p name) (> (length name) 200)) (app-server-refuse "A file needs a name" 400))
    (let* ((key (format "todo-%d-%s" id (app-server-token 8)))
           (size (app-server-keep-upload key)))
      (todos-sql #'app-server-sql-insert
                 "INSERT INTO todo_files (item_id, user_id, name, size, file_key, created) VALUES (?, ?, ?, ?, ?, ?)"
                 (list id (plist-get me :id) name size key (float-time))))))

(defun todos-file (me id)
  "The file ID of ME's todos: (FILE-KEY NAME), or a 404."
  (or (car (todos-sql #'app-server-sql-select
                      "SELECT file_key, name FROM todo_files WHERE id = ? AND user_id = ?"
                      (list id (plist-get me :id))))
      (app-server-refuse "No such file" 404)))

;;;; The job

(defconst todos-keep-done-days 30 "Days a done todo stays.")

(defun todos-purge ()
  "Delete the todos that were done more than `todos-keep-done-days' days ago."
  (todos-delete-items
   (mapcar #'car (todos-sql #'app-server-sql-select
                            "SELECT todo_items.id FROM todo_items JOIN todo_done ON todo_done.item_id = todo_items.id
                             WHERE todo_items.done = 1 AND todo_done.at < ?"
                            (list (- (float-time) (* 86400 todos-keep-done-days)))))))

(app-server-defjob 'todos-purge :every 86400 :function #'todos-purge)

(defun todos-credentials (body)
  "The (NAME PASSWORD) that the page sent, checked."
  (let* ((sent (app-server-data body))
         (name (and (consp sent) (car sent)))
         (password (and (consp sent) (cadr sent))))
    (unless (and (stringp name) (string-match-p "\\`[A-Za-z0-9_.-]\\{3,32\\}\\'" name))
      (app-server-refuse "A name is 3 to 32 letters, digits, _ . or -" 400))
    (unless (and (stringp password) (<= (length password) 200))
      (app-server-refuse "No password" 400))
    (list name password)))

(defun todos-title (body)
  (let ((title (app-server-data body)))
    (unless (stringp title) (app-server-refuse "A todo is text" 400))
    (setq title (string-trim title))
    (when (or (string-empty-p title) (> (length title) 200))
      (app-server-refuse "A todo is 1 to 200 characters" 400))
    title))

(defun todos-id (body)
  (let ((id (app-server-data body)))
    (unless (natnump id) (app-server-refuse "Not a todo" 400))
    id))

(defun todos-sign-up (body)
  (pcase-let ((`(,name ,password) (todos-credentials body)))
    (when (todos-sql #'app-server-sql-select "SELECT id FROM todo_users WHERE name = ?" (list name))
      (app-server-refuse "That name is taken" 409))
    (app-server-defer
     (lambda (respond fail)
       (app-server-password-hash-later
        password
        (lambda (hash)
          (condition-case err
              (let ((id (todos-sql #'app-server-sql-insert
                                   "INSERT INTO todo_users (name, hash, created) VALUES (?, ?, ?)"
                                   (list name hash (float-time)))))
                (app-server-session-start (list :id id :name name))
                (funcall respond (list :name name)))
            (error (if (todos-duplicate-p err)
                       (funcall fail "That name is taken" 409)
                     (signal (car err) (cdr err)))))))))))

(defun todos-sign-in (body)
  (pcase-let* ((`(,name ,password) (todos-credentials body))
               (address (app-server-visitor-address))
               (found (car (todos-sql #'app-server-sql-select
                                      "SELECT id, hash FROM todo_users WHERE name = ?" (list name)))))
    (app-server-attempts-check name address)
    (app-server-defer
     (lambda (respond fail)
       (app-server-password-check-later
        password (nth 1 found)
        (lambda (right)
          (if (not right)
              (progn (app-server-attempts-failed name address)
                     (funcall fail "Wrong name or password" 401))
            (app-server-attempts-clear name)
            (app-server-session-start (list :id (nth 0 found) :name name))
            (funcall respond (list :name name)))))))))

(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/me")
     (let ((me (app-server-session))) (and me (list :name (plist-get me :name)))))
    ('("POST" "/api/signup") (todos-sign-up body))
    ('("POST" "/api/signin") (todos-sign-in body))
    ('("POST" "/api/signout") (app-server-session-end) nil)
    ('("GET" "/api/todos") (todos-list (todos-me)))
    ('("POST" "/api/todos")
     (let ((me (todos-me)))
       (todos-sql #'app-server-sql-insert
                  "INSERT INTO todo_items (user_id, title, done, created) VALUES (?, ?, 0, ?)"
                  (list (plist-get me :id) (todos-title body) (float-time)))
       (todos-list me)))
    ('("POST" "/api/todos/toggle")
     (let* ((me (todos-me)) (id (todos-id body)))
       (when (todos-own-items me "id = ?" (list id))
         (app-server-sql-transaction
           (todos-sql #'app-server-sql-execute "UPDATE todo_items SET done = 1 - done WHERE id = ?" (list id))
           ;; When it was done: the job deletes it 30 days later.
           (if (todos-own-items me "id = ? AND done = 1" (list id))
               (todos-sql #'app-server-sql-execute "REPLACE INTO todo_done (item_id, at) VALUES (?, ?)"
                          (list id (float-time)))
             (todos-sql #'app-server-sql-execute "DELETE FROM todo_done WHERE item_id = ?" (list id)))))
       (todos-list me)))
    ('("POST" "/api/todos/remove")
     (let ((me (todos-me)))
       (todos-delete-items (todos-own-items me "id = ?" (list (todos-id body))))
       (todos-list me)))
    ('("POST" "/api/todos/clear")
     (let ((me (todos-me)))
       (todos-delete-items (todos-own-items me "done = 1"))
       (todos-list me)))
    ('("POST" "/api/todos/attach")
     (let ((me (todos-me))) (todos-attach me) (todos-list me)))
    ('("GET" "/api/todos/file")
     (let* ((me (todos-me))
            (file (todos-file me (string-to-number (app-server-parameter "id" "0")))))
       (app-server-send-file (app-server-file (nth 0 file)) :name (nth 1 file))))
    ('("POST" "/api/todos/detach")
     (let* ((me (todos-me)) (id (todos-id body)) (file (todos-file me id)))
       (ignore-errors (delete-file (app-server-file (nth 0 file))))
       (todos-sql #'app-server-sql-execute "DELETE FROM todo_files WHERE id = ?" (list id))
       (todos-list me)))
    (_ (signal 'file-missing (list "No such API" path)))))
