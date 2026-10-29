;; /connect — existing wires (select / remove) plus advertised new connections.
;; Select is kv/set connection, then kv/set model, both with remember so
;; the choice is also the default: the wire's last-used model when one is
;; cached, else the highest-version live id (first id at that version;
;; first id outright when none carry a version). A bare kv/set does not.
;; Adopted offers are omitted. Unused add-by-default drivers adopt from the driver row.
;; Adopt writes catalog. Primitive: no require.

(define (as-list x)
  (cond ((vector? x) (vector->list x))
        ((list? x) x)
        (else (list))))

(define (driver-can d)
  (if d (as-list (:abilityClaim d)) (list)))

(define (text x)
  (if (string? x) x ""))

(define (as-dict x)
  (if (or (not x) (null? x)) (dict) x))

(define (live-of c)
  (as-dict (:live c)))

(define (models-of c)
  (as-list (:models (live-of c))))

;; Model id → dotted numeric run ("gpt-4.1" → "4.1", "o3-mini" → "3", "ghost" → "").
(define (digit? c)
  (and (char>=? c #\0) (char<=? c #\9)))

(define (skip-digits s i)
  (cond ((>= i (string-length s)) i)
        ((digit? (string-ref s i)) (skip-digits s (+ i 1)))
        (else i)))

(define (extract-version s)
  (let loop ((i 0))
    (cond ((>= i (string-length s)) "")
          ((digit? (string-ref s i))
           (let ((end (let loop ((j i))
                        (let ((k (skip-digits s j)))
                          ;; A trailing dot only counts when another digit follows, so "4.1." stops at "4.1".
                          (if (and (< (+ k 1) (string-length s))
                                   (char=? (string-ref s k) #\.)
                                   (digit? (string-ref s (+ k 1))))
                              (loop (+ k 1))
                              k)))))
             (substring s i end)))
          (else (loop (+ i 1))))))

(define (version-components v)
  (let loop ((rest v) (acc '()) (cur '()))
    (cond ((equal? rest "")
           (if (null? cur) (reverse acc) (reverse (cons (list->string (reverse cur)) acc))))
          ((char=? (string-ref rest 0) #\.)
           (if (null? cur)
               (loop (substring rest 1) acc cur)
               (loop (substring rest 1) (cons (list->string (reverse cur)) acc) '())))
          (else
           (loop (substring rest 1) acc (cons (string-ref rest 0) cur))))))

(define (version-numbers v)
  (map string->number (version-components v)))

;; Component-wise: 5 > 4.1, 4.1 > 4, equal is not greater. "" is the floor.
(define (version>? a b)
  (cond ((and (null? a) (null? b)) #f)
        ((null? a) #f)
        ((null? b) #t)
        ((> (car a) (car b)) #t)
        ((< (car a) (car b)) #f)
        (else (version>? (cdr a) (cdr b)))))

;; Latest version wins; ties keep the earlier id, so the first id at the top
;; version is picked. No versions anywhere falls back to the first id.
(define (best-model models)
  (if (null? models)
      ""
      (let loop ((rest (cdr models))
                 (best (car models))
                 (best-ver (version-numbers (extract-version (car models)))))
        (if (null? rest)
            best
            (let ((v (version-numbers (extract-version (car rest)))))
              (if (version>? v best-ver)
                  (loop (cdr rest) (car rest) v)
                  (loop (cdr rest) best best-ver)))))))

(define (plan-key raw)
  (let ((s (string-downcase (text raw))))
    (let loop ((i 0) (acc "") (pending-us #f))
      (if (>= i (string-length s))
          acc
          (let ((c (string-ref s i)))
            (cond ((or (char=? c #\space) (char=? c #\-))
                   (loop (+ i 1) acc #t))
                  (pending-us
                   (loop (+ i 1) (string-append acc "_" (string c)) #f))
                  (else
                   (loop (+ i 1) (string-append acc (string c)) #f))))))))

(define chatgpt-plans
  (list (cons "free" "ChatGPT Free")
        (cons "plus" "ChatGPT Plus")
        (cons "pro" "ChatGPT Pro")
        (cons "go" "ChatGPT Go")
        (cons "team" "ChatGPT Team")
        (cons "business" "ChatGPT Business")
        (cons "enterprise" "ChatGPT Enterprise")))

(define grok-plans
  (list (cons "super_grok" "SuperGrok")
        (cons "supergrok" "SuperGrok")
        (cons "super_grok_heavy" "SuperGrok Heavy")
        (cons "supergrok_heavy" "SuperGrok Heavy")
        (cons "grok_heavy" "SuperGrok Heavy")
        (cons "heavy" "SuperGrok Heavy")
        (cons "super_grok_pro" "SuperGrok Pro")
        (cons "supergrokpro" "SuperGrok Pro")
        (cons "grok_pro" "SuperGrok Pro")
        (cons "grokpro" "SuperGrok Pro")
        (cons "super_grok_plus" "SuperGrok Plus")
        (cons "supergrokplus" "SuperGrok Plus")
        (cons "super_grok_lite" "SuperGrok Lite")
        (cons "supergroklite" "SuperGrok Lite")
        (cons "premium" "SuperGrok")
        (cons "premium_plus" "SuperGrok")
        (cons "premiumplus" "SuperGrok")
        (cons "x_premium_plus" "X Premium Plus")
        (cons "xpremiumplus" "X Premium Plus")
        (cons "x_premium" "X Premium")
        (cons "xpremium" "X Premium")
        (cons "x_basic" "X Basic")
        (cons "xbasic" "X Basic")
        (cons "free" "Free")))

(define (plan-beside-product product plan)
  (if (equal? plan "")
      ""
      (let* ((prefix (string-append product " "))
             (n (string-length prefix)))
        (cond ((equal? plan product) plan)
              ((and (>= (string-length plan) n)
                    (equal? (substring plan 0 n) prefix))
               (substring plan n (string-length plan)))
              (else plan)))))

(define (plan-caption product identity)
  (let* ((raw (text (:plan identity)))
         (key (plan-key raw))
         (hit (and (not (equal? key ""))
                   (assoc key
                          (if (equal? product "Grok") grok-plans chatgpt-plans))))
         (short (if (equal? key "")
                    ""
                    (or (and hit (cdr hit)) (text raw))))
         (core (plan-beside-product product short))
         (label (cond ((not (equal? core "")) core)
                      ((not (equal? short "")) short)
                      ((not (equal? product "")) product)
                      (else ""))))
    (cond ((equal? label "") "")
          ((let* ((hay (string-downcase label))
                  (needle "subscription")
                  (hlen (string-length hay))
                  (nlen (string-length needle)))
             (let loop ((i 0))
               (cond ((= nlen 0) #t)
                     ((> nlen hlen) #f)
                     ((> i (- hlen nlen)) #f)
                     ((equal? (substring hay i (+ i nlen)) needle) #t)
                     (else (loop (+ i 1))))))
           label)
          (else (string-append label " subscription")))))

(define (fixed-2 n)
  (let* ((scaled (inexact->exact (round (* n 100))))
         (neg (< scaled 0))
         (s (if neg (- scaled) scaled))
         (whole (quotient s 100))
         (frac (modulo s 100))
         (fracs (if (< frac 10)
                    (string-append "0" (number->string frac))
                    (number->string frac))))
    (string-append (if neg "-" "") (number->string whole) "." fracs)))

(define (paint-major raw mark)
  (let ((n (string->number (text raw))))
    (if (not n)
        (text raw)
        (let ((scaled (inexact->exact (round (* (abs n) 100)))))
          (cond ((and (> n 0) (= scaled 0)) (string-append "<" mark "0.01"))
                ((< n 0) (string-append "-" mark (fixed-2 (abs n))))
                (else (string-append mark (fixed-2 n))))))))

(define (paint-balance view)
  (if (not view)
      ""
      (let* ((currency (as-dict (:currency view)))
             (mark (text (:symbol currency)))
             (code (text (:code currency)))
             (body (paint-major (text (:balance view)) mark)))
        (if (equal? mark "")
            (if (equal? code "") body (string-append body " " code))
            body))))

(define (join-dots xs)
  (if (null? xs)
      ""
      (let loop ((rest (cdr xs)) (out (car xs)))
        (if (null? rest)
            out
            (loop (cdr rest) (string-append out " · " (car rest)))))))

(define (nonempty-bits xs)
  (let loop ((rest xs) (acc '()))
    (cond ((null? rest) (reverse acc))
          ((equal? (car rest) "") (loop (cdr rest) acc))
          (else (loop (cdr rest) (cons (car rest) acc))))))

(define (remaining-percent remaining)
  (let ((n (if (number? remaining) remaining (string->number (text remaining)))))
    (if (not n)
        ""
        (string-append
          (number->string (inexact->exact (round (max 0 (min 100 n)))))
          "%"))))

(define (count-word n unit)
  (string-append (number->string n) " " unit (if (= n 1) "" "s")))

(define (hours-phrase h)
  (if (>= h 24)
      (count-word (quotient h 24) "day")
      (count-word h "hour")))

(define (paint-reset sec)
  (let ((n (if (number? sec) sec (string->number (text sec)))))
    (if (not n)
        ""
        (let* ((s (max 0 (inexact->exact (round n))))
               (mins (if (= s 0) 0 (max 1 (quotient (+ s 30) 60)))))
          (cond ((= mins 0) "")
                ((< mins 60) (count-word mins "minute"))
                ((< mins 1440)
                 (let ((h (quotient mins 60))
                       (m (modulo mins 60)))
                   (cond ((or (= m 0) (= m 1)) (hours-phrase h))
                         ((= m 59) (hours-phrase (+ h 1)))
                         (else (string-append (count-word h "hour")
                                              " and "
                                              (count-word m "minute"))))))
                (else
                 (let ((d (quotient mins 1440))
                       (h (quotient (modulo mins 1440) 60)))
                   (if (= h 0)
                       (count-word d "day")
                       (string-append (count-word d "day")
                                      " and "
                                      (count-word h "hour"))))))))))

(define (paint-window w)
  (let ((left (remaining-percent (:remainingPercent w)))
        (until (paint-reset (:resetInSec w))))
    (if (equal? left "")
        ""
        (if (equal? until "")
            left
            (string-append left " left for " until)))))

(define (paint-windows detail)
  (join-dots
    (nonempty-bits
      (map (lambda (row) (paint-window (as-dict row)))
           (as-list (:windows (as-dict detail)))))))

(define (paint-account-annotation account)
  (join-dots
    (nonempty-bits
      (list
        (paint-balance (:balance account))
        (paint-windows (:balanceDetail account))))))

(define (oidc-who live)
  (let ((id (as-dict (:identity live))))
    (let ((who (text (:displayName id))))
      (if (equal? who "") (text (:email id)) who))))

(define (identity-present? live)
  (let ((id (as-dict (:identity live))))
    (or (not (equal? (text (:displayName id)) ""))
        (not (equal? (text (:email id)) ""))
        (not (equal? (text (:plan id)) "")))))

(define (connection-url c)
  (let ((cfg (:configuration c)))
    (if cfg (text (:baseUrl cfg)) "")))

(define (connection-title c)
  (let ((live (text (:catalogName (live-of c))))
        (name (:name c)))
    (cond ((not (equal? live "")) live)
          ((or (not name) (equal? name "")) (:id c))
          (else name))))

(define (needs-auth? c)
  (equal? (text (:auth (live-of c))) "needs-auth"))

;; 401 or 403 as a status. A digit on either side is a longer number, not a status.
(define (auth-status-at? s i code)
  (let ((n (string-length code))
        (len (string-length s)))
    (and (<= (+ i n) len)
         (equal? (substring s i (+ i n)) code)
         (or (<= i 0) (not (digit? (string-ref s (- i 1)))))
         (or (>= (+ i n) len) (not (digit? (string-ref s (+ i n))))))))

(define (auth-line? s)
  (let ((len (string-length s)))
    (let scan ((i 0))
      (cond ((>= i len) #f)
            ((or (auth-status-at? s i "401") (auth-status-at? s i "403")) #t)
            (else (scan (+ i 1)))))))

(define (connection-health c)
  (cond ((equal? (:issue c) "failed") 'failed)
        ((needs-auth? c) 'degraded)
        (else 'ok)))

(define (connection-error c)
  (text (:error c)))

(define (connection-description c)
  (let* ((err (connection-error c))
         (live (live-of c))
         (failed (and (equal? (:issue c) "failed") (not (equal? err "")))))
    (cond ((and failed (auth-line? err)) "The key was refused. Reconnect.")
          (failed err)
          ((needs-auth? c) "needs auth — reconnect")
          ((not (equal? (oidc-who live) "")) (oidc-who live))
          ((not (equal? (text (:keyMask live)) "")) (text (:keyMask live)))
          ((identity-present? live)
           (plan-caption (connection-title c) (as-dict (:identity live))))
          (else ""))))

(define (connection-annotation c)
  (if (or (equal? (:issue c) "failed") (needs-auth? c))
      ""
      (let ((account (:account (live-of c))))
        (if account (paint-account-annotation account) ""))))

(define (select-connection c)
  (let* ((last (harness/session/last-used-model (:id c)))
         (pick (if (equal? last "") (best-model (models-of c)) last)))
    (append
      (list
        (harness/action 'kv/set :params (dict :key "connection" :value (:id c) :remember "1")))
      (if (equal? pick "")
          (list)
          (list
            (harness/action 'kv/set :params (dict :key "model" :value pick :remember "1")))))))

(define (connection-node c)
  (harness/choice
    :name (connection-title c)
    :annotation (connection-annotation c)
    :description (connection-description c)
    :health-status (connection-health c)
    :health-annotation (connection-error c)
    :action (select-connection c)
    :alternate-actions
      (list
        (harness/action 'connect/drop
          :name "Remove connection"
          :hotkey "control-x"
          :params (dict :id (:id c))))))

(define (offer-adoptable? o)
  (let ((flag (:adoptable o)))
    (or (eq? flag #t) (equal? flag #t) (equal? flag "true"))))

(define (offer-url o)
  (let ((s (:settings o)))
    (if s (text (:baseUrl s)) "")))

(define (same-driver? c d)
  (equal? (:name (:driver c)) (:name d)))

(define (offer-matches-connection? o c)
  (let ((oname (or (:name o) ""))
        (ourl (offer-url o)))
    (if (equal? ourl "")
        #f
        (or (and (not (equal? oname ""))
                 (equal? oname (:name c)))
            (equal? ourl (connection-url c))))))

(define (offer-adopted? d o wires)
  (not (null?
        (filter (lambda (c)
                  (and (same-driver? c d)
                       (offer-matches-connection? o c)))
                wires))))

(define (offer-node d o)
  (if (offer-adoptable? o)
      (harness/choice
        :name (or (:name o) "")
        :description (or (:description o) "")
        :action (list
          (harness/action 'connect/adopt
            :params (dict
              :driver (:name d)
              :name (or (:name o) "")
              :settings (or (:settings o) (dict))))))
      (harness/choice
        :name (or (:name o) "")
        :description (or (:description o) ""))))

(define (driver-offers d)
  (as-list (harness/kernel/offers d)))

(define (visible-offers d wires)
  (filter (lambda (o) (not (offer-adopted? d o wires)))
          (driver-offers d)))

(define (unused-driver-node d)
  (if (equal? (or (:multiplicity d) "") "add-by-default")
      (harness/choice
        :name (or (:name d) (:id d))
        :description (or (:description d) "")
        :action (list
          (harness/action 'connect/adopt
            :params (dict
              :driver (or (:name d) (:id d))
              :name (or (:name d) (:id d))))))
      (harness/choice
        :name (or (:name d) (:id d))
        :description (or (:description d) ""))))

(let* ((prompt-drivers
             (as-list (harness/kernel/drivers :abilityClaim 'completion)))

           (connections
             (as-list (harness/kernel/connections)))

           (used-connections
             (filter (lambda (c)
                       (member "completion"
                               (driver-can (:driver c))))
                     connections))

           (used-drivers
             (filter (lambda (d) d)
                     (map :driver used-connections)))

           (offer-rows
             (apply append
                    (as-list
                     (map (lambda (d)
                            (as-list (map (lambda (o) (offer-node d o))
                                          (visible-offers d connections))))
                          prompt-drivers))))

           (unused-drivers
             (filter (lambda (d)
                       (and (not (member d used-drivers))
                            (null? (driver-offers d))))
                     prompt-drivers)))

      (harness/choice
        :choices
          (append
            (as-list (map connection-node used-connections))
            offer-rows
            (as-list (map unused-driver-node unused-drivers)))))
