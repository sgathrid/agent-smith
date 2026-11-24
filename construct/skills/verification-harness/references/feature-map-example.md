# Feature map example

A short map for an imaginary notes app with a web UI and a CLI. The real map is a `features/` directory: this README plus one file per feature. All three are shown here in one page.

## features/README.md

```markdown
# Notes verification map

Baseline for every recipe:
- Launch at http://127.0.0.1:4173 with NOTES_DATA_DIR set to a fresh scratch dir per run.
- Seed two notes: "Quarterly plan" (body "Draft budget") and "Grocery list".
- Run Doctor and require the expected URL, data dir and build.

Conventions: prefer accessible roles and names; wait for the named state, never a fixed delay;
restore seeded data after a mutation; keep proof artifacts through cleanup.
Report an unreachable entry point with the command tried and the missing prerequisite.

- [Create a note](create-note.md): browser and CLI creation, cancel, persistence.
- [Search](search.md): toolbar, keyboard and CLI search; match, empty and clear states.
```

## features/create-note.md

```markdown
# Create a note

A user saves a titled note from the browser or the CLI and finds it again later.

## Sub-features
- create-save: title and body persist.
- create-cancel: an unsaved draft is discarded.
- create-cli: the CLI creates the same note shape.

## How to get to it (user POV)
- The "New note" button in the toolbar, or "n" with focus outside a text field.
- `notes create --title <t> --body <b>` in a terminal.

## Driving it
- Click button "New note"; a form "Note editor" opens with focus in "Title".
- Fill "Title" with "Release checklist", "Body" with "Tag and publish"; click "Save note".
  Status "Note saved" appears.
- Proof: open "All notes", reopen "Release checklist"; both values show. Capture an
  accessibility snapshot and a screenshot.
- CLI: `notes create --title "CLI note" --body "From terminal" --format json` exits 0 and
  prints the new title.

## Gotchas
- "n" typed inside a text field inserts a letter instead of opening the editor.
- A save status alone is not proof; reopen the note from the list.
```

## features/search.md

```markdown
# Search

A user finds notes by title or body text and tells "no matches" apart from a failed search.

## Sub-features
- search-match: title and body matches; data unchanged.
- search-empty: a query with no matches shows an empty state.
- search-cli: the CLI returns the same matches.

## How to get to it (user POV)
- The "Search" button, or "/" with focus outside a text field.
- `notes search <query>` in a terminal.

## Driving it
- Click "Search", fill searchbox "Search notes" with "budget"; list "Search results"
  contains "Quarterly plan" with a body excerpt.
- Fill "volcano"; status "No matching notes" appears.
- CLI: `notes search "volcano" --format json` exits 0 and prints [].

## Gotchas
- Results update after a debounce; wait for the list or the empty status.
- Archived notes are hidden unless "Include archived" is on.
```
