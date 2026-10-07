<system_notification>
[Message] timestamp=2026-10-03T16:42:01Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-72 priority=MESSAGE_PRIORITY_LOW content=Command exited with code 0:
cargo check -p renyi-app
Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-72.log
Task: 730432c0-5c38-488c-a463-4f8567be485b/task-72
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T16:42:01Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-76 priority=MESSAGE_PRIORITY_LOW content=Timer task-76 was cancelled early because condition 730432c0-5c38-488c-a463-4f8567be485b/task-72 was met.
Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-76.log
Task: 730432c0-5c38-488c-a463-4f8567be485b/task-76
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T16:42:15Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-78 priority=MESSAGE_PRIORITY_LOW content=Command exited with code 0:
cargo check -p renyi-app --tests
Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-78.log
Task: 730432c0-5c38-488c-a463-4f8567be485b/task-78
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T16:48:33Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-189 priority=MESSAGE_PRIORITY_LOW content=Command exited with code 0:
cargo test -p renyi-core dashboard_decode
Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-189.log
Task: 730432c0-5c38-488c-a463-4f8567be485b/task-189
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T16:58:47Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-378 priority=MESSAGE_PRIORITY_LOW content=Command exited with code 0:
cargo test -p renyi-core dashboard_decode
Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-378.log
Task: 730432c0-5c38-488c-a463-4f8567be485b/task-378
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:03:00Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-456 priority=MESSAGE_PRIORITY_LOW content=Command exited with code 0:
cargo test -p renyi-app
Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-456.log
Task: 730432c0-5c38-488c-a463-4f8567be485b/task-456
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:03:08Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-456 priority=MESSAGE_PRIORITY_HIGH content=Task id "730432c0-5c38-488c-a463-4f8567be485b/task-456" finished with result:

The command exited with code 0.
Output:
   Compiling sha2 v0.10.9
   Compiling tokio v1.53.1
   Compiling rustix v1.1.4
   Compiling renyi-app v0.6.0 (/Users/gathrid/Repos/renyi/src-tauri)
   Compiling tauri-codegen v2.6.3
   Compiling tempfile v3.27.0
   Compiling renyi-core v0.6.0 (/Users/gathrid/Repos/renyi/crates/renyi-core)
   Compiling tauri-macros v2.6.3
   Compiling tauri v2.11.5
    Finished `test` profile [unoptimized + debuginfo] target(s) in 13.57s
     Running unittests src/lib.rs (target/debug/deps/renyi_app-13e019fb09c0ec9f)

running 5 tests
test decoded_view::tests::capability_isolation_default_grants_permissions_only_to_main_window ... ok
test decoded_view::tests::fetch_loopback_refuses_non_http_and_non_loopback ... ok
test tests::suggestions_are_usable_as_dataset_names ... ok
test decoded_view::tests::fetch_loopback_returns_410_expired_message ... ok
test decoded_view::tests::fetch_loopback_returns_200_html_content ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running unittests src/main.rs (target/debug/deps/renyi_desktop-18f1a1aa43851086)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s



Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-456.log
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:03:31Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-467 priority=MESSAGE_PRIORITY_HIGH content=Task id "730432c0-5c38-488c-a463-4f8567be485b/task-467" finished with result:

The command exited with code 0.
Output:
   Compiling renyi-app v0.6.0 (/Users/gathrid/Repos/renyi/src-tauri)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 10.97s
     Running unittests src/lib.rs (target/debug/deps/renyi_app-13e019fb09c0ec9f)

running 5 tests
test decoded_view::tests::capability_isolation_default_grants_permissions_only_to_main_window ... ok
test decoded_view::tests::fetch_loopback_returns_410_expired_message ... ok
test decoded_view::tests::fetch_loopback_refuses_non_http_and_non_loopback ... ok
test tests::suggestions_are_usable_as_dataset_names ... ok
test decoded_view::tests::fetch_loopback_returns_200_html_content ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running unittests src/main.rs (target/debug/deps/renyi_desktop-18f1a1aa43851086)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s



Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-467.log
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:03:41Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-471 priority=MESSAGE_PRIORITY_HIGH content=Task id "730432c0-5c38-488c-a463-4f8567be485b/task-471" finished with result:

The command exited with code 0.
Output:
    Checking renyi-app v0.6.0 (/Users/gathrid/Repos/renyi/src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 7.42s



Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-471.log
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:04:12Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-477 priority=MESSAGE_PRIORITY_HIGH content=Task id "730432c0-5c38-488c-a463-4f8567be485b/task-477" finished with result:

The command exited with code 1.
Output:




Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-477.log
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:04:36Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-481 priority=MESSAGE_PRIORITY_HIGH content=Task id "730432c0-5c38-488c-a463-4f8567be485b/task-481" finished with result:

The command exited with code 0.
Output:
<truncated 5 lines>
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests renyi_core

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s



Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-481.log
</system_notification>
<system_notification>
[Message] timestamp=2026-10-03T17:05:44Z sender=730432c0-5c38-488c-a463-4f8567be485b/task-499 priority=MESSAGE_PRIORITY_HIGH content=Task id "730432c0-5c38-488c-a463-4f8567be485b/task-499" finished with result:

The command exited with code 1.
Output:




Log: file:///Users/gathrid/.gemini/antigravity-cli/brain/730432c0-5c38-488c-a463-4f8567be485b/.system_generated/tasks/task-499.log
</system_notification>
## What I changed

- [`crates/renyi-core/src/viewer/dashboard_decode.rs`](file:///Users/gathrid/Repos/renyi/crates/renyi-core/src/viewer/dashboard_decode.rs) — Implemented `decode_dashboard_page` and `DecodedPage`: parses Crockford token string literals (`"..."`), resolves each token to its active dataset prefix, detokenizes via vault cipher, JSON-escapes identities script-safely (`<`, `>`, `&`, U+2028, U+2029), leaves unresolvable/malformed/non-literal tokens untouched, records exactly one audit entry (`reveal_dashboard`), and ensures HTML is never written to disk. Added five sentence-named tests.
- [`crates/renyi-core/src/viewer/mod.rs`](file:///Users/gathrid/Repos/renyi/crates/renyi-core/src/viewer/mod.rs) — Gated and re-exported `decode_dashboard_page` and `DecodedPage` under `#[cfg(any(test, feature = "reveal"))]`.
- [`crates/renyi-core/src/lib.rs`](file:///Users/gathrid/Repos/renyi/crates/renyi-core/src/lib.rs) — Re-exported `decode_dashboard_page` and `DecodedPage` at crate root under `#[cfg(any(test, feature = "reveal"))]`.
- [`crates/renyi-core/src/vault/mod.rs`](file:///Users/gathrid/Repos/renyi/crates/renyi-core/src/vault/mod.rs) — Added `set_plaintext_for_test` test helper to allow unit tests to populate exact encrypted plaintexts (e.g. testing script-safety and unicode escaping for whitespace like U+2028 without modifying production vault trimming).
- [`src-tauri/src/decoded_view.rs`](file:///Users/gathrid/Repos/renyi/src-tauri/src/decoded_view.rs) — Implemented loopback HTTP fetch, custom URI scheme protocol (`renyi-dash://<label>`), in-memory page storage (`DashboardPages`), and Tauri command `open_dashboard_decoded` with window isolation and auto-cleanup on window destroy. Added unit tests for loopback HTTP handling, 410 expiration error message, and capability isolation.
- [`src-tauri/src/lib.rs`](file:///Users/gathrid/Repos/renyi/src-tauri/src/lib.rs) — Registered custom URI scheme protocol builder hook and added `open_dashboard_decoded` to `generate_handler!`, leaving existing `open_dashboard` untouched.

---

## Window Isolation & HTTP Fetch Choice

### 1. Capability Isolation
Tauri v2 strictly denies all plugin permissions and IPC commands to windows unless their label is explicitly declared in `capabilities/*.json`. In [`src-tauri/capabilities/default.json`](file:///Users/gathrid/capabilities/default.json), `"windows"` contains exclusively `["main"]`. Dashboard windows are created with dynamic labels matching `dash-<n>` (e.g., `dash-1`, `dash-2`). Because `dash-*` matches no capability in `default.json` (or any capability file), the dashboard webview has **zero IPC permissions** — it cannot invoke Tauri commands or plugin methods. This was verified programmatically in the unit test `decoded_view::tests::capability_isolation_default_grants_permissions_only_to_main_window`.

### 2. Content Security Policy (CSP)
The custom URI protocol handler (`renyi-dash://<label>`) serves HTML from memory with:
- `Content-Security-Policy`:
  `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
- `X-Content-Type-Options`: `nosniff`
- `Referrer-Policy`: `no-referrer`
- `Content-Type`: `text/html; charset=utf-8`

Network requests (`connect-src 'none'`), image fetches (`img-src 'none'`), font loads (`font-src 'none'`), frame embedding (`frame-ancestors 'none'`), and form submissions (`form-action 'none'`) are blocked at the web engine level.

### 3. Navigation & Window Interception
The `WebviewWindowBuilder` enforces:
- `.on_navigation(move |dest| dest == &allowed_url)`: Denies navigation away from the initial `renyi-dash://<label>` URL.
- `.on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)`: Denies all attempts to open popups or new windows.
- `.on_window_event`: Listens for `tauri::WindowEvent::Destroyed` to remove the HTML string from memory as soon as the window closes.

### 4. HTTP Fetch Choice
Implemented via **`std::net::TcpStream`** (zero new dependencies; standard library only).
- Connect timeout: 3 seconds
- Read/write timeouts: 5 seconds
- Host enforcement: Only exact `127.0.0.1` and `localhost` are accepted; all other hosts and schemes other than `http` are refused.
- HTTP 410 Gone response immediately maps to `"This dashboard has expired; ask your AI to make it again."`.

---

## Added Test Paths

From `cargo test --workspace -- --list`:

### `renyi-core`:
- `viewer::dashboard_decode::tests::tokens_of_a_live_dataset_are_replaced_by_identities_script_safely`
- `viewer::dashboard_decode::tests::tokens_of_an_unknown_prefix_and_malformed_tokens_are_left_as_is`
- `viewer::dashboard_decode::tests::tokens_inside_non_literal_text_are_left_as_is`
- `viewer::dashboard_decode::tests::exactly_one_audit_row_with_counts_and_no_identity`
- `viewer::dashboard_decode::tests::decoding_writes_no_file_staging_dir_and_data_dir_unchanged`

### `renyi-app`:
- `decoded_view::tests::capability_isolation_default_grants_permissions_only_to_main_window`
- `decoded_view::tests::fetch_loopback_refuses_non_http_and_non_loopback`
- `decoded_view::tests::fetch_loopback_returns_410_expired_message`
- `decoded_view::tests::fetch_loopback_returns_200_html_content`

---

## How I verified it

All required commands were executed and passed cleanly:

```bash
cargo fmt --all
# (Clean exit code 0)

cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -2
# Output:
#     Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.63s

cargo clippy -p renyi-core --features reveal --all-targets -- -D warnings 2>&1 | tail -1
# Output:
#     Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.12s

cargo test --workspace 2>&1 | grep -E 'panicked at|FAILED|^test result' | grep -v ' 0 failed'
# (No failures; grep exited with code 1 due to 0 matches)

cargo tree -p renyi-mcp -e features -i renyi-core | grep 'feature "reveal"'
# (Prints nothing; grep exited with code 1 confirming feature isolation)
```

---

## Notes

- **File size bounds**: All new files are kept ≤ ~400 lines: [`dashboard_decode.rs`](file:///Users/gathrid/Repos/renyi/crates/renyi-core/src/viewer/dashboard_decode.rs) is 376 lines, and [`decoded_view.rs`](file:///Users/gathrid/Repos/renyi/src-tauri/src/decoded_view.rs) is 312 lines.
- **Keychain safety**: All unit tests open vaults via `LocalVault::open_with_key`, never touching the OS keychain.
- **Git integrity**: No commits or branch operations were made; dirty workspace state from user-owned context was untouched.
The implementation and verification are complete. All tests pass with zero warnings, capability isolation and CSP headers are enforced, and the changes are ready for your review.

[unrestricted] Working tree is dirty after implement. Existing pre-run changes may be part of the task context.
Status entries that appeared or changed during the run:
   M crates/renyi-core/src/lib.rs
   M crates/renyi-core/src/vault/mod.rs
   M crates/renyi-core/src/viewer/mod.rs
   M src-tauri/src/lib.rs
   M src/api.ts
   M src/screens/DashboardsScreen.tsx
  ?? crates/renyi-core/src/viewer/dashboard_decode.rs
  ?? src-tauri/src/decoded_view.rs
`git diff --stat`:
.gitignore                          |  3 +++
 AGENTS.md                           | 40 +++++++++++++++++++++++++++++++++++++
 crates/renyi-core/src/lib.rs        |  4 +++-
 crates/renyi-core/src/vault/mod.rs  | 26 ++++++++++++++++++++++++
 crates/renyi-core/src/viewer/mod.rs |  4 ++++
 src-tauri/src/lib.rs                |  8 +++++++-
 src/api.ts                          |  3 +++
 src/screens/DashboardsScreen.tsx    | 20 ++++++++++++++++++-
 8 files changed, 105 insertions(+), 3 deletions(-)
New untracked files: crates/renyi-core/src/viewer/dashboard_decode.rs, src-tauri/src/decoded_view.rs
ACTION FOR THE CALLING AGENT: inspect the current workspace (`git status --short`, `git diff`) and distinguish pre-run dirty paths from this run's delta. Continue the same agy conversation for follow-up work. If committing or opening a PR, first verify the task explicitly authorized that delivery.
