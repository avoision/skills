# Sample plan: add a --shout flag to hello.py

A practice plan for trying out plan-review. It only edits a throwaway file, `hello.py`, in the folder you copy it to.

## Goal
`python3 hello.py --shout Ada` prints `HELLO, ADA!`. Without the flag the output doesn't change.

## Context
`hello.py` (created in step 1) prints a greeting. It has no options and no tests.

## Steps
1. Create the script
   - Create `hello.py` that prints `Hello, <name>!` for a name given on the command line (default `world`).
2. Add the flag
   - Parse `--shout` with `argparse`.
   - When set, print the greeting in upper case.
3. Test it
   - Add `test_hello.py` with one test per mode (normal and shout).

## Open questions
- Should `--shout` also add extra exclamation marks? Options: keep it to upper case only (recommended), or add `!!!`.

## Verification
- `python3 hello.py Ada` prints `Hello, Ada!`
- `python3 hello.py --shout Ada` prints `HELLO, ADA!`
- `python3 -m unittest test_hello` passes
