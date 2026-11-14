;;; server.el --- a shelf of files  -*- lexical-binding: t; -*-

;; The server side of the page: visitors put files on a shelf and take them
;; down again.  A file is not text for `app-server-handle': the server
;; writes it to disk as it arrives, however large, and the handler gets its
;; name.
;;
;;   in the studio   the files are in the memory of the server's Emacs in
;;                   the browser tab (up to 32 MB each): enough to try it
;;   for real        (run.sh) they are in .data/files/ next to this file

(defconst app-largest (* 500 1024 1024) "The largest file the shelf takes.")

(defun app-server-upload-p (_method path size)
  "Say, before any of it is taken, whether a request brings a file."
  (and (equal path "/api/files")
       (or (<= size app-largest) (app-server-refuse "That file is too large for the shelf" 413))))

(defun app-name (name)
  "NAME, as a visitor gave it, turned into a name the shelf can use."
  (let ((name (replace-regexp-in-string "[^A-Za-z0-9._-]" "_" (file-name-nondirectory (or name "")))))
    (when (string-match-p "\\`\\.*\\'" name) (error "A file needs a name"))
    (replace-regexp-in-string "\\`\\.+" "" name)))

(defun app-shelf ()
  "The shelf as the page shows it."
  (list :files (vconcat
                (mapcar (lambda (name)
                          (let ((attributes (file-attributes (app-server-file name))))
                            (list :name name
                                  :size (file-attribute-size attributes)
                                  :at (format-time-string "%F %R" (file-attribute-modification-time attributes)))))
                        (app-server-files)))))

(defun app-server-handle (method path body)
  (pcase (list method path)
    ('("GET" "/api/files") (app-shelf))
    ('("POST" "/api/files")
     (app-server-keep-upload (app-name (app-server-parameter "name")))
     (app-shelf))
    ('("GET" "/api/file")
     (let ((name (app-name (app-server-parameter "name"))))
       (app-server-send-file (app-server-file name) :name name)))
    ('("POST" "/api/files/remove")
     (delete-file (app-server-file (app-name (car (read-from-string body)))))
     (app-shelf))
    (_ (signal 'file-missing (list "No such API" path)))))
