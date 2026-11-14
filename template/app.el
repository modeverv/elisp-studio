;;; app.el --- your application  -*- lexical-binding: t; -*-

;; This file is the program of the page on the right.  Change something,
;; save (C-x C-s), and the page changes: without a reload, and with the
;; state it had.  Click the counter a few times, then edit the text below.
;;
;; The library is elisp-react: https://github.com/modeverv/elisp-react

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

(react-define-component 'App
  :render
  (lambda (_self)
    (jsx (main
           (h1 "Hello from Emacs Lisp")
           (p "Edit app.el on the left and save.")
           (Counter)))))

(react-mount (jsx (App)) "#app")
