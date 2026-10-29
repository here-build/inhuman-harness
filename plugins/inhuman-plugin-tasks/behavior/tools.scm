;; Model ABI. Interior methods live in session.scm; this file only calls them.
;; Loaded when the plugin is enabled, without a bot pin.
(define (text-or value)
  (if (string? value) value ""))

;; A Refusal crosses as a dict whose %plugin-surface key is "refusal".
(define (refusal? value)
  (and (dict? value)
       (equal? (:%plugin-surface value) "refusal")))

(define/tool 'task__create
  :description "Create a task with pending status and return its taskId. The harness manages status; completion requires task__validate, not a completed argument. The validationProgram is saved at creation and cannot be replaced. It must inspect current project state through files, tests, or a :readonly agent/ask using the task requirements, then call (tasks/write-completion-verdict ok comments). Returning #t or (list #t \"…\") is not a stamp. ;; use one-shot for schema-constrained responses"
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "create **{{subject}}**?{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}"
  :effect "created **{{subject}}**{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}"
  :input (s/object (s/field "subject" (s/string)) (s/field "description" (s/string)) (s/field "activeForm" (s/optional (s/string))) (s/field "activationBrief" (s/optional (s/string))) (s/field "validationProgram" (s/string)) (s/field "taskId" (s/string)))
  :handler (lambda (input)
             (let ((source (exam/capture (:validationProgram input))))
               (call/method 'tasks 'create
               :task-id (:taskId input)
               :program source
               :subject (:subject input)
               :description (:description input)
               :activeForm (text-or (:activeForm input))
               :activationBrief (text-or (:activationBrief input))))))

(define/tool 'task__start
  :description "Start a task and return its subject and activationBrief. Only one task can be active; any previously active task returns to pending. Starting an already-active task changes nothing."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "start `{{taskId}}`?"
  :effect "started `{{taskId}}`"
  :input (s/object (s/field "taskId" (s/string)))
  :handler (lambda (input)
             (let ((started (call/method 'tasks 'start :task-id (:taskId input))))
               (if (refusal? started)
                   started
                   (let ((page (call/method 'tasks 'page :task-id (:taskId input))))
                     (if (refusal? page)
                         page
                         (dict :subject (text-or (:subject page))
                               :activationBrief (text-or (:activationBrief page)))))))))

(define/tool 'task__drop
  :description "Drop a task and save the reason. Completed tasks cannot be dropped. Dropping an already-dropped task changes nothing. Returns no value."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "drop `{{taskId}}`?{{#reason}}\n{{reason}}{{/reason}}"
  :effect "dropped `{{taskId}}`{{#reason}}\n{{reason}}{{/reason}}"
  :input (s/object (s/field "taskId" (s/string)) (s/field "reason" (s/string)))
  :handler (lambda (input)
             (let ((dropped (call/method 'tasks 'drop :task-id (:taskId input) :reason (:reason input))))
               (if (refusal? dropped) dropped #f))))

(define/tool 'task__after
  :description "Add a prerequisite: taskId waits until after is completed. Does not start either task. Returns no value."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "after `{{taskId}}` `{{after}}`?"
  :effect "after `{{taskId}}` `{{after}}`"
  :input (s/object (s/field "taskId" (s/string)) (s/field "after" (s/string)))
  :handler (lambda (input)
             (let ((edged (call/method 'tasks 'after :task-id (:taskId input) :after (:after input))))
               (if (refusal? edged) edged #f))))

(define/tool 'task__validate
  :description "Validate the active task using the validationProgram saved at creation; no replacement program is accepted. That program must call (tasks/write-completion-verdict ok comments) after checking current project state. The tool returns that pair."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "validate `{{taskId}}`?"
  :effect "validated `{{taskId}}`"
  :input (s/object (s/field "taskId" (s/string)))
  :handler (lambda (input)
             (let ((page (call/method 'tasks 'page :task-id (:taskId input))))
               (if (refusal? page)
                   page
                   (if (not (equal? (:status page) "active"))
                       (refuse "cannot validate task — only the active page validates. Call start on it first, then validate.")
                       (let ((pair (exam/apply (:program page))))
                         (let ((limbo (call/method 'tasks 'validate :task-id (:taskId input))))
                           (if (refusal? limbo)
                               limbo
                               (begin
                                 (call/method 'tasks 'verdict
                                   :task-id (:taskId input)
                                   :ok (first pair)
                                   :comments (text-or (second pair)))
                                 pair)))))))))
