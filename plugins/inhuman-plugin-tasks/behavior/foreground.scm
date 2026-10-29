;; Foreground recitation. Pending-only is ambient; an open page activates.
(hook/round
  :post (lambda (round)
          (let ((remaining (call/method 'tasks 'incomplete)))
            (when (not (equal? (:text remaining) ""))
              (if (:open remaining)
                  (self/notify 'activating (:text remaining))
                  (self/notify 'ambient (:text remaining)))))))
