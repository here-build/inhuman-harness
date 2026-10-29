;; Project promotion. Acceptance is a durable id. Completion is a later action.
(define/reducer
  :initial (lambda () (dict :accepted "" :done #f))
  :reduce (lambda (state action)
            (if (equal? (:type action) "accept")
                (dict :accepted (:task-id action) :done (:done state))
                (if (equal? (:type action) "complete")
                    (dict :accepted (:accepted state) :done #t)
                    state))))

(define/method 'accept
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (state/propose (dict :type "accept" :task-id (:task-id input)))
             (:task-id input)))

(define/method 'accepted
  :kind 'query
  :input (s/object)
  :output (s/string)
  :handler (lambda (input state) (:accepted state)))

(define/method 'complete
  :kind 'command
  :input (s/object)
  :output (s/string)
  :handler (lambda (input state)
             (state/propose (dict :type "complete"))
             "done"))
