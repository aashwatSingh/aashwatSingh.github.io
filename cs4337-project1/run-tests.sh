#!/bin/sh
# Runs every tests/inputN.txt through the calculator in batch mode and diffs
# the result against tests/outputN.txt.
cd "$(dirname "$0")"
status=0
for input in tests/input*.txt; do
  expected="tests/output${input#tests/input}"
  if racket calculator.rkt -b < "$input" | diff -u "$expected" - > /dev/null; then
    echo "PASS $input"
  else
    echo "FAIL $input"
    racket calculator.rkt -b < "$input" | diff -u "$expected" -
    status=1
  fi
done
exit $status
