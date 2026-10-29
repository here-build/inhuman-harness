;; compact — the dist default compaction strategy. This file is what
;; config.json's `"compact": "@inhuman.tools/harness/compact.scm"` points at;
;; repoint the path (or copy this file and its compact.prompt) to own the compact.
;;
;; A threaded state snapshot, the strategy CompactBench favours: the
;; model folds the compacted prefix into one card that keeps the user's goals
;; and requests, decisions, files touched, open tasks, errors and their
;; resolutions, and key tool findings. The prior card is INPUT STATE (anchored
;; merge), never re-summarized data. The summarizer sees the full, untrimmed
;; prefix. The card is a user cell wearing a REFERENCE-ONLY wrapper, so the
;; model reads it as background and never as an instruction to carry out.
;;
;; The plan is carried mechanically OUTSIDE the summary: status is never
;; trusted to a summarizer. A giant open turn is a separate prefix card whose
;; one job is making the retained suffix intelligible.
;;
;; This is not the keep-first stub. Keep-first (one cell, the rest dropped)
;; exists only as the kernel's failsafe for when this program is missing or
;; lost; the kernel logs a diagnostic when it runs.

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

;; Summarizer model: models.summarizer, else the session model. With neither set
;; the meta stays empty and the host's completion model applies; a missing kv
;; reads as #f, which must never reach the prompt as :model.
(define (summarizer-meta)
  (let ((m (or (kv/get :models.summarizer) (kv/get 'model))))
    (if m (dict :model m) (dict))))

;; The prior card rides in as :previousSummary, so the transcript blob leaves
;; it out (transcript/payload) instead of showing it twice.
(define (stand-in t prefix? prior)
  (wrap-card (summarize :transcript (message/transcript-as-single-prompt (transcript/payload t))
                        :prefix prefix?
                        :previousSummary (and (not prefix?) prior)
                        :focus (and (not prefix?) (focus))
                        :meta (summarizer-meta))))

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

;; /compact: one card over the whole prefix, folding the prior card forward.
(define (forced-compact compact-transcript full-transcript)
  (append
   (list (message/user
          (stand-in compact-transcript #f
                    (last-compaction compact-transcript))))
   (mechanical-carries)))
