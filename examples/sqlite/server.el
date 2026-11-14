;;; server.el --- a reading list kept in SQLite  -*- lexical-binding: t; -*-

;; The server side of the page.  The data is an SQLite database, used
;; through Emacs's own SQLite functions: no driver, no other program.
;;
;;   in the studio   the database is a file in the memory of the server's
;;                   Emacs in the browser tab; the studio keeps it in the
;;                   browser between visits
;;   for real        (run.sh, tools/serve-project.sh) it is the file
;;                   .data/app.db next to this one, which the sqlite3
;;                   command line tool can open too
;;
;; Everything a page sends goes into SQL as a parameter (the ? and the
;; list after the statement), never as part of the SQL text.

(defun app-db ()
  "The database, with its table."
  (let ((db (app-server-database)))
    (sqlite-execute db "CREATE TABLE IF NOT EXISTS books (
                          id    INTEGER PRIMARY KEY AUTOINCREMENT,
                          title TEXT NOT NULL,
                          done  INTEGER NOT NULL DEFAULT 0,
                          added TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    db))

(defun app-books (search)
  "The reading list as the page shows it: the books whose title contains SEARCH."
  (let ((db (app-db)))
    (list :books (vconcat
                  (mapcar (lambda (row)
                            (list :id (nth 0 row) :title (nth 1 row) :done (= 1 (nth 2 row)) :added (nth 3 row)))
                          (sqlite-select db "SELECT id, title, done, added FROM books
                                             WHERE title LIKE ? ORDER BY done, id DESC"
                                         (list (concat "%" search "%")))))
          :total (caar (sqlite-select db "SELECT count(*) FROM books"))
          :read (caar (sqlite-select db "SELECT count(*) FROM books WHERE done = 1"))
          :sqlite (sqlite-version))))

(defun app-server-handle (method path body)
  (let ((db (app-db)))
    (pcase (list method path)
      ('("GET" "/api/books"))
      ('("POST" "/api/books")
       (let ((title (string-trim (format "%s" (car (read-from-string body))))))
         (when (string-empty-p title) (error "A book needs a title"))
         (sqlite-execute db "INSERT INTO books (title) VALUES (?)" (list title))))
      ('("POST" "/api/books/toggle")
       (sqlite-execute db "UPDATE books SET done = 1 - done WHERE id = ?" (list (car (read-from-string body)))))
      ('("POST" "/api/books/remove")
       (sqlite-execute db "DELETE FROM books WHERE id = ?" (list (car (read-from-string body)))))
      (_ (signal 'file-missing (list "No such API" path))))
    ;; Every request is answered with the list as it is now.
    (app-books (app-server-parameter "search" ""))))
