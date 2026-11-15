;;; elisp-studio-local.el --- your own Emacs and a studio on this machine  -*- lexical-binding: t; -*-

;; Copyright (c) 2026 modeverv
;; SPDX-License-Identifier: MIT

;;; Commentary:

;; The studio can show an application whose files lie in a directory of
;; this machine:
;;
;;   node tools/studio.mjs ~/my-app
;;
;; opens a window with the application and follows the directory: a file
;; that is saved there, by whatever saved it, is applied to the running
;; application, which keeps its state.  That needs nothing in Emacs.
;;
;; This file is for what the window cannot do by itself.  Load it in the
;; Emacs you edit with,
;;
;;   (load "/path/to/elisp-studio/lisp/elisp-studio-local.el")
;;
;; and in the files of such a project (`elisp-studio-local-mode', switched
;; on when a file of the project is opened):
;;
;;   C-x C-s   as ever; then the studio's answer arrives in the echo area:
;;             "app.el updated: no reload, state kept", or the compiler's
;;             warnings and the error in the buffer *elisp-studio*, where
;;             `next-error' goes to their places
;;   C-M-x     evaluate the definition at point in the running application,
;;             without saving the file
;;
;; A project is a directory that the studio follows: tools/studio.mjs
;; leaves a file .elisp-studio.json there with its own address.

;;; Code:

(require 'json)
(require 'url)
(require 'compile)

(defgroup elisp-studio-local nil
  "A project of elisp-studio in a directory, edited with this Emacs."
  :group 'tools)

(defcustom elisp-studio-local-wait 10
  "Seconds to wait for the studio's answer to a save."
  :type 'number)

(defconst elisp-studio-local--log-buffer "*elisp-studio*")

(defvar elisp-studio-local-last-report nil
  "What the studio said last: a plist (:n N :status S :summary S :log S).")

(defun elisp-studio-local--project ()
  "The project of the visited file: (DIRECTORY . ADDRESS), or nil."
  (let* ((file (or buffer-file-name default-directory))
         (directory (and file (locate-dominating-file file ".elisp-studio.json"))))
    (when directory
      (let ((address (ignore-errors
                       (with-temp-buffer
                         (insert-file-contents (expand-file-name ".elisp-studio.json" directory))
                         (gethash "url" (json-parse-buffer))))))
        (and (stringp address) (cons (expand-file-name directory) address))))))

(defun elisp-studio-local--parse ()
  "The JSON object in the answer of the current buffer, as a plist; or nil."
  (goto-char (point-min))
  (when (re-search-forward "\r?\n\r?\n" nil t)
    (ignore-errors
      (json-parse-buffer :object-type 'plist :null-object nil :false-object nil))))

(defun elisp-studio-local--ask (address path &optional data timeout)
  "Ask the studio at ADDRESS for PATH now; DATA (a plist) is sent as JSON.
The answer as a plist, or nil if the studio does not answer within
TIMEOUT seconds (5)."
  (let ((url-request-method (if data "POST" "GET"))
        (url-request-data (and data (encode-coding-string (json-serialize data) 'utf-8)))
        (url-request-extra-headers (and data '(("Content-Type" . "application/json"))))
        ;; The studio is on this machine, whatever proxy the rest uses.
        (url-proxy-services nil)
        (url-show-status nil))
    (let ((buffer (ignore-errors (url-retrieve-synchronously (concat address path) t t (or timeout 5)))))
      (when buffer
        (unwind-protect
            (with-current-buffer buffer (elisp-studio-local--parse))
          (kill-buffer buffer))))))

;;;; What this Emacs knows of the project

;; Flymake, completion and M-. need react.el (jsx, react-set-state ...) and
;; the project's own definitions.  The libraries come from the studio, which
;; has them (a checkout next to it, or its cache), into a directory of this
;; machine that goes on `load-path' and Flymake's; the project's files are
;; read for their definitions, which are made here without running the
;; program.

(defvar elisp-studio-local--libraries-from nil "The studio whose libraries this Emacs has.")

(defun elisp-studio-local--libraries (address)
  "Fetch react.el and app-server.el from the studio at ADDRESS, once."
  (unless (equal elisp-studio-local--libraries-from address)
    (let ((directory (expand-file-name "elisp-studio/lisp/" (or (getenv "XDG_CACHE_HOME") "~/.cache"))))
      (make-directory directory t)
      (dolist (library '(("/elisp-react/lisp/react.el" . "react.el") ("/elisp-studio/lisp/app-server.el" . "app-server.el")))
        (let ((buffer (let ((url-proxy-services nil) (url-show-status nil))
                        (ignore-errors (url-retrieve-synchronously (concat address (car library)) t t 10)))))
          (when buffer
            (unwind-protect
                (with-current-buffer buffer
                  (goto-char (point-min))
                  (when (and (looking-at "HTTP/[0-9.]+ 200") (re-search-forward "\r?\n\r?\n" nil t))
                    (let ((coding-system-for-write 'no-conversion))
                      (write-region (point) (point-max) (expand-file-name (cdr library) directory) nil 'silent))))
              (kill-buffer buffer)))))
      (add-to-list 'load-path directory)
      (defvar elisp-flymake-byte-compile-load-path)
      (add-to-list 'elisp-flymake-byte-compile-load-path directory)
      (ignore-errors (require 'react))
      (setq elisp-studio-local--libraries-from address))))

(defun elisp-studio-local-learn-file (file)
  "Make the top-level definitions of FILE known here, without running it:
functions and macros are defined, variables declared, components named."
  (with-temp-buffer
    (insert-file-contents file)
    (goto-char (point-min))
    (let (form)
      (while (setq form (condition-case nil (read (current-buffer)) (error nil)))
        (condition-case nil
            (pcase form
              (`(,(or 'defun 'defmacro 'defsubst 'cl-defun 'cl-defmacro 'define-inline) ,(and name (pred symbolp)) . ,_)
               (eval form t)
               (put name 'definition-name name))
              (`(,(or 'defvar 'defconst 'defcustom) ,(and name (pred symbolp)) . ,_)
               (unless (boundp name) (set name nil))
               (eval `(defvar ,name) t))
              (`(react-define-component (quote ,(and name (pred symbolp))) . ,_)
               (unless (fboundp name)
                 (defalias name (lambda (&rest _) nil) "A component of the project (react-define-component).")))
              (`(,(or 'cl-defstruct 'define-error) . ,_) (eval form t)))
          (error nil))))))

(defun elisp-studio-local--learn (directory)
  "Know the definitions of the project in DIRECTORY; let Flymake find its files."
  (defvar elisp-flymake-byte-compile-load-path)
  (add-to-list 'elisp-flymake-byte-compile-load-path directory)
  (dolist (file (directory-files-recursively directory "\\.el\\'"))
    (unless (string-match-p "/\\.\\|/vendor/\\|/\\.data/" (file-relative-name file directory))
      (elisp-studio-local-learn-file file))))

(defun elisp-studio-local--show (report)
  "Show REPORT, the studio's answer to a change."
  (setq elisp-studio-local-last-report report)
  (let ((status (plist-get report :status))
        (summary (or (plist-get report :summary) "elisp-studio: no answer"))
        (text (string-trim (or (plist-get report :log) "")))
        (buffer (get-buffer-create elisp-studio-local--log-buffer)))
    (with-current-buffer buffer
      (unless (derived-mode-p 'compilation-mode) (compilation-mode))
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert summary "\n")
        (unless (string-empty-p text) (insert "\n" text "\n")))
      (goto-char (point-min))
      (setq next-error-last-buffer buffer))
    (if (and (equal status "ok") (string-empty-p text))
        ;; Nothing to read: make room again.
        (let ((window (get-buffer-window buffer)))
          (when (and window (not (one-window-p))) (delete-window window)))
      (display-buffer buffer '((display-buffer-reuse-window display-buffer-at-bottom)
                               (window-height . 8))))
    (message "%s" summary)))

(defun elisp-studio-local--await (address after)
  "Show the studio's first report after number AFTER, when it comes."
  (let ((url-proxy-services nil)
        (url-show-status nil))
    (url-retrieve
     (format "%s/__project/report?after=%d&wait=%d" address after elisp-studio-local-wait)
     (lambda (status)
       (let ((report (and (not (plist-get status :error)) (elisp-studio-local--parse))))
         (kill-buffer (current-buffer))
         (cond ((plist-get report :summary) (elisp-studio-local--show report))
               (report (message "elisp-studio: no answer from the application (is the studio's window open?)"))
               (t (message "elisp-studio: the studio does not answer (node tools/studio.mjs DIRECTORY)")))))
     nil t t)))

(defvar-local elisp-studio-local--before nil
  "The number of the studio's last report when this buffer was about to be saved.")

(defun elisp-studio-local--saving ()
  "Note where the studio's reports stand, so that the next one is this save's."
  (let ((project (elisp-studio-local--project)))
    (setq elisp-studio-local--before
          (and project (plist-get (elisp-studio-local--ask (cdr project) "/__project/state") :report)))))

(defun elisp-studio-local--saved-learn ()
  (when buffer-file-name (elisp-studio-local-learn-file buffer-file-name)))

(defun elisp-studio-local--saved ()
  "The studio sees the saved file by itself; wait for what it says."
  (let ((project (elisp-studio-local--project)))
    (when (and project elisp-studio-local--before)
      (elisp-studio-local--await (cdr project) elisp-studio-local--before))))

(defun elisp-studio-local-eval-defun ()
  "Evaluate the definition at point in the running application.
The file is not saved, and the application keeps its state."
  (interactive)
  (let ((project (or (elisp-studio-local--project) (user-error "This file is not in a project that a studio follows")))
        (text (save-excursion
                (end-of-defun)
                (let ((end (point)))
                  (beginning-of-defun)
                  (buffer-substring-no-properties (point) end)))))
    (let ((answer (elisp-studio-local--ask
                   (cdr project) "/__project/eval"
                   (list :file (file-relative-name buffer-file-name (car project)) :text text))))
      (cond ((null answer) (message "elisp-studio: the studio does not answer (node tools/studio.mjs DIRECTORY)"))
            ((eq (plist-get answer :listening) 0) (message "elisp-studio: the studio's window is not open"))
            (t (elisp-studio-local--await (cdr project) (plist-get answer :report)))))))

(defun elisp-studio-local-eval-expression (text)
  "Evaluate the expression TEXT in the running application and show its value.
\(react-inspect) shows the components with their props and state.
Returns the printed value."
  (interactive (list (read-from-minibuffer "Eval in the application: " nil read-expression-map nil
                                           'read-expression-history)))
  (let* ((project (or (elisp-studio-local--project) (user-error "This file is not in a project that a studio follows")))
         (answer (elisp-studio-local--ask (cdr project) "/__project/value" (list :text text) 20)))
    (cond ((null answer) (message "elisp-studio: the studio does not answer (node tools/studio.mjs DIRECTORY)") nil)
          ((plist-get answer :error) (message "elisp-studio: %s" (plist-get answer :error)) nil)
          (t (let ((output (plist-get answer :output)))
               (unless (equal output "") (message "%s" (string-trim-right output))))
             (message "%s" (plist-get answer :value))
             (plist-get answer :value)))))

(defvar elisp-studio-local-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-M-x") #'elisp-studio-local-eval-defun)
    (define-key map (kbd "C-c C-e") #'elisp-studio-local-eval-expression)
    map))

;;;###autoload
(define-minor-mode elisp-studio-local-mode
  "A file of a project that a studio on this machine follows.
Saving shows the studio's answer; \\[elisp-studio-local-eval-defun]
evaluates the definition at point in the running application;
\\[elisp-studio-local-eval-expression] evaluates an expression there and
shows its value."
  :lighter " Studio"
  (when elisp-studio-local-mode
    (let ((project (elisp-studio-local--project)))
      (when project
        (elisp-studio-local--libraries (cdr project))
        (elisp-studio-local--learn (car project)))))
  (if elisp-studio-local-mode
      (progn (add-hook 'before-save-hook #'elisp-studio-local--saving nil t)
             (add-hook 'after-save-hook #'elisp-studio-local--saved nil t)
             (add-hook 'after-save-hook #'elisp-studio-local--saved-learn nil t))
    (remove-hook 'before-save-hook #'elisp-studio-local--saving t)
    (remove-hook 'after-save-hook #'elisp-studio-local--saved t)
    (remove-hook 'after-save-hook #'elisp-studio-local--saved-learn t)))

(defun elisp-studio-local--maybe-enable ()
  "Switch `elisp-studio-local-mode' on in the files of a studio's project."
  (when (and buffer-file-name (elisp-studio-local--project))
    (elisp-studio-local-mode 1)))

(add-hook 'find-file-hook #'elisp-studio-local--maybe-enable)

(provide 'elisp-studio-local)
;;; elisp-studio-local.el ends here
