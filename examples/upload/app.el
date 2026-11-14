;;; app.el --- a shelf of files  -*- lexical-binding: t; -*-

;; The page.  The visitor chooses a file; `react-fetch' sends it as it is
;; (:file), server.el keeps it, and the list comes back.  The file itself
;; never passes through this Lisp: it goes from the file input to the
;; server.

(require 'url-util)

(defun shelf-size (bytes)
  (cond ((< bytes 1024) (format "%d B" bytes))
        ((< bytes (* 1024 1024)) (format "%.1f KB" (/ bytes 1024.0)))
        (t (format "%.1f MB" (/ bytes 1048576.0)))))

(defun shelf-ask (self path &rest options)
  "Send a request to server.el and show the shelf that comes back."
  (apply #'react-fetch path
         :then (lambda (response)
                 (let ((value (car (read-from-string (plist-get response :text)))))
                   (if (plist-get response :ok)
                       (react-set-state self :busy nil :error nil :files (plist-get value :files))
                     (react-set-state self :busy nil :error value))))
         :catch (lambda (message) (react-set-state self :busy nil :error message))
         options))

(react-define-component 'Shelf
  :initial-state (lambda (_props) (list :files nil :chosen nil :busy nil :error nil))
  :did-mount (lambda (self) (shelf-ask self "/api/files"))
  :render
  (lambda (self)
    (let ((chosen (react-state self :chosen)))
      (jsx (main
             (h1 "File shelf")
             (form (:class "new"
                    :on-submit (lambda (_event)
                                 (when (react-state self :chosen)
                                   (react-set-state self :busy t)
                                   (shelf-ask self (concat "/api/files?name="
                                                           (url-hexify-string (plist-get (react-state self :chosen) :name)))
                                              :method "POST" :file (react-ref self "file")))))
               (input (:class "file" :type "file" :ref "file"
                       ;; The event says what was chosen: name, size, type.
                       :on-change (lambda (event)
                                    (let ((files (plist-get event :files)))
                                      (react-set-state self :chosen (and (> (length files) 0) (aref files 0)))))))
               (button (:class "put" :disabled (or (not chosen) (react-state self :busy)))
                 (cond ((react-state self :busy) "sending…")
                       (chosen (format "put on the shelf (%s)" (shelf-size (plist-get chosen :size))))
                       (t "choose a file"))))
             (and (react-state self :error) (jsx (p (:class "error") (react-state self :error))))
             (ul (:class "files")
               (mapcar (lambda (file)
                         (let ((name (plist-get file :name)))
                           (jsx (li (:key name :class "file")
                                  (a (:class "name" :href (concat "/api/file?name=" (url-hexify-string name))) name)
                                  (span (:class "size") (shelf-size (plist-get file :size)))
                                  (span (:class "at") (plist-get file :at))
                                  (button (:class "remove"
                                           :on-click (lambda (_event)
                                                       (shelf-ask self "/api/files/remove"
                                                                  :method "POST" :body (prin1-to-string name))))
                                    "×")))))
                       (react-state self :files)))
             (p (:class "status") (format "%d files on the shelf." (length (react-state self :files)))))))))

(react-mount (jsx (Shelf)) "#app")
