;;; app.el --- your application  -*- lexical-binding: t; -*-

;; This file is the program of the page on the right.  Change something,
;; save (C-x C-s), and the page changes: without a reload, and with the
;; state it had.  Click the counter a few times, then edit the text below.
;;
;; The library is elisp-react: https://github.com/modeverv/elisp-react

;; The page has it loaded already; an Emacs that checks this file
;; (Flymake, elisp-studio-local.el) learns from this what jsx and the
;; react-... functions are.
(require 'react)

(react-define-component 'Counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    (let ((count (react-state self :count)))
      (jsx (div (:class "counter")
             (p (:class "count") (format "Count: %d" count))
             (button (:class "increment"
                      :on-click (lambda (_event)
                                  (react-set-state self :count (1+ (react-state self :count)))))
               "+1")
             (button (:class "reset" :disabled (= count 0)
                      :on-click (lambda (_event) (react-set-state self :count 0)))
               "reset"))))))

;; The server side is server.el.  The page asks it with `react-fetch'; both
;; sides speak Lisp: a request body is printed data, and so is the answer.

(defun api (method path &optional data)
  "An awaitable for a request to server.el.  Its value is Lisp data."
  (lambda (resolve reject)
    (react-fetch path
                 :method method
                 :body (and data (prin1-to-string data))
                 :then (lambda (response)
                         (let ((value (car (read-from-string (plist-get response :text)))))
                           (if (plist-get response :ok)
                               (funcall resolve value)
                             (funcall reject value))))
                 :catch reject)))

(react-define-component 'Messages
  :initial-state (lambda (_props) (list :messages nil :draft "" :error nil))
  :did-mount
  (lambda (self)
    (react-async
      (condition-case failure
          (react-set-state self :messages (react-await (api "GET" "/api/messages")))
        (react-async-error (react-set-state self :error (cadr failure))))))
  :render
  (lambda (self)
    (jsx (section (:class "messages")
           (h2 "Messages kept by the server")
           (form (:on-submit (lambda (_event)
                               (react-async
                                 (condition-case failure
                                     (react-set-state
                                      self :error nil :draft ""
                                      :messages (react-await (api "POST" "/api/messages" (react-state self :draft))))
                                   (react-async-error (react-set-state self :error (cadr failure)))))))
             (input (:class "draft" :placeholder "Say something" :value (react-state self :draft)
                     :on-input (lambda (event) (react-set-state self :draft (plist-get event :value)))))
             (button (:class "send") "send"))
           (and (react-state self :error) (jsx (p (:class "error") (react-state self :error))))
           (ul (mapcar (lambda (message) (jsx (li (:class "message") message)))
                       (react-state self :messages)))))))

(react-define-component 'App
  :render
  (lambda (_self)
    (jsx (main
           (h1 "Hello from Emacs Lisp")
           (p "Edit app.el on the left and save.")
           (Counter)
           (Messages)))))

(react-mount (jsx (App)) "#app")
