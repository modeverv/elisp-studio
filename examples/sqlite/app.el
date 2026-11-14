;;; app.el --- a reading list  -*- lexical-binding: t; -*-

;; The page.  The books are kept by server.el in an SQLite database; this
;; file asks for them and shows them.  The search box is answered by the
;; database (WHERE title LIKE ?), not by filtering here.

(require 'url-util)

(defun api (method path &optional data)
  "An awaitable for a request to server.el.  Its value is Lisp data."
  (lambda (resolve reject)
    (react-fetch path
                 :method method
                 :body (and data (prin1-to-string data))
                 :then (lambda (response)
                         (let ((value (car (read-from-string (plist-get response :text)))))
                           (if (plist-get response :ok) (funcall resolve value) (funcall reject value))))
                 :catch reject)))

(react-define-component 'Book
  :should-update (lambda (self previous-props _previous-state)
                   (react-changed-p (react-props self) previous-props :book))
  :render
  (lambda (self)
    (let ((book (react-props self :book))
          (ask (lambda (path) (funcall (react-props self :on-ask) path (plist-get (react-props self :book) :id)))))
      (jsx (li (:class (if (plist-get book :done) "book done" "book"))
             (input (:class "toggle" :type "checkbox" :checked (plist-get book :done)
                     :on-change (lambda (_event) (funcall ask "/api/books/toggle"))))
             (span (:class "title") (plist-get book :title))
             (span (:class "added") (plist-get book :added))
             (button (:class "remove" :on-click (lambda (_event) (funcall ask "/api/books/remove"))) "×"))))))

(defun reading-list-ask (self method path &optional data)
  "Send a request for the list SELF shows, then show the list that comes back.
Every answer of server.el is the list as it is now, for the current search."
  (react-async
    (condition-case failure
        (react-set-state
         self :error nil
         :list (react-await
                (api method (concat path "?search=" (url-hexify-string (react-state self :search))) data)))
      (react-async-error (react-set-state self :error (cadr failure))))))

(react-define-component 'ReadingList
  :initial-state (lambda (_props) (list :list nil :search "" :draft "" :error nil))
  :did-mount (lambda (self) (reading-list-ask self "GET" "/api/books"))
  :render
  (lambda (self)
    (let ((list (react-state self :list)))
      (jsx (main
             (h1 "Reading list")
             (form (:class "new"
                    :on-submit (lambda (_event)
                                 (reading-list-ask self "POST" "/api/books" (react-state self :draft))
                                 (react-set-state self :draft "")))
               (input (:class "draft" :placeholder "A book to read" :value (react-state self :draft)
                       :on-input (lambda (event) (react-set-state self :draft (plist-get event :value)))))
               (button (:class "add") "add"))
             (input (:class "search" :placeholder "search (the database answers)" :value (react-state self :search)
                     :on-input (lambda (event)
                                 (react-set-state self :search (plist-get event :value))
                                 (reading-list-ask self "GET" "/api/books"))))
             (and (react-state self :error) (jsx (p (:class "error") (react-state self :error))))
             (ul (:class "books")
               (mapcar (lambda (book)
                         (jsx (Book (:key (plist-get book :id) :book book
                                     :on-ask (lambda (path id) (reading-list-ask self "POST" path id))))))
                       (plist-get list :books)))
             (and list
                  (jsx (p (:class "status")
                         (format "%d books, %d read. SQLite %s in the server's Emacs."
                                 (plist-get list :total) (plist-get list :read) (plist-get list :sqlite))))))))))

(react-mount (jsx (ReadingList)) "#app")
