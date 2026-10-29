;; evaluate.scm
;;
;; Optional corpus evaluator. It consumes the structured compiler result directly.

(require "skill-to-program.scm")
(define evaluate-conversion (require "evaluate.prompt"))

(define (evaluate-case case)
  (evaluate-conversion
    (dict
      :caseName (:name case)
      :expectedFeatures (:expected case)
      :compiled (compile-skill (:files case)))))

(define (evaluate-cases cases)
  ;; Keep outer corpus execution sequential; each compile already contains fan-out.
  (let loop ((rest cases) (results '()))
    (if (null? rest)
        (reverse results)
        (loop
          (cdr rest)
          (cons
            (evaluate-case (car rest))
            results)))))
