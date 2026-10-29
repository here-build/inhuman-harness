;; skill-to-program.scm
;;
;; Markdown-style AI skill bundle -> executable Arrival program bundle.
;;
;; Compiler values stay structured across every stage:
;;
;;   files -> semantic IR -> lowering IR -> generated bundle -> audits -> repair
;;
;; No stage serializes the IR into prose for the next stage.

(define MAX-REPAIRS 2)

(define (audit-one lens analysis lowering bundle)
  ((require "audit.prompt")
  :lens lens
  :analysis analysis
  :lowering lowering
  :bundle bundle))

(define (seq->list xs)
  (if (vector? xs)
      (let loop ((i 0) (acc '()))
        (if (>= i (vector-length xs))
            (reverse acc)
            (loop (+ i 1) (cons (vector-ref xs i) acc))))
      xs))

(define (audit-all analysis lowering bundle)
  (map
    (lambda (lens) (audit-one lens analysis lowering bundle))
    (seq->list (require "audit-lenses.yaml"))))

(define (all-passed? audits)
  (every (lambda (row) (:passed row)) (seq->list audits)))

(define (compile-skill files)
  (let* (
          (analysis ((require "analyze.prompt") :files files))
          (lowering ((require "lower.prompt") :analysis analysis)))
    (let loop ((bundle ((require "emit.prompt") :files files :analysis analysis :lowering lowering)) (iteration 0))
      (let ((audits (audit-all analysis lowering bundle)))
        (if (or (all-passed? audits) (>= iteration MAX-REPAIRS))
          (dict
            :passed (all-passed? audits)
            :repairs iteration
            :analysis analysis
            :lowering lowering
            :bundle bundle
            :audits audits)
          (loop
            ((require "repair.prompt") :analysis analysis :lowering lowering :bundle bundle :audits audits)
            (+ iteration 1)))))))

(define (compile-skill-md path)
  (compile-skill [(dict :path path :content (read_file path))]))

(define (compile-skill-markdown markdown)
  (compile-skill [(dict :path "SKILL.md" :content markdown)]))
