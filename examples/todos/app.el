;;; app.el --- todos, for people with an account  -*- lexical-binding: t; -*-

;; The page.  server.el keeps the accounts and the todos; this file signs
;; in, and shows and changes the todos of the account signed in.  The
;; session is a cookie that neither this Lisp nor a script can read
;; (HttpOnly): the page asks /api/me who it is.  A todo may have files:
;; `react-fetch' sends one as it is (:file), and a link brings it back.

(require 'url-util)

(defun todos-size (bytes)
  (cond ((< bytes 1024) (format "%d B" bytes))
        ((< bytes (* 1024 1024)) (format "%.0f KB" (/ bytes 1024.0)))
        (t (format "%.1f MB" (/ bytes 1048576.0)))))

(defun todos-api (method path &optional data)
  "An awaitable for a request to server.el.  Its value is Lisp data; a
refusal rejects with the server's text."
  (lambda (resolve reject)
    (react-fetch path
                 :method method
                 :body (and data (prin1-to-string data))
                 :then (lambda (response)
                         (let ((value (ignore-errors (car (read-from-string (plist-get response :text))))))
                           (if (plist-get response :ok)
                               (funcall resolve value)
                             (funcall reject (if (stringp value) value
                                               (format "The server said %s" (plist-get response :status)))))))
                 :catch reject)))

(react-define-component 'SignIn
  :initial-state (lambda (_props) (list :mode 'in :name "" :password "" :error nil :busy nil))
  :render
  (lambda (self)
    (let ((up (eq (react-state self :mode) 'up)))
      (jsx (form (:class "signin"
                  :on-submit (lambda (_event)
                               (react-set-state self :busy t :error nil)
                               (react-async
                                 (condition-case failure
                                     (funcall (react-props self :on-signed-in)
                                              (react-await (todos-api "POST" (if (eq (react-state self :mode) 'up)
                                                                                 "api/signup" "api/signin")
                                                                      (list (react-state self :name)
                                                                            (react-state self :password)))))
                                   (react-async-error
                                    (react-set-state self :busy nil :password "" :error (cadr failure)))))))
             (h1 (if up "Create an account" "Sign in"))
             (input (:class "name" :placeholder "name" :autocomplete "username" :value (react-state self :name)
                     :on-input (lambda (event) (react-set-state self :name (plist-get event :value)))))
             (input (:class "password" :type "password" :placeholder (if up "password, 8 or more" "password")
                     :autocomplete (if up "new-password" "current-password") :value (react-state self :password)
                     :on-input (lambda (event) (react-set-state self :password (plist-get event :value)))))
             (button (:class "go" :disabled (react-state self :busy)) (if up "Create" "Sign in"))
             (and (react-state self :error) (jsx (p (:class "error") (react-state self :error))))
             (p (:class "switch")
               (button (:type "button" :class "link"
                        :on-click (lambda (_event)
                                    (react-set-state self :error nil
                                                     :mode (if (eq (react-state self :mode) 'up) 'in 'up))))
                 (if up "I have an account" "Create an account"))))))))

(defun todos-ask (self method path &optional data)
  "Send a request about the todos, then show the list that comes back."
  (react-async
    (condition-case failure
        (react-set-state self :error nil :todos (react-await (todos-api method path data)))
      (react-async-error
       (if (equal (cadr failure) "Sign in first")
           (funcall (react-props self :on-signed-out))
         (react-set-state self :error (cadr failure)))))))

(react-define-component 'Todo
  :pure t
  :initial-state (lambda (_props) (list :sending nil))
  :render
  (lambda (self)
    (let ((todo (react-props self :todo)))
      (jsx (li (:class (if (plist-get todo :done) "todo done" "todo"))
             (div (:class "line")
               (input (:class "toggle" :type "checkbox" :checked (plist-get todo :done)
                       :on-change (lambda (_event) (funcall (react-props self :on-toggle) (plist-get todo :id)))))
               (span (:class "title") (plist-get todo :title))
               (label (:class "attach" :title "attach a file")
                 (if (react-state self :sending) "…" "📎")
                 (input (:class "file" :type "file" :ref "file"
                         :on-change
                         (lambda (event)
                           (let* ((files (plist-get event :files))
                                  (chosen (and (> (length files) 0) (aref files 0))))
                             (when chosen
                               (react-set-state self :sending t)
                               (react-fetch (format "api/todos/attach?id=%d&name=%s" (plist-get todo :id)
                                                    (url-hexify-string (plist-get chosen :name)))
                                            :method "POST" :file (react-ref self "file")
                                            :then (lambda (response)
                                                    (react-set-state self :sending nil)
                                                    (funcall (react-props self :on-answer) response))
                                            :catch (lambda (message)
                                                     (react-set-state self :sending nil)
                                                     (funcall (react-props self :on-answer) (list :ok nil :text (prin1-to-string message)))))))))))
               (button (:class "remove" :title "remove"
                        :on-click (lambda (_event) (funcall (react-props self :on-remove) (plist-get todo :id))))
                 "×"))
             (and (plist-get todo :files)
                  (jsx (ul (:class "files")
                         (mapcar (lambda (file)
                                   (jsx (li (:key (plist-get file :id) :class "attachment")
                                          (a (:href (format "api/todos/file?id=%d" (plist-get file :id))) (plist-get file :name))
                                          (span (:class "size") (todos-size (plist-get file :size)))
                                          (button (:class "detach" :title "remove the file"
                                                   :on-click (lambda (_event)
                                                               (funcall (react-props self :on-detach) (plist-get file :id))))
                                            "×"))))
                                 (plist-get todo :files))))))))))

(react-define-component 'Todos
  :initial-state (lambda (_props) (list :todos nil :draft "" :error nil))
  :did-mount (lambda (self) (todos-ask self "GET" "api/todos"))
  :render
  (lambda (self)
    (let* ((todos (react-state self :todos))
           (left (seq-count (lambda (todo) (not (plist-get todo :done))) todos)))
      (jsx (main
             (header
               (h1 "Todos")
               (span (:class "me") (react-props self :name))
               (button (:class "link signout" :on-click (lambda (_event) (funcall (react-props self :on-sign-out))))
                 "sign out"))
             (form (:class "new"
                    :on-submit (lambda (_event)
                                 (let ((title (string-trim (react-state self :draft))))
                                   (unless (string-empty-p title)
                                     (react-set-state self :draft "")
                                     (todos-ask self "POST" "api/todos" title)))))
               (input (:class "draft" :placeholder "What is there to do?" :value (react-state self :draft)
                       :on-input (lambda (event) (react-set-state self :draft (plist-get event :value)))))
               (button (:class "add") "add"))
             (and (react-state self :error) (jsx (p (:class "error") (react-state self :error))))
             (ul (:class "todos")
               (mapcar (lambda (todo)
                         (jsx (Todo (:key (plist-get todo :id) :todo todo
                                     :on-toggle (lambda (id) (todos-ask self "POST" "api/todos/toggle" id))
                                     :on-remove (lambda (id) (todos-ask self "POST" "api/todos/remove" id))
                                     :on-detach (lambda (id) (todos-ask self "POST" "api/todos/detach" id))
                                     ;; The answer of an upload: the list, or why not.
                                     :on-answer (lambda (response)
                                                  (let ((value (ignore-errors (car (read-from-string (plist-get response :text))))))
                                                    (if (plist-get response :ok)
                                                        (react-set-state self :error nil :todos value)
                                                      (react-set-state self :error (if (stringp value) value "The file did not go")))))))))
                       todos))
             (footer
               (span (:class "count") (format "%d left of %d" left (length todos)))
               (and (< left (length todos))
                    (jsx (button (:class "link clear" :on-click (lambda (_event) (todos-ask self "POST" "api/todos/clear")))
                           "clear done")))))))))

(react-define-component 'App
  :initial-state (lambda (_props) (list :me nil :ready nil))
  :did-mount
  (lambda (self)
    (react-async
      (condition-case nil
          (react-set-state self :me (react-await (todos-api "GET" "api/me")) :ready t)
        (react-async-error (react-set-state self :ready t)))))
  :render
  (lambda (self)
    (let ((me (react-state self :me)))
      (cond ((not (react-state self :ready)) (jsx (p (:class "loading") "…")))
            (me (jsx (Todos (:key (plist-get me :name) :name (plist-get me :name)
                             :on-signed-out (lambda () (react-set-state self :me nil))
                             :on-sign-out (lambda ()
                                            (react-async
                                              (ignore-errors (react-await (todos-api "POST" "api/signout")))
                                              (react-set-state self :me nil)))))))
            (t (jsx (SignIn (:on-signed-in (lambda (me) (react-set-state self :me me))))))))))

(react-mount (jsx (App)) "#app")
