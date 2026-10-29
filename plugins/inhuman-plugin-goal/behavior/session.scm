;; Single-session goal. Rolls back with the session. No durable file.
(define/reducer
  :initial (lambda () (dict :text "" :status "none" :loops 0))
  :reduce (lambda (state action)
            (if (equal? (:type action) "set")
                (dict :text (:text action) :status "active" :loops (:loops action))
                (if (equal? (:type action) "tick")
                    (dict :text (:text state)
                          :status (if (> (:loops state) 1) "active" "exhausted")
                          :loops (max 0 (- (:loops state) 1)))
                    (if (equal? (:type action) "block")
                        (dict :text (:text state) :status "blocked" :loops (:loops state))
                        (if (equal? (:type action) "clear")
                            (dict :text "" :status "none" :loops 0)
                            state))))))

(define/method 'get
  :kind 'query
  :input (s/object)
  :output (s/object (s/field "text" (s/string)) (s/field "status" (s/string)) (s/field "loops" (s/number)))
  :handler (lambda (input state) state))

(define/method 'set
  :kind 'command
  :input (s/object (s/field "text" (s/string)) (s/field "loops" (s/number)))
  :output (s/string)
  :handler (lambda (input state)
             (state/propose (dict :type "set" :text (:text input) :loops (:loops input)))
             (:text input)))

(define/method 'tick
  :kind 'command
  :input (s/object)
  :output (s/number)
  :handler (lambda (input state)
             (state/propose (dict :type "tick"))
             (:loops state)))

(define/method 'block
  :kind 'command
  :input (s/object)
  :output (s/string)
  :handler (lambda (input state)
             (state/propose (dict :type "block"))
             "blocked"))

(define/method 'clear
  :kind 'command
  :input (s/object)
  :output (s/string)
  :handler (lambda (input state)
             (state/propose (dict :type "clear"))
             "cleared"))
