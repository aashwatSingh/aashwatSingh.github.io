#lang racket

;; CS4337 Project 1: prefix-notation expression calculator.
;;
;; Usage:
;;   racket calculator.rkt            interactive mode (prompts for input)
;;   racket calculator.rkt -b         batch mode (only results and errors are printed)
;;   racket calculator.rkt --batch    same as -b
;;
;; Every evaluator below takes a list of characters and returns either
;;   (list value remaining-chars)   on success, or
;;   #f                             if the expression is invalid.

;; ---------------------------------------------------------------------------
;; Mode detection (provided with the assignment)

(define prompt?
   (let [(args (current-command-line-arguments))]
     (cond
       [(= (vector-length args) 0) #t]
       [(string=? (vector-ref args 0) "-b") #f]
       [(string=? (vector-ref args 0) "--batch") #f]
       [else #t])))

(define interactive? prompt?)

;; ---------------------------------------------------------------------------
;; Character helpers

;; Drops leading whitespace from a list of characters.
(define (skip-whitespace chars)
  (cond
    [(null? chars) chars]
    [(char-whitespace? (car chars)) (skip-whitespace (cdr chars))]
    [else chars]))

;; Splits a list of characters into the longest prefix whose characters all
;; satisfy pred? and the rest. Returns (list prefix rest).
(define (take-while pred? chars)
  (if (and (pair? chars) (pred? (car chars)))
      (let ([split (take-while pred? (cdr chars))])
        (list (cons (car chars) (car split)) (cadr split)))
      (list '() chars)))

;; Reads a run of digits (with at most one decimal point) from the front of
;; chars. Returns (list number rest) or #f if there is no number there.
(define (read-number chars)
  (let* ([whole (take-while char-numeric? chars)]
         [digits (car whole)]
         [rest (cadr whole)])
    (cond
      [(null? digits) #f]
      [(and (pair? rest) (char=? (car rest) #\.))
       (let* ([frac (take-while char-numeric? (cdr rest))]
              [text (list->string (append digits (list #\.) (car frac)))])
         (list (string->number text) (cadr frac)))]
      [else (list (string->number (list->string digits)) rest)])))

;; ---------------------------------------------------------------------------
;; Evaluation

;; Looks up history id n (1 is the oldest value). The history is stored
;; newest-first, so it is reversed before indexing.
(define (history-ref history n)
  (if (and (exact-positive-integer? n) (<= n (length history)))
      (list-ref (reverse history) (- n 1))
      #f))

;; Evaluates a $n history reference. chars starts just after the "$".
(define (eval-history chars history)
  (let ([num (read-number chars)])
    (and num
         (let ([value (history-ref history (car num))])
           (and value (list value (cadr num)))))))

;; Evaluates the negation operator. chars starts just after the "-".
(define (eval-unary chars history)
  (let ([operand (eval-expr chars history)])
    (and operand
         (list (- (car operand)) (cadr operand)))))

;; Applies a binary operator to two values, or returns #f when it can't
;; (division by zero).
(define (apply-binary op left right)
  (cond
    [(char=? op #\+) (+ left right)]
    [(char=? op #\*) (* left right)]
    [(char=? op #\/) (if (zero? right) #f (/ left right))]
    [else #f]))

;; Evaluates a binary operator. chars starts just after the operator.
(define (eval-binary op chars history)
  (let ([left (eval-expr chars history)])
    (and left
         (let ([right (eval-expr (cadr left) history)])
           (and right
                (let ([value (apply-binary op (car left) (car right))])
                  (and value (list value (cadr right)))))))))

;; Evaluates one expression from the front of chars.
(define (eval-expr chars history)
  (let ([chars (skip-whitespace chars)])
    (if (null? chars)
        #f
        (let ([c (car chars)])
          (cond
            [(member c '(#\+ #\* #\/)) (eval-binary c (cdr chars) history)]
            [(char=? c #\-) (eval-unary (cdr chars) history)]
            [(char=? c #\$) (eval-history (cdr chars) history)]
            [(char-numeric? c) (read-number chars)]
            [else #f])))))

;; Evaluates a whole line of input. Returns (list 'ok value) or
;; (list 'error message).
(define (eval-line line history)
  (let ([result (eval-expr (string->list line) history)])
    (cond
      [(not result) (list 'error "Invalid expression")]
      [(pair? (skip-whitespace (cadr result)))
       (list 'error "Unexpected trailing characters")]
      [else (list 'ok (car result))])))

;; ---------------------------------------------------------------------------
;; Read-eval-print loop

(define (print-result id value)
  (display id)
  (display ": ")
  (display (real->double-flonum value))
  (newline))

(define (print-error message)
  (display "Error: ")
  (displayln message))

;; The history is a parameter of the loop: a successful result is cons-ed onto
;; it and passed to the next iteration. Its newest value is first.
(define (eval-loop history)
  (when interactive?
    (display "> ")
    (flush-output))
  (let ([line (read-line (current-input-port) 'any)])
    (cond
      [(eof-object? line) (void)]
      [(string=? line "quit") (void)]
      [else
       (let ([result (eval-line line history)])
         (if (eq? (car result) 'ok)
             (let ([new-history (cons (cadr result) history)])
               (print-result (length new-history) (cadr result))
               (eval-loop new-history))
             (begin
               (print-error (cadr result))
               (eval-loop history))))])))

(module+ main
  (eval-loop '()))
