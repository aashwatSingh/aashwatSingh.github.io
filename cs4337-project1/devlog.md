# 10-15-2026

Starting Project 1, a prefix-notation calculator in Racket.
The program reads a line, evaluates one prefix expression from it, and keeps a history of results that later expressions can refer to with `$n`.
It has to run in an interactive mode and a batch mode (`-b`/`--batch`), and the batch output is what gets compared against the sample runs.

My plan follows the tip in the assignment: each kind of expression gets its own function that takes the remaining characters and returns a two-element list, the value and the characters left over.
`eval-expr` skips whitespace and looks at the first character to decide which one to call: `+ * /` go to `eval-binary`, `-` goes to `eval-unary`, `$` goes to `eval-history`, and a digit goes to `read-number`.
Because each function hands back the leftover characters, the binary case just evaluates the left operand and then evaluates the right operand from whatever the left one left behind.
No mutable state or index counters are needed; the "position" in the input is the list itself.

For errors I decided to have every evaluator return `#f` on failure instead of raising exceptions.
Using `and` to chain the steps means a failure anywhere (a missing operand, an unknown character, division by zero, a `$n` that is out of range) falls straight through to the top.
Trailing characters are checked once, in `eval-line`, after the whole expression has been evaluated: if anything but whitespace is left, it is the "Unexpected trailing characters" error from sample 4.

The history is a parameter of `eval-loop`.
A successful result is cons-ed onto it, so the newest value is first and its id is just the length of the new history.
`history-ref` reverses the list before indexing so `$1` is the oldest value.

# 10-15-2026 (testing)

I ran all five sample inputs in batch mode.
Two things in the samples disagree with the written spec.

First, division.
The spec says `/` is integer division, but sample 2 gives `/5$1` (5 / 2) as `2.5`, and sample 3 only gets `19.5` if the division is exact.
I used Racket's `/`, which gives the exact rational `5/2`, so the samples match.
This also explains why the spec says to convert results with `real->double-flonum` before printing: otherwise `display` would print `5/2`.

Second, whole numbers.
The spec says to print `(real->double-flonum value)` with `display`, which prints `4.0`, but the sample outputs show `4`.
I followed the spec, so every whole-number result differs from the samples by the trailing `.0`.
Every other value and every error message matches.
I need to check with the professor which one is expected before submitting.
