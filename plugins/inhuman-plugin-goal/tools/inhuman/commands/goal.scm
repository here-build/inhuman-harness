;; /goal — the session goal. `/goal <objective>` sets it; the rows show its
;; status and clear it. Every commit is a call into this plugin's session
;; state (`plugin/method`). Continuation is the foreground hook/round, not a
;; minted child and not session KV.

(define plugin "inhuman-plugin-goal")

(define (goal-action method)
  (harness/action 'plugin/method :params (dict :plugin plugin :method method)))

(define (status-line reply)
  (if (not (:ok reply))
      (:error reply)
      (let ((goal (:value reply)))
        (if (equal? (:status goal) "none")
            "no goal"
            (string-append (:status goal)
                           " · "
                           (number->string (:loops goal))
                           " loops left · "
                           (:text goal))))))

(harness/choice
  :action (list
    (harness/action 'plugin/method
      :name "Set goal"
      :params (dict :plugin plugin
                    :method "set"
                    :args "{\"loops\": 32}"
                    :field "text"
                    :input "")))
  :choices (list
    (harness/choice
      :name "status"
      :description (status-line (rpc 'plugin/method (dict :plugin plugin :method "get"))))
    (harness/choice
      :name "clear"
      :description "Drop the session goal"
      :action (list (goal-action "clear")))))
