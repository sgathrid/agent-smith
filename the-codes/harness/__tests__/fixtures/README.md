# Test fixtures — provenance

Every fixture is a **copy of a real file**, not invented. Sources:

- agy: `/Users/gathrid/Repos/renyi/.agy-staff/jobs/` (20 real jobs)

Only two things are ever changed: huge `prompt`/`prompt_source.task` strings are
replaced with `[REDACTED for fixture]`, and job ids are shortened where the real
id would be confusing. Field shapes are verbatim.

## agy-clean-success/ — HAZARD A
Copied from `implement-musm82da-f1dc1fe4` (real spec/log/result), with
`warnings:false`. **Deliberately has NO `.progress.json` and NO `.events.jsonl`** —
that absence IS hazard A: a warning-free success is cleaned up on disk, and a
reader that treats missing progress as "missing job" loses the job entirely.

## agy-running/ — a live job
Copied from `implement-musm82da-f1dc1fe4.progress.json` (first 2 activities) and
the first 3 real lines of its `events.jsonl`. Has a spec, no `status.json` ⇒ must
normalize to `running`.

## agy-polluted/ — HAZARD C
`implement-musm82da-f1dc1fe4.result.md` is the **real file, byte-for-byte**
(15,857 bytes, 12 `<system_notification>` blocks prepended before the report).
`status.json` is the real file. This is the exact upstream artifact that
`stripSystemNotifications()` is unit-tested against.

## agy-canceled/ — HAZARD B
Real files from `implement-murvydru-07eed78d`, including its real
`.spec.json.cancel` marker (content `2026-10-03T04:24:33.249Z`) and real
`status.json` (`{"status":"canceled","reason":"canceled",...}`).

## agy-empty-warned/ — the headline rule
**Synthesized**, because agy-staff shipped no such job in the sampled 20 (all 20
had warnings *and* real output). Field shapes are copied from real files; only
the empty `result.md` (0 bytes) is invented. This is the case that must NOT
normalize to `succeeded`.
