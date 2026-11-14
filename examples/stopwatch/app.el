;;; app.el --- a stopwatch  -*- lexical-binding: t; -*-

;; Start it, then change this file and save: the page changes while the
;; clock keeps running.

(defun stopwatch-format (tenths)
  "TENTHS of a second as MM:SS.T."
  (format "%02d:%02d.%d" (/ tenths 600) (% (/ tenths 10) 60) (% tenths 10)))

(react-define-component 'Stopwatch
  :initial-state (lambda (_props) (list :tenths 0 :timer nil :laps nil))
  :will-unmount (lambda (self) (react-clear-timer (react-state self :timer)))
  :render
  (lambda (self)
    (let* ((tenths (react-state self :tenths))
           (running (react-state self :timer))
           (laps (react-state self :laps)))
      (jsx (main
             (h1 "Stopwatch")
             (p (:class "time") (stopwatch-format tenths))
             (div (:class "buttons")
               (button (:class "toggle"
                        :on-click (lambda (_event)
                                    (if (react-state self :timer)
                                        (progn (react-clear-timer (react-state self :timer))
                                               (react-set-state self :timer nil))
                                      (react-set-state
                                       self :timer
                                       (react-set-interval
                                        100 (lambda ()
                                              (react-set-state self :tenths (1+ (react-state self :tenths)))))))))
                 (if running "stop" "start"))
               (button (:class "lap" :disabled (not running)
                        :on-click (lambda (_event)
                                    (react-set-state self :laps (cons (react-state self :tenths)
                                                                      (react-state self :laps)))))
                 "lap")
               (button (:class "reset" :disabled (or running (= tenths 0))
                        :on-click (lambda (_event) (react-set-state self :tenths 0 :laps nil)))
                 "reset"))
             (ol (:class "laps" :reversed t)
               (mapcar (lambda (lap) (jsx (li (:key lap) (stopwatch-format lap))))
                       laps)))))))

(react-mount (jsx (Stopwatch)) "#app")
