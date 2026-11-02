(define/tool 'hello
  :description "Return a friendly greeting"
  :expose 'both
  :input (s/object (s/field "name" (s/string)))
  :handler (lambda (input)
             (string-append "Hello, " (:name input) "!")))
