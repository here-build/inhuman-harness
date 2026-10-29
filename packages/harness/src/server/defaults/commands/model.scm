;; /model — session model from live.models (openai-compat invocation ids).
;; Select is kv/set connection, then kv/set model, both with remember so
;; the choice is also the default. The daemon records the per-connection
;; last-used index from that write — /connect reads it back. A bare kv/set
;; (subagent, --model) changes only this session.
;; Not adopt/drop — that is /connect. Faces with 20+ ids sit below smaller catalogs.
;; Primitive: no require.

(define (as-list x)
  (cond ((vector? x) (vector->list x))
        ((list? x) x)
        (else (list))))

(define (as-dict x)
  (if (or (not x) (null? x)) (dict) x))

(define (live-of c)
  (as-dict (:live c)))

(define (driver-can d)
  (if d (as-list (:abilityClaim d)) (list)))

(define (models-of c)
  (as-list (:models (live-of c))))

(define (small-catalog? c)
  (< (length (models-of c)) 20))

(let* ((connections
             (filter
               (lambda (c)
                 (member "completion"
                         (driver-can (:driver c))))
               (as-list (harness/kernel/connections))))

           (ordered
             (append
               (filter small-catalog? connections)
               (filter (lambda (c) (not (small-catalog? c))) connections)))

           (active-model
             (harness/session/get-current 'model))

           (select-model
             (lambda (c mid)
               (list
                 (harness/action 'kv/set
                   :params (dict :key "connection" :value (:id c) :remember "1"))
                 (harness/action 'kv/set
                   :params (dict :key "model" :value mid :remember "1")))))

           (model-node
             (lambda (c mid)
               (harness/choice
                 :name mid
                 :description
                   (if (equal? mid active-model)
                       (string-append (:id c) " · current")
                       (:id c))
                 :action (select-model c mid))))

           (model-nodes
             (lambda (c)
               (map (lambda (m) (model-node c m))
                    (models-of c)))))

      (harness/choice
        :action (list
          (harness/action 'kv/set :name "Set model"
            :params (dict :key "model" :value "" :remember "1")))
        :choices (apply append (as-list (map model-nodes ordered)))))
