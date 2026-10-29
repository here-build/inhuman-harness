;; Session notebook. Pages are the log. :pending and :active are derived so a
;; round can tell an open page from a pending-only notebook.
;; :program is the closed exam lambda unevalWire emitted, not the author's text.
;; limbo and verdict are host-sealed. A plugin method cannot stamp the exam.
(define (find-page pages id)
  (if (empty? pages)
      #f
      (if (equal? (:id (first pages)) id)
          (first pages)
          (find-page (rest pages) id))))

(define (count-status pages status)
  (if (empty? pages)
      0
      (+ (if (equal? (:status (first pages)) status) 1 0)
         (count-status (rest pages) status))))

(define (find-status pages status)
  (if (empty? pages)
      #f
      (if (equal? (:status (first pages)) status)
          (:id (first pages))
          (find-status (rest pages) status))))

(define (notebook pages program)
  (dict :pages pages
        :active (find-status pages "active")
        :pending (count-status pages "pending")
        :program program))

(define (replace-page pages id next)
  (if (empty? pages)
      '()
      (append (list (if (equal? (:id (first pages)) id) next (first pages)))
              (replace-page (rest pages) id next))))

(define (demote pages)
  (if (empty? pages)
      '()
      (let ((page (first pages)))
        (append (list (if (equal? (:status page) "active")
                          (dict-put page "status" "pending")
                          page))
                (demote (rest pages))))))

(define (text-or value)
  (if (string? value) value ""))

(define (make-page id program subject description active-form activation-brief)
  (dict :id id :status "pending" :program program :subject subject
        :description description :activeForm active-form :activationBrief activation-brief
        :preds '() :reason ""))

(define (retitle state id allowed to)
  (let ((page (find-page (:pages state) id)))
    (if (or (equal? page #f) (not (member (:status page) allowed)))
        state
        (notebook (replace-page (:pages state) id (dict-put page "status" to))
                  (:program state)))))

(define (headline page)
  (if (equal? (:subject page) "")
      (:id page)
      (string-append (:id page) " " (:subject page))))

(define (pending-lines pages)
  (map headline (filter (lambda (page) (equal? (:status page) "pending")) pages)))

(define open-page-note
  "This page is still open. Validate, drop, or keep working — not a new user turn.")

(define (recitation state)
  (let ((active (find-page (:pages state) (:active state)))
        (pending (pending-lines (:pages state))))
    (if (equal? active #f)
        (string-join pending "\n")
        (string-append
          (string-join (append (list (headline active)) pending) "\n")
          "\n\n"
          open-page-note))))

(define (start-page state id)
  (let ((page (find-page (:pages state) id)))
    (if (or (equal? page #f) (not (equal? (:status page) "pending")))
        state
        (notebook (replace-page (demote (:pages state))
                                id
                                (dict-put page "status" "active"))
                  (:program state)))))

(define (drop-page state id reason)
  (let ((page (find-page (:pages state) id)))
    (if (or (equal? page #f)
            (equal? (:status page) "dropped")
            (equal? (:status page) "completed"))
        state
        (notebook (replace-page (:pages state)
                                id
                                (dict-put (dict-put page "status" "dropped")
                                          "reason"
                                          reason))
                  (:program state)))))

(define (after-page state id pred)
  (let ((page (find-page (:pages state) id)))
    (if (or (equal? page #f)
            (equal? id pred)
            (equal? (find-page (:pages state) pred) #f)
            (equal? (:status page) "completed")
            (equal? (:status page) "dropped")
            (member pred (:preds page)))
        state
        (notebook (replace-page (:pages state)
                                id
                                (dict-put page "preds" (append (:preds page) (list pred))))
                  (:program state)))))

(define (apply-action state action)
  (if (equal? (:type action) "create")
      (if (or (equal? (:task-id action) "")
              (not (equal? (find-page (:pages state) (:task-id action)) #f)))
          state
          (notebook (append (:pages state)
                            (list (make-page (:task-id action)
                                             (:program action)
                                             (text-or (:subject action))
                                             (text-or (:description action))
                                             (text-or (:activeForm action))
                                             (text-or (:activationBrief action)))))
                    (:program action)))
      (if (equal? (:type action) "start")
          (start-page state (:task-id action))
          (if (equal? (:type action) "drop")
              (drop-page state (:task-id action) (:reason action))
              (if (equal? (:type action) "after")
                  (after-page state (:task-id action) (:after action))
                  (if (equal? (:type action) "limbo")
                      (retitle state (:task-id action) (list "active") "limbo")
                      ;; The exam may overwrite limbo before it lands, so an
                      ;; active page takes a verdict too.
                      (if (equal? (:type action) "verdict")
                          (retitle state
                                   (:task-id action)
                                   (list "limbo" "active")
                                   (if (:ok action) "completed" "pending"))
                          state)))))))

(define/reducer
  :initial (lambda () (notebook '() ""))
  :reduce (lambda (state action) (apply-action state action))
  :host-only (lambda (action)
               (or (equal? (:type action) "limbo")
                   (equal? (:type action) "verdict"))))

(define/method 'incomplete
  :kind 'query
  :input (s/object)
  :output (s/object (s/field "open" (s/boolean)) (s/field "text" (s/string)))
  :handler (lambda (input state)
             (if (and (equal? (:active state) #f) (equal? (:pending state) 0))
                 (dict :open #f :text "")
                 (dict :open (not (equal? (:active state) #f))
                       :text (recitation state)))))

(define/method 'create
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)) (s/field "program" (s/string)) (s/field "subject" (s/optional (s/string))) (s/field "description" (s/optional (s/string))) (s/field "activeForm" (s/optional (s/string))) (s/field "activationBrief" (s/optional (s/string))))
  :output (s/string)
  :handler (lambda (input state)
             (if (equal? (:task-id input) "")
                 (refuse "task-id must not be empty — pass the id you want the page to have")
                 (if (equal? (:program input) "")
                     (refuse "task__create did not save the exam lambda")
                     (if (not (equal? (find-page (:pages state) (:task-id input)) #f))
                         (refuse "duplicate task — that id already has a page. Pick a new task-id.")
                         (begin
                           (state/propose
                             (dict :type "create"
                                   :task-id (:task-id input)
                                   :program (:program input)
                                   :subject (text-or (:subject input))
                                   :description (text-or (:description input))
                                   :activeForm (text-or (:activeForm input))
                                   :activationBrief (text-or (:activationBrief input))))
                           (:task-id input)))))))

(define/method 'page
  :kind 'query
  :input (s/object (s/field "task-id" (s/string)))
  :output (s/object (s/field "id" (s/string))
                    (s/field "status" (s/string))
                    (s/field "program" (s/string))
                    (s/field "subject" (s/string))
                    (s/field "description" (s/string))
                    (s/field "activeForm" (s/string))
                    (s/field "activationBrief" (s/string))
                    (s/field "preds" (s/array (s/string)))
                    (s/field "reason" (s/string)))
  :handler (lambda (input state)
             (let ((page (find-page (:pages state) (:task-id input))))
               (if (equal? page #f)
                   (refuse "unknown task — take an id from the task list and call again")
                   page))))

(define/method 'start
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (let ((page (find-page (:pages state) (:task-id input))))
               (if (equal? page #f)
                   (refuse "unknown task — take an id from the task list and call start again")
                   (if (and (not (equal? (:status page) "pending"))
                            (not (equal? (:status page) "active")))
                       (refuse "cannot start task — only a pending page can be started. Leave this one and start a pending id.")
                       (begin
                         (when (equal? (:status page) "pending")
                           (state/propose (dict :type "start" :task-id (:task-id input))))
                         "started"))))))

(define/method 'stamp
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)) (s/field "ok" (s/boolean)))
  :output (s/string)
  :handler (lambda (input state)
             (let ((page (find-page (:pages state) (:task-id input))))
               (if (equal? page #f)
                   (refuse "unknown task — take an id from the task list and call stamp again")
                   (if (not (member (:status page) (list "limbo" "active")))
                       (refuse "cannot stamp task — only a limbo or active page takes a verdict. Start it, then validate, then stamp.")
                       (begin
                         (state/propose (dict :type "verdict"
                                              :task-id (:task-id input)
                                              :ok (:ok input)))
                         "stamped"))))))

(define/method 'drop
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)) (s/field "reason" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (let ((page (find-page (:pages state) (:task-id input))))
               (if (equal? page #f)
                   (refuse "unknown task — take an id from the task list and call drop again")
                   (if (equal? (:status page) "completed")
                       (refuse "cannot drop completed task — it is already done. Leave it; there is nothing to drop.")
                       (begin
                         (when (not (equal? (:status page) "dropped"))
                           (state/propose (dict :type "drop"
                                                :task-id (:task-id input)
                                                :reason (:reason input))))
                         "dropped"))))))

(define/method 'after
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)) (s/field "after" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (if (equal? (:task-id input) (:after input))
                 (refuse "cannot after a page on itself — the prerequisite has to be a different task. Pass that task's id as after.")
                 (let ((page (find-page (:pages state) (:task-id input))))
                   (if (or (equal? page #f)
                           (equal? (find-page (:pages state) (:after input)) #f))
                       (refuse "unknown task — both ids have to be pages. Take them from the task list and call after again.")
                       (if (or (equal? (:status page) "completed")
                               (equal? (:status page) "dropped"))
                           (refuse "cannot after task — a completed or dropped page takes no prerequisites. Add the edge to a pending or active page instead.")
                           (begin
                             (state/propose (dict :type "after"
                                                  :task-id (:task-id input)
                                                  :after (:after input)))
                             "after")))))))

;; The stamp. Only the tool calls it, and only after the exam lambda returned the pair.
(define/method 'verdict
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)) (s/field "ok" (s/boolean)) (s/field "comments" (s/optional (s/string))))
  :output (s/string)
  :handler (lambda (input state)
             (let ((page (find-page (:pages state) (:task-id input))))
               (if (equal? page #f)
                   (refuse "unknown task")
                   (begin
                     (state/propose (dict :type "verdict"
                                          :task-id (:task-id input)
                                          :ok (:ok input)
                                          :comments (text-or (:comments input))))
                     "verdict")))))

;; Limbo only. The tool applies the stored lambda and then calls verdict.
(define/method 'validate
  :kind 'command
  :input (s/object (s/field "task-id" (s/string)))
  :output (s/string)
  :handler (lambda (input state)
             (let ((page (find-page (:pages state) (:task-id input))))
               (if (equal? page #f)
                   (refuse "unknown task — take an id from the task list and call validate again")
                   (if (not (equal? (:status page) "active"))
                       (refuse "cannot validate task — only the active page validates. Call start on it first, then validate.")
                       (begin
                         (state/propose (dict :type "limbo" :task-id (:task-id input)))
                         "limbo"))))))
