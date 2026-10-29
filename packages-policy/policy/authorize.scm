;; Dist authorization. The document is the command or the path.
;; allow runs. #f and deny do not.
(decide/choose "Is this call authorized?"
  (list (list "allow" "authorized") (list "deny" "not authorized")))
