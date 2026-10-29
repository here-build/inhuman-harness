;; compact — well-known kernel command. Obligatory.
;; Auto-compact thresholds live in config.json `compactTriggers`.
;; Continuation pause lives in config.json `pauseForCompaction`.

(harness/choice
  :action
    (list
      (harness/action 'compact :params (dict :focus ""))))
