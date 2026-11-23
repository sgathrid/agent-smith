# Design red flags

Screen each candidate design against these. A red flag is a reason to revise the shape or reject it.

## Shallow module

A large interface hiding little. Callers coordinate several calls to finish one operation, or options expose internal stages. Fix: pull the complexity behind a smaller surface so learning the interface saves the caller from learning the implementation.

## Information leakage

The same internal decision (a representation, a wire format, a policy) appears in several modules, so changing it means coordinated edits. Re-exporting transport or storage types is the common case. Fix: parse outside data into domain types at the boundary and keep the detail private to one module.

## Temporal decomposition

Modules split by execution order (load, validate, transform, save) that each repeat one representation and its invariants. Fix: group code by the knowledge it owns; steps that run at different times can live together when they protect the same decision.

## Pass-through method

A method that forwards the same arguments to another with the same shape, adding a layer and hiding nothing. Fix: delete it, or move the responsibility to the module that can complete the operation. Keep a forwarding layer only when it adds policy or adaptation.

## Split ownership

More than one module writes the same state or keeps its own copy. Someone editing one writer cannot see the others, so their rules drift. Fix: one owner per piece of state; others read it or ask the owner to change it.

## Two ways to do one task

More than one supported path for the same job. Whoever copies the first one they find keeps every path alive. Fix: keep one way, move the callers, delete the rest in the same change.

## Importable internals

Callers can reach a module's internals, so the shortest path that compiles imports them and they become interface. Fix: make internals unreachable from outside, so such an import fails the build.

## Hand-synced list

The same items listed in two or more places, so adding one means editing every list. Fix: keep one list and derive the others; if one cannot be derived, make the build fail when they disagree.
