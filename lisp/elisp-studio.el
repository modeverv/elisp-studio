;;; elisp-studio.el --- the editor's side of elisp-studio  -*- lexical-binding: t; -*-

;; Loaded into the Emacs on the left of the studio (js/studio.js passes it
;; as an --eval form).  It connects this Emacs with the page around it:
;;
;;   to the page    `elisp-studio--send': a JSON object in an OSC 7777
;;                  terminal sequence, which the wasmacs page forwards
;;   from the page  JSON typed into the terminal between two escape
;;                  sequences, like a bracketed paste; it arrives as the
;;                  event `elisp-studio-message'
;;
;; and gives the project's buffers their commands:
;;
;;   C-M-x     send the definition at point to the running application
;;             (no need to save; components keep their state)
;;   C-c C-p   publish: commit the project with git and push it
;;             (`elisp-studio-publish')
;;
;; What the application's Emacs says about a saved file (compiler
;; warnings, errors) is shown in the buffer *elisp-studio*, in
;; `compilation-mode': RET or M-g n jumps to the place.
;;
;; While you type, the project's buffers are checked by Flymake: this Emacs
;; byte-compiles the buffer's text (without saving or running it) a moment
;; after each change, marks the places the compiler complains about and
;; counts them in the mode line; M-x flymake-goto-next-error walks through
;; them.
;;
;; This Emacs knows the functions the project uses, without running the
;; project: the libraries (elisp-react's react.el, app-server.el) are loaded
;; here, where they do nothing, and the project's own definitions are taken
;; from its files whenever one is saved (`elisp-studio-learn-file').  So
;; C-M-i completes their names, ElDoc shows their arguments, M-. goes to
;; their definitions and C-h f describes them.

;;; Code:

(require 'json)
(require 'compile)
(require 'flymake)
(require 'bytecomp)

(defconst elisp-studio-project "/home/user/elisp-studio/app/"
  "The directory of the project.")

(defconst elisp-studio--log-buffer "*elisp-studio*")

;;;; To the page

(defun elisp-studio--send (&rest message)
  "Send MESSAGE, a plist, to the studio page as a JSON object."
  (send-string-to-terminal
   (concat "\e]7777;"
           (base64-encode-string (encode-coding-string (json-serialize message) 'utf-8) t)
           "\a")))

;;;; From the page

(defconst elisp-studio--message-start "\e[7777~")
(defconst elisp-studio--message-end "\e[7778~")

(defun elisp-studio--read-message (_prompt)
  "Read what the page types after `elisp-studio--message-start'.
The value is the key sequence for `input-decode-map': one event that
carries the decoded message."
  (let ((end-length (length elisp-studio--message-end)))
    (with-temp-buffer
      (set-buffer-multibyte nil)
      (while (not (search-backward elisp-studio--message-end (- (point) end-length) t))
        (let ((event (read-event nil nil 10)))
          (if (characterp event)
              (insert event)
            (error "The studio's message did not arrive completely"))))
      (vector (list 'elisp-studio-message
                    (json-parse-string
                     (decode-coding-string
                      (base64-decode-string (buffer-substring (point-min) (point))) 'utf-8)
                     :object-type 'plist :null-object nil :false-object nil))))))

(defun elisp-studio--handle-message (event)
  "Act on a message of the studio page."
  (interactive "e")
  (let ((message (cadr event)))
    (pcase (plist-get message :type)
      ("log"
       (elisp-studio--show-log (plist-get message :status)
                               (plist-get message :summary)
                               (plist-get message :log))))))

(define-key input-decode-map elisp-studio--message-start #'elisp-studio--read-message)
;; Like a bracketed paste (xterm-paste), the event goes through the keymaps.
(global-set-key [elisp-studio-message] #'elisp-studio--handle-message)

;;;; What the application says

(defun elisp-studio--show-log (status summary log)
  "Show the application's answer to a change.
STATUS is \"ok\" or \"error\", SUMMARY one line, LOG the compiler's
messages and errors with file names of this Emacs (or nil)."
  (let ((buffer (get-buffer-create elisp-studio--log-buffer))
        (text (string-trim (or log ""))))
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

;;;; Diagnostics while typing (Flymake)

;; Emacs's own Flymake backends for Emacs Lisp start a second Emacs, which
;; this one cannot.  This backend compiles in this Emacs: the buffer's text
;; goes to a scratch file, `byte-compile-file' reads it, and what the
;; compiler has to say is collected instead of logged.  Compiling does not
;; run the program; it does expand its macros.

(defconst elisp-studio--check-directory "/tmp/elisp-studio/check/")

(defun elisp-studio--compiler-messages ()
  "Byte-compile the current buffer's text; return what the compiler says.
The value is a list of (POSITION LEVEL TEXT): a buffer position or nil,
:warning or :error, and the message."
  (let* ((file (expand-file-name (file-name-nondirectory (or buffer-file-name "buffer.el"))
                                 elisp-studio--check-directory))
         (text (buffer-substring-no-properties (point-min) (point-max)))
         (found nil)
         (byte-compile-log-warning-function
          (lambda (string &optional position _fill level)
            (push (list position (if (eq level :error) :error :warning) string) found)))
         (byte-compile-dest-file-function (lambda (source) (concat source "c")))
         (byte-compile-verbose nil)
         (inhibit-message t)
         (coding-system-for-write 'utf-8-unix))
    (make-directory elisp-studio--check-directory t)
    (write-region text nil file nil 'silent)
    (condition-case err
        (byte-compile-file file)
      (error (push (list nil :error (error-message-string err)) found)))
    (ignore-errors (delete-file file))
    (ignore-errors (delete-file (concat file "c")))
    (nreverse found)))

(defun elisp-studio-flymake (report-function &rest _)
  "A Flymake backend: the byte compiler's opinion of this buffer as it is."
  (funcall report-function
           (mapcar (lambda (entry)
                     (let* ((position (and (integerp (car entry))
                                           (min (max (car entry) (point-min)) (point-max))))
                            (bounds (and position
                                         (save-excursion
                                           (goto-char position)
                                           (or (bounds-of-thing-at-point 'symbol)
                                               (bounds-of-thing-at-point 'sexp)))))
                            (beg (or (car bounds) position (point-min)))
                            (end (or (cdr bounds) (min (1+ beg) (point-max)))))
                       (flymake-make-diagnostic (current-buffer) beg end (nth 1 entry) (nth 2 entry))))
                   (elisp-studio--compiler-messages))))

;;;; The project's own definitions

;; To complete a name, show a function's arguments or find its definition,
;; Emacs has to have the function.  The project's files are not loaded here
;; (they are the application's program, and this is the editor), but their
;; definitions are taken out and made: functions and macros with their
;; bodies, which nothing calls here; variables without their values.

(defconst elisp-studio--function-definers
  '(defun defmacro defsubst cl-defun cl-defmacro cl-defsubst define-inline cl-defgeneric))

(defun elisp-studio--record (file definition)
  "Note in `load-history' that FILE has DEFINITION, so that M-. finds it."
  (let ((entry (assoc file load-history)))
    (unless entry
      (setq entry (list file))
      (push entry load-history))
    (unless (member definition (cdr entry))
      (setcdr entry (cons definition (cdr entry))))))

(defun elisp-studio-learn-file (file)
  "Make the definitions of the Emacs Lisp FILE known to this Emacs.
Top-level definitions of functions, macros, structures and errors are
evaluated; variables are only declared.  Everything else in the file is
left alone: nothing of the program runs.  Returns how many definitions
were taken."
  (let ((count 0))
    (with-temp-buffer
      (insert-file-contents file)
      (goto-char (point-min))
      (let (form)
        (while (setq form (condition-case nil (read (current-buffer)) (error nil)))
          (condition-case nil
              (pcase form
                (`(,(and definer (guard (memq definer elisp-studio--function-definers))) ,(and name (pred symbolp)) . ,_)
                 (eval form t)
                 (elisp-studio--record file (cons 'defun name))
                 (setq count (1+ count)))
                (`(,(or 'defvar 'defconst 'defcustom 'defvar-local) ,(and name (pred symbolp)) . ,rest)
                 ;; Known as a variable, with its documentation, but the
                 ;; initial value is the program's business.
                 (unless (boundp name) (set name nil))
                 (eval `(defvar ,name) t)
                 (when (stringp (nth 1 rest)) (put name 'variable-documentation (nth 1 rest)))
                 (elisp-studio--record file name)
                 (setq count (1+ count)))
                (`(,(or 'cl-defstruct 'define-error 'require) . ,_)
                 (eval form t)))
            (error nil)))))
    count))

(defun elisp-studio-learn-project ()
  "Take the definitions of every Emacs Lisp file of the project."
  (dolist (file (directory-files-recursively elisp-studio-project "\\.el\\'"))
    (unless (string-match-p "/\\." (file-relative-name file elisp-studio-project))
      (elisp-studio-learn-file file))))

;;;; The project's buffers

(defun elisp-studio-eval-defun ()
  "Send the top-level form at point to the running application.
The application evaluates it at once; a component that is defined
again renders with the state it has.  The file need not be saved."
  (interactive)
  (let ((text (save-excursion
                (end-of-defun)
                (let ((end (point)))
                  (beginning-of-defun)
                  (buffer-substring-no-properties (point) end)))))
    (elisp-studio--send :type "eval"
                        :file (file-relative-name buffer-file-name elisp-studio-project)
                        :text text)
    (message "Sent to the application: %s" (car (split-string text "\n")))))

;;;; Publishing

;; The project is a directory of plain files, and git runs inside this
;; Emacs.  Publishing is a commit and, when the repository has a remote
;; named origin, a push.  A project without server.el is a static site: a
;; push to a GitHub repository with Pages enabled puts it on the web.
;;
;; Pushing over HTTPS goes through the wasmacs Chrome companion extension
;; and needs credentials for the remote; see "Git clone, fetch and push" in
;; the wasmacs README.  Once:
;;
;;   M-x shell
;;   cd ~/elisp-studio/app
;;   git remote add origin https://github.com/YOU/REPOSITORY.git

(defconst elisp-studio--git-buffer "*elisp-studio-git*")

(defun elisp-studio--git (&rest arguments)
  "Run git with ARGUMENTS in the project.  Returns its exit status.
The command and its output are appended to `elisp-studio--git-buffer'."
  (let ((default-directory elisp-studio-project))
    (with-current-buffer (get-buffer-create elisp-studio--git-buffer)
      (goto-char (point-max))
      (insert "$ git " (mapconcat #'identity arguments " ") "\n")
      (let ((status (apply #'process-file "git" nil t nil arguments)))
        (unless (bolp) (insert "\n"))
        status))))

(defun elisp-studio-publish (message)
  "Commit the project with MESSAGE and push it to the remote origin.
Without a remote the commit is made and the push is left out."
  (interactive (list (read-string "Commit message: " "Update")))
  (save-some-buffers t (lambda ()
                         (and buffer-file-name
                              (string-prefix-p elisp-studio-project (expand-file-name buffer-file-name)))))
  (with-current-buffer (get-buffer-create elisp-studio--git-buffer)
    (let ((inhibit-read-only t)) (erase-buffer)))
  (unless (file-directory-p (expand-file-name ".git" elisp-studio-project))
    (elisp-studio--git "init" "-q"))
  (elisp-studio--git "add" "-A")
  (let* ((committed (if (zerop (elisp-studio--git "diff" "--cached" "--quiet"))
                        nil
                      (zerop (elisp-studio--git "commit" "-q" "-m" message))))
         (remote (zerop (elisp-studio--git "remote" "get-url" "origin")))
         (pushed (and remote (zerop (elisp-studio--git "push" "-u" "origin" "HEAD"))))
         (summary (cond ((and remote pushed) (if committed "Committed and pushed." "Nothing new to commit; pushed."))
                        (remote "The push failed.")
                        (committed "Committed.  No remote yet: git remote add origin URL, then publish again.")
                        (t "Nothing new to commit, and no remote to push to."))))
    (when (and remote (not pushed))
      (display-buffer elisp-studio--git-buffer '((display-buffer-reuse-window display-buffer-at-bottom)
                                                 (window-height . 8))))
    (message "elisp-studio: %s" summary)
    (if remote pushed committed)))

(defvar elisp-studio-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-M-x") #'elisp-studio-eval-defun)
    (define-key map (kbd "C-c C-p") #'elisp-studio-publish)
    map))

(defun elisp-studio--saved ()
  "Tell the page that this file was saved (its text may be unchanged)."
  (elisp-studio-learn-file buffer-file-name)
  (elisp-studio--send :type "saved"
                      :file (file-relative-name buffer-file-name elisp-studio-project)))

(define-minor-mode elisp-studio-mode
  "Commands for a file of the studio's project."
  :lighter " Studio"
  :keymap elisp-studio-mode-map
  (cond (elisp-studio-mode
         (add-hook 'after-save-hook #'elisp-studio--saved nil t)
         (setq-local flymake-diagnostic-functions '(elisp-studio-flymake))
         (flymake-mode 1))
        (t
         (remove-hook 'after-save-hook #'elisp-studio--saved t)
         (flymake-mode -1))))

(defun elisp-studio--maybe-enable ()
  (when (and buffer-file-name
             (string-prefix-p elisp-studio-project (expand-file-name buffer-file-name))
             (derived-mode-p 'emacs-lisp-mode))
    (elisp-studio-mode 1)))

(elisp-studio-learn-project)
(add-hook 'find-file-hook #'elisp-studio--maybe-enable)
(dolist (buffer (buffer-list))
  (with-current-buffer buffer (elisp-studio--maybe-enable)))

(elisp-studio--send :type "ready")

(provide 'elisp-studio)
;;; elisp-studio.el ends here
