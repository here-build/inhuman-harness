;; One note per round. The plan and a granted memory read are fused here.
;; This program does not subscribe to offload, and it does not stand on a
;; tool-argument path, so it registers no guard.
(hook/round
  :post (lambda (round)
          (let ((plan (call/method 'plan 'get)))
            (when (and (equal? (:status plan) "active") (> (:steps plan) 0))
              (let ((hit (call/method 'offload 'search :query (:text plan))))
                (call/method 'plan 'advance)
                (if (equal? hit "")
                    (self/notify 'activating (:text plan))
                    (begin
                      (call/method 'plan 'recall :text hit)
                      (self/notify 'activating
                                   (string-append (:text plan) "\n" hit)))))))))

(hook/round
  :post-fail (lambda (round failure)
               (call/method 'plan 'block)))
