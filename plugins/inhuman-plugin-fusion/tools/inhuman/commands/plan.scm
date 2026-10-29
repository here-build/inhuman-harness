;; /plan — the session plan. `/plan <objective>` opens it; the rows show its
;; status and clear it. Every commit is a call into this plugin's session
;; state (`plugin/method`). The foreground hook fuses the next note; this file
;; does not mint a child.

(define plugin "fusion")

(define (status-line reply)
  (if (not (:ok reply))
      (:error reply)
      (let ((plan (:value reply)))
        (if (equal? (:status plan) "none")
            "no plan"
            (string-append (:status plan)
                           " · "
                           (number->string (:steps plan))
                           " steps left · "
                           (:text plan))))))

(harness/choice
  :action (list
    (harness/action 'plugin/method
      :name "Open plan"
      :params (dict :plugin plugin
                    :method "open"
                    :args "{\"steps\": 8}"
                    :field "text"
                    :input "")))
  :choices (list
    (harness/choice
      :name "status"
      :description (status-line (rpc 'plugin/method (dict :plugin plugin :method "get"))))
    (harness/choice
      :name "clear"
      :description "Drop the session plan"
      :action (list (harness/action 'plugin/method :params (dict :plugin plugin :method "clear"))))))
