#lang racket
;; CS4337 Project 1: a prefix-notation calculator.
;;
;; Run it:
;;   racket calculator.rkt       interactive mode (shows a "> " prompt)
;;   racket calculator.rkt -b    batch mode (prints only results and errors)
;; Run the tests at the bottom of this file:
;;   raco test calculator.rkt
;;
;; How it works: each eval-... function gets the list of characters that are
;; still left to read. It returns a two-element list
;;   (list value remaining-characters)
;; or #f if the characters do not start with a valid expression.

;; ---------------------------------------------------------------------
;; Mode (code given with the assignment)
;; prompt? is #t in interactive mode and #f in batch mode (-b or --batch).

(define prompt?
   (let [(args (current-command-line-arguments))]
     (cond
       [(= (vector-length args) 0) #t]
       [(string=? (vector-ref args 0) "-b") #f]
       [(string=? (vector-ref args 0) "--batch") #f]
       [else #t])))

;; ---------------------------------------------------------------------
;; Small helpers

;; Is c one of the characters 0 through 9?
(define (digit? c)
  (and (char>=? c #\0) (char<=? c #\9)))

;; Drops any whitespace from the front of chars.
(define (skip-whitespace chars)
  (dropf chars char-whitespace?))

;; ---------------------------------------------------------------------
;; Evaluating expressions

;; Evaluates the expression at the front of input.
;; Returns (list value remaining-chars), or #f if the expression is invalid.
(define (eval-expr input history)
  (let ([chars (skip-whitespace input)])
    (if (null? chars)
        #f                                 ; ran out of characters
        (let ([c (first chars)]
              [remaining (rest chars)])
          (cond
            [(char=? c #\+) (eval-binary c remaining history)]
            [(char=? c #\*) (eval-binary c remaining history)]
            [(char=? c #\/) (eval-binary c remaining history)]
            [(char=? c #\-) (eval-negate remaining history)]
            [(char=? c #\$) (eval-history-ref remaining history)]
            [(digit? c) (eval-number chars)] ; the digit is part of the number
            [else #f])))))                 ; nothing valid starts with c

;; Evaluates the two expressions after a binary operator (+, * or /)
;; and combines them.
;; Returns (list value remaining-chars), or #f.
(define (eval-binary operator chars history)
  (let ([left (eval-expr chars history)])
    (if (not left)
        #f
        ;; The right side starts where the left side ended.
        (let ([right (eval-expr (second left) history)])
          (cond
            [(not right) #f]
            [(and (char=? operator #\/) (= (first right) 0)) #f] ; divide by zero
            [else (list (apply-operator operator (first left) (first right))
                        (second right))])))))

;; Applies a binary operator to two numbers.
(define (apply-operator operator a b)
  (cond
    [(char=? operator #\+) (+ a b)]
    [(char=? operator #\*) (* a b)]
    [(char=? operator #\/) (quotient a b)])) ; integer division

;; Evaluates the expression after a unary minus and negates it.
;; Returns (list value remaining-chars), or #f.
(define (eval-negate chars history)
  (let ([operand (eval-expr chars history)])
    (if (not operand)
        #f
        (list (- (first operand)) (second operand)))))

;; Reads a number (one or more digits) from the front of chars.
;; Returns (list number remaining-chars), or #f if chars does not start
;; with a digit.
(define (eval-number chars)
  (let ([digits (takef chars digit?)])
    (if (null? digits)
        #f
        (list (string->number (list->string digits))
              (dropf chars digit?)))))

;; Evaluates $n, which means "the value with id n in the history".
;; chars starts just after the $.
;; Returns (list value remaining-chars), or #f if n is missing or is not
;; an id in the history.
(define (eval-history-ref chars history)
  (let ([id-result (eval-number chars)])
    (if (not id-result)
        #f
        (let ([id (first id-result)])
          (if (or (< id 1) (> id (length history)))
              #f
              ;; history has the newest value first, so reverse it to put
              ;; the values in id order. Ids start at 1, list indexes at 0.
              (list (list-ref (reverse history) (- id 1))
                    (second id-result)))))))

;; ---------------------------------------------------------------------
;; Printing

;; Prints a result, for example "2: 19.0".
(define (print-result id value)
  (display id)
  (display ": ")
  (display (real->double-flonum value))
  (newline))

;; Prints an error, for example "Error: Invalid expression".
(define (print-error message)
  (display "Error: ")
  (display message)
  (newline))

;; ---------------------------------------------------------------------
;; The main loop

;; Evaluates one line of input and prints its result or an error.
;; Returns the history to use for the next line.
(define (process-line line history)
  (let ([result (eval-expr (string->list line) history)])
    (cond
      [(not result)
       (print-error "Invalid expression")
       history]
      [(not (null? (skip-whitespace (second result))))
       ;; A whole expression was read, but there is more text after it.
       (print-error "Unexpected trailing characters")
       history]
      [else
       (let ([new-history (cons (first result) history)])
         ;; The new value's id is how many values the history now holds.
         (print-result (length new-history) (first result))
         new-history)])))

;; Reads and evaluates lines until the input is "quit" or the input ends.
;; history holds every result so far, newest first.
(define (eval-loop history)
  (when prompt?
    (display "> ")
    (flush-output))
  ;; 'any accepts both "\n" and "\r\n" (Windows) line endings.
  (let ([line (read-line (current-input-port) 'any)])
    (cond
      [(eof-object? line) (void)]
      [(string=? line "quit") (void)]
      [else (eval-loop (process-line line history))])))

;; Start with an empty history. Code in (module+ main ...) runs when the
;; file is run with racket, but not when raco test loads it.
(module+ main
  (eval-loop '()))

;; ---------------------------------------------------------------------
;; Tests: run with  raco test calculator.rkt

(module+ test
  (require rackunit)

  ;; Evaluates text with the given history and returns just the value,
  ;; or #f if the expression is invalid.
  (define (value-of text history)
    (let ([result (eval-expr (string->list text) history)])
      (if result
          (first result)
          #f)))

  ;; Runs process-line without printing and returns the new history.
  (define (quiet-process-line line history)
    (parameterize ([current-output-port (open-output-nowhere)])
      (process-line line history)))

  ;; Numbers
  (check-equal? (eval-number (string->list "42 9")) (list 42 (string->list " 9")))
  (check-equal? (eval-number (string->list "x")) #f)
  (check-equal? (value-of "  7" '()) 7)

  ;; Binary operators
  (check-equal? (value-of "+1 2" '()) 3)
  (check-equal? (value-of "* 3 4" '()) 12)
  (check-equal? (value-of "/7 2" '()) 3)      ; integer division
  (check-equal? (value-of "/5 0" '()) #f)     ; divide by zero
  (check-equal? (value-of "*+ 1 1 /4 2" '()) 4)

  ;; Unary minus
  (check-equal? (value-of "-5" '()) -5)
  (check-equal? (value-of "+1-1" '()) 0)
  (check-equal? (value-of "--5" '()) 5)

  ;; History (newest first, so $1 is 6 and $2 is 30 here)
  (check-equal? (value-of "$1" '(30 6)) 6)
  (check-equal? (value-of "$2" '(30 6)) 30)
  (check-equal? (value-of "$3" '(30 6)) #f)   ; no value with id 3
  (check-equal? (value-of "$0" '(30 6)) #f)   ; ids start at 1
  (check-equal? (value-of "$" '(30 6)) #f)    ; missing id
  (check-equal? (value-of "+*2$1+$2 1" '(5 10)) 26) ; 2*10 + 5 + 1

  ;; Invalid expressions
  (check-equal? (value-of "" '()) #f)
  (check-equal? (value-of "   " '()) #f)
  (check-equal? (value-of "+1" '()) #f)
  (check-equal? (value-of "a" '()) #f)

  ;; eval-expr stops after one expression and returns what is left over
  (check-equal? (eval-expr (string->list "+1 2 2") '()) (list 3 (string->list " 2")))

  ;; process-line prints the result or an error ...
  (check-equal? (with-output-to-string (lambda () (process-line "+1 1" '())))
                "1: 2.0\n")
  (check-equal? (with-output-to-string (lambda () (process-line "*$1 5" '(6))))
                "2: 30.0\n")
  (check-equal? (with-output-to-string (lambda () (process-line "+1 2 2" '())))
                "Error: Unexpected trailing characters\n")
  (check-equal? (with-output-to-string (lambda () (process-line "+1" '())))
                "Error: Invalid expression\n")

  ;; ... and returns the new history. Errors leave the history unchanged.
  (check-equal? (quiet-process-line "+1 1" '()) '(2))
  (check-equal? (quiet-process-line "6" '(2)) '(6 2))
  (check-equal? (quiet-process-line "/5 0" '(2)) '(2)))
