---
name: verification-harness
description: Create or maintain a project-local verification skill that drives the real app (UI, CLI or API) through a feature map. Type it when a repo has no scripted way to prove behavior, or when its existing verification skill has drifted.
disable-model-invocation: true
---

# Verification harness

A project needs a scripted way to drive the real app the way a user does and capture proof. This skill writes that as a project-local skill, or keeps an existing one honest. You write it for the next agent, who will read it cold, mid-task, having never seen the app.

Pick the mode. If the repo already has a verification skill with a feature map, maintain it. If not, create one. If several candidates exist, ask which.

## Create: interview the repo

Answer these from the codebase. Ask the person only what you cannot observe.
- **Surface:** what does a user touch? A web UI, desktop app, CLI or TUI, API, mobile app, library. Pick the primary one and note the rest.
- **Run:** how does it start locally? Prefer the repo's own documented dev command. Note ports, env vars, seed data and auth.
- **Drive:** how can an agent interact with it? Reuse existing harnesses first: end-to-end specs, browser automation already in the dev dependencies, terminal scripts, HTTP endpoints, a debug port. Only then pick a generic method: browser automation for web and desktop shells built on a browser engine, a PTY or terminal-multiplexer session for a CLI or TUI, plain HTTP for a service. Do not add a dependency to the project for this without asking.
- **Observe:** what evidence can be captured? Screenshots, accessibility snapshots, transcripts, response bodies, logs, exit codes, stored state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, the skill must say so and refuse to drive an instance it did not start.

If the checkout does not build or start as-is, fix that or report it precisely first. A skill written against a broken base teaches wrong steps.

## Create: write the skill

Write it inside this repo, in the project-level skills folder of the coding tool in use, in a directory such as `verify-<app>/`. Give it frontmatter with a name and a description that names the app, its surface and when to reach for it, and mark it user-invoked only (`disable-model-invocation: true` in the frontmatter, plus any setting the tool in use needs). Ground every line in what the interview found: real commands, real selectors, no placeholders. Sections:
- **Doctor:** the prerequisites and one read-only check that answers "is this instance worth driving?": process up, right build, port owned by this run, auth valid. Include the launch command and how to tell the app is ready. For a short-lived CLI, launch means build once, then start each drive in its own isolated session.
- **Drive:** how to exercise each feature, pointing into the feature map. Prefer stable handles (accessible roles and names, data attributes, prompt strings, routes) over coordinates and tab order. Wait on observable states, never on fixed sleeps. Any helper script the skill ships is executable and its invocation is shown in the body.
- **Evidence:** what to capture and where it goes. Exercise the real user path, never test-only setters or endpoints. Capture the action and the resulting state, and check side effects (files written, rows stored, messages sent) alongside what is visible. If the safe path is a dry run, observe what it actually skips.
- **Cleanup:** tear down what this run started, by its own handle and never by process name. Evidence survives cleanup at the location the skill names.

Seed a feature map beside it: a `features/README.md` index and one file per user-facing feature, starting with the top three to five you can find in routes, commands, menus or docs. Each file says, from the user's point of view, what the feature is, how to reach it, how to drive it, what end state proves it works, and its traps. Follow the shape of `${CLAUDE_PLUGIN_ROOT}/skills/verification-harness/references/feature-map-example.md`.

## Create: prove it once

Run the new skill end to end on one real mapped feature: doctor, drive, capture, clean up. Confirm the evidence still exists after cleanup. Fix what fails, and run cleanup after every failed attempt so broken runs do not strand processes or ports. A generated skill that was never executed is a draft.

## Maintain

The map rots as the app changes. One pass:
- Check the index against its feature files: missing, extra, duplicate or dead entries.
- Read the source behind each feature and note where the map has drifted, with citations. For a large map, helpers can read features in parallel per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#scale`, each briefed per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`; they read only, never drive the app or edit.
- Look at recent changes for user-facing features the map lacks. Call one missing only with a concrete source path.
- Do one live pass, required even when the source looks clean. Exercise every feature at least once. Run Doctor before the first drive and again after anything surprising. Keep evidence through every cleanup, and leave nothing running after the pass.
- Triage what you find. A wrong description is doc drift: fix the map. Working behavior the harness cannot drive is a harness gap: fix the skill, then re-drive it live. App behavior that is actually broken is a product bug: report it and leave the map describing intended behavior.

A feature you cannot reach is unreachable only with the concrete prerequisite (auth, entitlement, platform, outside state) and the route you tried. If the map omits that prerequisite, that is drift.

Edit only the verification skill's own directory. Never edit product code in this mode.

End with one outcome: **clean** (every feature covered, nothing to change), **changed** (the proven corrections you made) or **blocked** (exactly what stopped coverage). Include which features were covered live and any unreachable prerequisites.
