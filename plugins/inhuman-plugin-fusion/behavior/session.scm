;; Session plan. Dies with the session. Memory lives on another owner.
(define (plan text status steps recall)
  (dict :text text :status status :steps steps :recall recall))

(define/reducer
  :initial (lambda () (plan "" "none" 0 ""))
  :reduce (lambda (state action)
            (if (equal? (:type action) "open")
                (plan (:text action) "active" (:steps action) "")
                (if (equal? (:type action) "advance")
                    (if (> (:steps state) 1)
                        (plan (:text state) "active" (- (:steps state) 1) (:recall state))
                        (plan (:text state) "done" 0 (:recall state)))
                    (if (equal? (:type action) "recall")
                        (plan (:text state) (:status state) (:steps state) (:text action))
                        (if (equal? (:type action) "block")
                            (plan (:text state) "blocked" (:steps state) (:recall state))
                            (if (equal? (:type action) "clear")
                                (plan "" "none" 0 "")
                                state)))))))

(define/method 'get
  :kind 'query
  :input (s/object)
  :output (s/object (s/field "text" (s/string))
                    (s/field "status" (s/string))
                    (s/field "steps" (s/number))
                    (s/field "recall" (s/string)))
  :handler (lambda (input state) state))

(define/method 'open
  :kind 'command
  :input (s/object (s/field "text" (s/string)) (s/field "steps" (s/number)))
  :output (s/string)
  :handler (lambda (input state)
             (if (or (equal? (:text input) "") (< (:steps input) 1))
                 (refuse "plan needs text and steps — call open again with a non-empty text and steps of at least 1")
                 (begin
                   (state/propose (dict :type "open"
                                        :text (:text input)
                                        :steps (:steps input)))
                   (:text input)))))

(define/method 'advance
  :kind 'command
  :input (s/object)
  :output (s/number)
  :handler (lambda (input state)
             (if (not (equal? (:status state) "active"))
                 (refuse "plan is not active — call open with the text and steps first, then advance")
                 (begin
                   (state/propose (dict :type "advance"))
                   (:steps state)))))

(define/method 'recall
  :kind 'command
  :input (s/object (s/field "text" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (if (equal? (:text input) "")
                 (refuse "empty recall — call recall again with the text you want remembered")
                 (begin
                   (state/propose (dict :type "recall" :text (:text input)))
                   (:text input)))))

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
