;;; app-test.el --- tests of this application  -*- lexical-binding: t; -*-

;; test/run.sh runs these in a native Emacs, after checking that every
;; file of the project compiles without a warning, and so does
;; .github/workflows/test.yml at every push.  react-testing renders the
;; application without a browser: a test finds elements, clicks, types,
;; and answers what the page would ask server.el.  (The studio's editor
;; has no react-testing: Flymake there does not know this file's calls.)

(require 'ert)
(require 'react-testing)

(declare-function app-server-handle "server")

(defconst app-test-directory
  (file-name-directory (directory-file-name (file-name-directory (or load-file-name buffer-file-name))))
  "The project.")

(ert-deftest app-test-counter ()
  (react-testing-load (expand-file-name "app.el" app-test-directory))
  (should (equal (react-testing-text (react-testing-find :class "count")) "Count: 0"))
  (react-testing-click (react-testing-find :class "increment"))
  (react-testing-click (react-testing-find :class "increment"))
  (should (equal (react-testing-text (react-testing-find :class "count")) "Count: 2"))
  (react-testing-click (react-testing-find :class "reset"))
  (should (equal (react-testing-text (react-testing-find :class "count")) "Count: 0")))

(ert-deftest app-test-messages ()
  ;; The page asks server.el for the messages; the test answers.
  (react-testing-load (expand-file-name "app.el" app-test-directory))
  (should (equal (plist-get (react-testing-answer-fetch 200 "(\"first\" \"second\")") :url) "/api/messages"))
  (should (equal (react-testing-text (react-testing-find :class "message")) "first")))

(ert-deftest app-test-server ()
  ;; server.el itself, with a data directory of its own.
  (load (expand-file-name "server.el" app-test-directory) nil t)
  (let ((app-server-data-directory (make-temp-file "app-test-data" t)))
    (unwind-protect
        (progn
          (should (equal (app-server-handle "GET" "/api/messages" "") '("Hello from the server's Emacs")))
          (app-server-handle "POST" "/api/messages" "\"  hi  \"")
          (should (equal (app-server-handle "GET" "/api/messages" "") '("Hello from the server's Emacs" "hi")))
          (should-error (app-server-handle "POST" "/api/messages" "\"\"")))
      (delete-directory app-server-data-directory t))))

;;; app-test.el ends here
