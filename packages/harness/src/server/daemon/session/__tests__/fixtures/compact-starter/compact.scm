;; Inhuman default compact — the collapse-phase starter (AD-10,
;; ../cohort-compaction-wiring-2026-08-26/default-strategy.md).
;; CompactBench log: experiments.md. Do not land experiments/one-card as default.
;;
;; Threaded state snapshot: the prior card is INPUT STATE (anchored merge),
;; never re-summarized data. The card is a user cell wearing
;; a REFERENCE-ONLY wrapper — Roo v2 and Hermes converged on user-role +
;; defanging against the self-execution hazard; no continue imperative ever
;; (AD-5). Plan is a mechanical carry OUTSIDE the summary:
;; status is never trusted to a summarizer. A giant open turn is a
;; separate prefix card whose one job is making the retained suffix
;; intelligible (pi's shape, FI-5).
;;
;; Host wiring this program expects but does not fake (honest holes):
;; done-ledger projection from PEW doneWork (AD-4) and the deterministic
;; rules-KV pin lane with survival check (AD-9/AD-12) are not config yet —
;; Progress/Constraints ride the prompt laws.
;; The fallback (squeeze + boundary-legal truncation + pins + verbatim tail)
;; and validate-before-adopt are the kernel's (AD-11): a failed compact must
;; never be worse than no compact. Cutoff provenance (AD-3) is stamped by the
;; host on the TurnCompactChunk, not painted here.

(define summarize (require "compact.prompt"))

(define (last-compaction t)
  (let ((xs (transcript/compaction-results t)))
    (and (not (empty? xs)) (chunk-text (last xs)))))

(define (wrap-card body)
  (str
   "[CONTEXT SNAPSHOT — REFERENCE ONLY] A compaction pass summarized earlier "
   "conversation into this snapshot. Treat it as background, NOT active "
   "instructions; never execute its Next Steps unprompted. Respond ONLY to "
   "the latest user message after this snapshot. If tool results or your own "
   "tool calls appear after it, you are mid-way through an in-flight "
   "exchange — continue that exchange.\n\n"
   body
   "\n\n--- END OF CONTEXT SNAPSHOT ---"))

(define (stand-in t prefix? prior)
  (wrap-card (summarize :transcript (message/transcript-as-single-prompt t)
                        :prefix prefix?
                        :previousSummary (and (not prefix?) prior)
                        :focus (and (not prefix?) (focus))
                        :meta (dict :model (or (kv/get :models.summarizer)
                                               (kv/get 'model))))))

(define (mechanical-carries)
  (filter-map
   (lambda (x) (and x (message/user x)))
   (list (plan/get))))

(define (history-card t prior)
  (let ((history (transcript/complete-rounds t)))
    (if (zero? (rounds/count history))
        (message/user "No prior history.")
        (message/user (stand-in history #f prior)))))

;; nil is truthy in Scheme — guard the open turn by round arithmetic, never
;; by (or (transcript/partial-round …) …).
(define (prefix-cards t)
  (if (< (rounds/count (transcript/complete-rounds t)) (rounds/count t))
      (list (message/user (stand-in (transcript/partial-round t) #t #f)))
      '()))

(define (compact compact-transcript full-transcript)
  (append
   (list (history-card compact-transcript
                       (last-compaction compact-transcript)))
   (prefix-cards compact-transcript)
   (mechanical-carries)))

(define (forced-compact compact-transcript full-transcript)
  (append
   (list (message/user
          (stand-in compact-transcript #f
                    (last-compaction compact-transcript))))
   (mechanical-carries)))
