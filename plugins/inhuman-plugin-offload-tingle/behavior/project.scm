;; Project memory. The reducer is the owner. A private MCP child is optional
;; and is not required to commit. Citations are required. Core revision is the projection.
(define/reducer
  :initial (lambda () (dict :body "" :revision 0 :citation ""))
  :reduce (lambda (state action)
            (if (equal? (:type action) "put")
                (dict :body (:text action)
                      :revision (+ (:revision state) 1)
                      :citation (:citation action))
                state)))

(define/method 'get-memory
  :kind 'query
  :input (s/object)
  :output (s/string)
  :handler (lambda (input state) (:body state)))

(define/method 'search
  :kind 'query
  :input (s/object (s/field "query" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (if (or (> (string-length (:body state)) 800)
                     (not (string-contains? (:body state) (:query input))))
                 ""
                 (:body state))))

(define/method 'put-memory
  :kind 'command
  :input (s/object (s/field "text" (s/string)) (s/field "citation" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (if (equal? (:citation input) "")
                 (refuse "citation required — call put-memory again with citation set to the file the text came from")
                 (begin
                   (state/propose (dict :type "put"
                                        :text (:text input)
                                        :citation (:citation input)))
                   (:text input)))))
