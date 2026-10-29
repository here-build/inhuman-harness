;; Scout is find/read. The grant list is what keeps commit off this bot.
(define/tool 'tingle
  :description "Recall retained memory"
  :expose 'tool
  :input (s/object (s/field "query" (s/string)))
  :handler (lambda (input)
             (call/method 'offload 'search :query (:query input))))
