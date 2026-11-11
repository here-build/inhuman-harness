;; Model ABI. Interior methods live in session.scm; this file only calls them.
;; Loaded when the plugin is enabled, without a bot pin.
(define (text-or value)
  (if (string? value) value ""))

;; A Refusal crosses as a dict whose %plugin-surface key is "refusal".
(define (refusal? value)
  (and (dict? value)
       (equal? (:%plugin-surface value) "refusal")))

(define/tool 'task__create
  :description "Create a pending task with a saved Scheme validation program. Choose a unique taskId; the tool returns that ID. Creation captures the program without running its checks. When the work is ready, call task__start and then task__validate with that ID. The saved program cannot be replaced; drop the task and create a new ID if its checks need correction."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "create **{{subject}}**?{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}"
  :effect "created **{{subject}}**{{#description}}\n{{description}}{{/description}}{{#activeForm}}\nform **{{activeForm}}**{{/activeForm}}{{#activationBrief}}\nbrief **{{activationBrief}}**{{/activationBrief}}{{#validationProgram}}\nprogram `{{validationProgram}}`{{/validationProgram}}"
  :input (s/object
    (s/field "subject" (s/string) "Short task title.")
    (s/field "description" (s/string) "Task requirements and scope; the validation program must check these requirements.")
    (s/field "activeForm" (s/optional (s/string)) "Progress label displayed while this task is active.")
    (s/field "activationBrief" (s/optional (s/string)) "Instructions to follow when this task becomes active.")
    (s/field "validationProgram" (s/string) "Scheme source text, saved now and evaluated later by task__validate in a fresh scope. Use Scheme calls such as (read_file \"path\") for file text, (equal? actual expected) for comparison, and (tasks/write-completion-verdict ok \"evidence\") for the final verdict. Available project ports: read_file, list_dir, grep, glob, fff_search, shell. Paths resolve from the project root. Adapt this example to the task's actual requirements: (tasks/write-completion-verdict (equal? (read_file \"status.txt\") \"ready\") \"status.txt must contain exactly ready\"). The outer argument is a JSON string; its contents use Scheme syntax. Returning #t alone does not record a verdict.")
    (s/field "taskId" (s/string) "A nonempty unique ID you choose, such as remove-picker. Reuse this ID with task__start, task__validate, task__after, and task__drop."))
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
  :description "Make a pending task active before working on it or calling task__validate. Returns its subject and activationBrief. Only one task is active at a time; starting another returns the previous task to pending. Starting the active task changes nothing."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "start `{{taskId}}`?"
  :effect "started `{{taskId}}`"
  :input (s/object (s/field "taskId" (s/string) "ID of an existing pending or active task."))
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
  :description "Abandon an unfinished task and save the reason. Use this when its scope or saved Scheme validation program needs replacement, then task__create with a new ID. Completed tasks cannot be dropped; dropping an already-dropped task changes nothing. Returns false as an acknowledgement on success."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "drop `{{taskId}}`?{{#reason}}\n{{reason}}{{/reason}}"
  :effect "dropped `{{taskId}}`{{#reason}}\n{{reason}}{{/reason}}"
  :input (s/object (s/field "taskId" (s/string) "ID of the unfinished task to drop.") (s/field "reason" (s/string) "Why this task is being abandoned or replaced; saved with the task."))
  :handler (lambda (input)
             (let ((dropped (call/method 'tasks 'drop :task-id (:taskId input) :reason (:reason input))))
               (if (refusal? dropped) dropped #f))))

(define/tool 'task__after
  :description "Record that taskId depends on the task named by after. Both tasks must already exist. This records the prerequisite for planning; it does not start tasks or block task__start. Returns false as an acknowledgement on success."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "after `{{taskId}}` `{{after}}`?"
  :effect "after `{{taskId}}` `{{after}}`"
  :input (s/object (s/field "taskId" (s/string) "ID of the dependent task.") (s/field "after" (s/string) "ID of its prerequisite task."))
  :handler (lambda (input)
             (let ((edged (call/method 'tasks 'after :task-id (:taskId input) :after (:after input))))
               (if (refusal? edged) edged #f))))

(define/tool 'task__validate
  :description "Run the active task's saved Scheme validation program against current project state. Call task__start first. The program must finish with (tasks/write-completion-verdict ok comments); the tool returns that boolean/string pair. A true verdict completes the task; a false verdict returns it to pending so you can fix the work, start it, and validate again. To correct the saved program itself, drop the task and create a new ID."
  :expose 'tool
  :class 'meta
  :representation 'both
  :triggers-react-loop #f
  :is-side-channel #t
  :question "validate `{{taskId}}`?"
  :effect "validated `{{taskId}}`"
  :input (s/object (s/field "taskId" (s/string) "ID of the active task whose saved Scheme program should run."))
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
