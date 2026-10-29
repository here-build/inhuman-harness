(hook/round
  :post (lambda (round)
          (let ((goal (call/method 'goal 'get)))
            (when (and (equal? (:status goal) "active") (> (:loops goal) 0))
              (call/method 'goal 'tick)
              (self/notify 'activating (:text goal))))))

(hook/round
  :post-fail (lambda (round failure)
               (call/method 'goal 'block)))
