# CS4337 Project 1: Prefix Calculator

A prefix-notation calculator in Racket. Everything is in `calculator.rkt`.

## Running it

```sh
racket calculator.rkt          # interactive mode: shows a "> " prompt
racket calculator.rkt -b       # batch mode: prints only results and errors
racket calculator.rkt -b < input1.txt
raco test calculator.rkt       # runs the tests at the bottom of the file
```

Type `quit` to exit. The program also stops when the input ends.

## Example

```
> +1 1
1: 2.0
> *$1 5
2: 10.0
> /5 0
Error: Invalid expression
> +1 2 2
Error: Unexpected trailing characters
> quit
```

## How the code is organized

Each `eval-...` function takes the list of characters still left to read and returns
`(list value remaining-characters)`, or `#f` if the expression is invalid.

| Function | Handles |
| --- | --- |
| `eval-expr` | Skips whitespace, looks at the first character and calls the function below that handles it |
| `eval-binary` | `+`, `*` and `/`: evaluates the left expression, then the right one starting where the left one ended |
| `eval-negate` | Unary `-` |
| `eval-number` | A run of digits |
| `eval-history-ref` | `$n`: the value with id `n` in the history |
| `process-line` | Evaluates one line, prints the result or an error, and returns the new history |
| `eval-loop` | Reads lines until `quit`. The history is a parameter, and a new result is `cons`ed onto it |

A line that fails to evaluate prints an error and leaves the history unchanged.

## Where the sample runs differ from the written spec

The written spec and the sample outputs disagree in two places. The code follows the written spec:

1. **Printing:** the spec says to convert with `real->double-flonum` and print with `display`, so 4 prints as
   `4.0`. The samples show `4`.
2. **Division:** the spec says `/` is integer division, so `/5 2` is `2`. The samples show `2.5`, which is
   real division.

To match the sample numbers instead, change `(quotient a b)` to `(/ a b)` in `apply-operator`. With that
change, all five sample runs match apart from the `.0`. The error messages match the samples either way.
