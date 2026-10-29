;; Writer behavior is the mutation grant. offload is silent: it does not
;; self/notify, and it does not wake a bot. Promotion uses the global receiver.
(define/tool 'offload
  :description "Retain a cited project fact"
  :expose 'tool
  :input (s/object (s/field "text" (s/string)) (s/field "citation" (s/string)))
  :handler (lambda (input)
             (call/method 'offload 'put-memory :text (:text input) :citation (:citation input))))
