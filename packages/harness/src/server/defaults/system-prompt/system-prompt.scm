;; Mint-time assembly. Not a slash verb, not an action the user invokes.
;; Last value is the system string. (harness/kv/set) in this run is residual
;; for the minted prompt Work — not session KV.
;;
;; require: .md as string; .hbs as a lambda. Host roots those as env capabilities.

(define system-prompt (require "./SYSTEM.md"))
(define preamble (require "./preamble.hbs"))
(define tools-template (require "./tools.hbs"))
(define tools (harness/kernel/tools))

(harness/kv/set 'declared-tools tools)

(string-append system-prompt (preamble (dict)) (tools-template tools))
