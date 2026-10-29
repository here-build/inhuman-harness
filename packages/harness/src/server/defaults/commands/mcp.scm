;; /mcp — ConnectionSpec rows whose driver abilityClaim includes "mcp", plus a never-hidden add door.
;; Faces from spec.issue / live.auth / live.tools. Session disable is kv, not config.json.
;; Add is mcp-server/adopt; remainder fills :input. Authenticate is connect/login.
;; Primitive: no require.

(define (as-list x)
  (cond ((vector? x) (vector->list x))
        ((list? x) x)
        (else (list))))

(define (as-dict x)
  (if (or (not x) (null? x)) (dict) x))

(define (text x)
  (if (string? x) x ""))

(define (driver-can d)
  (if d (as-list (:abilityClaim d)) (list)))

(define (live-of c)
  (as-dict (:live c)))

(define (mcp-connection? c)
  (member "mcp" (driver-can (:driver c))))

(define (tool-count live)
  (let ((tools (:tools live)))
    (if (or (not tools) (null? tools))
        0
        (length (as-list tools)))))

(define (session-disabled-key c)
  (string-append "mcp-disabled:" (:id c)))

(define (session-disabled? c)
  (not (equal? (harness/session/get-current (session-disabled-key c)) "")))

(define (kernel-disabled? c)
  (eq? (:enabled (as-dict (:configuration c))) #f))

(define (needs-auth? c)
  (equal? (text (:auth (live-of c))) "needs-auth"))

(define (connection-health c)
  (cond ((equal? (:issue c) "failed") 'failed)
        ((needs-auth? c) 'degraded)
        ((and (equal? (text (:readyState c)) "ready")
              (= (tool-count (live-of c)) 0))
         'degraded)
        (else 'ok)))

(define (connection-title c)
  (let ((name (:name c)))
    (cond ((or (not name) (equal? name "")) (:id c))
          (else name))))

(define (tools-caption n)
  (if (= n 1)
      "1 tool"
      (string-append (number->string n) " tools")))

(define (connection-description c)
  (let ((err (text (:error c)))
        (n (tool-count (live-of c))))
    (cond ((and (equal? (:issue c) "failed") (not (equal? err ""))) err)
          ((needs-auth? c) "needs auth")
          ((session-disabled? c) "disabled (this session)")
          ((kernel-disabled? c) "disabled")
          ((and (equal? (text (:readyState c)) "ready") (= n 0)) "ready · 0 tools")
          (else ""))))

(define (connection-annotation c)
  (let ((n (tool-count (live-of c))))
    (if (or (= n 0)
            (equal? (:issue c) "failed")
            (needs-auth? c)
            (session-disabled? c)
            (kernel-disabled? c))
        ""
        (tools-caption n))))

(define (disable-action c)
  (if (session-disabled? c)
      (harness/action 'kv/clear
        :name "Enable this session"
        :params (dict :key (session-disabled-key c)))
      (harness/action 'kv/set
        :name "Disable this session"
        :params (dict :key (session-disabled-key c) :value "1"))))

(define (row-alts c)
  (append
    (list (disable-action c))
    (if (needs-auth? c)
        (list
          (harness/action 'connect/login
            :name "Authenticate"
            :params (dict :id (:id c)))
          (harness/action 'connect/logout
            :name "Clear auth"
            :params (dict :id (:id c))))
        (list))
    (list
      (harness/action 'connect/drop
        :name "Remove connection"
        :hotkey "control-x"
        :params (dict :id (:id c))))))

(define (connection-node c)
  (harness/choice
    :name (connection-title c)
    :annotation (connection-annotation c)
    :description (connection-description c)
    :health-status (connection-health c)
    :health-annotation (text (:error c))
    :alternate-actions (row-alts c)))

(define add-row
  (harness/choice
    :name "Add MCP"
    :description "Paste an https:// URL or a stdio command"
    :action (list
      (harness/action 'mcp-server/adopt :name "Add MCP"))))

(define add-remainder
  (harness/action 'mcp-server/adopt
    :name "Add MCP"
    :params (dict :input "")))

(define add-chord
  (harness/action 'mcp-server/adopt
    :name "Add MCP"
    :hotkey "control-n"
    :params (dict :input "")))

(let* ((connections
         (filter mcp-connection?
                 (as-list (harness/kernel/connections))))
       (rows (as-list (map connection-node connections))))
  (harness/choice
    :action (list add-remainder)
    :alternate-actions (list add-chord)
    :choices (append rows (list add-row))))
