# CS4337 Project 1: Prefix Calculator

A prefix-notation expression calculator written in Racket.

## Running

```sh
racket calculator.rkt          # interactive mode, prompts with "> "
racket calculator.rkt -b       # batch mode, prints only results and errors
racket calculator.rkt --batch  # same as -b
./run-tests.sh                 # runs the sample inputs in tests/ and diffs the output
```

Type `quit` to exit.

## Expressions

| Syntax | Meaning |
| --- | --- |
| `+ a b` | addition |
| `* a b` | multiplication |
| `/ a b` | division (dividing by zero is an error) |
| `- a` | negation (there is no subtraction) |
| `$n` | the value with history id `n` |
| `12`, `1.5` | a number |

Whitespace separates tokens but is otherwise ignored, so `+*2$1+$2 1` and `+ * 2 $1 + $2 1` are the same.
Each successful result is added to the history and printed as `id: value`. Invalid input prints
`Error: Invalid expression`; input left over after a complete expression prints
`Error: Unexpected trailing characters`.
