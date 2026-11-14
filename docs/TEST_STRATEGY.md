# VANTA test strategy

All cases below are planned unless explicitly marked observed. M0 checked the local server version, pinned API source and Flask tag. It did not exercise a VANTA run or an official task.

## Layers and fixtures

- Run strict TypeScript, build, unit tests and static checks with npm scripts established in M1. Exercise pure context ranking, patch and approval state, event reduction, backoff and path-policy logic with deterministic fixtures and fake clocks.
- Test the SDK adapter first against a controlled HTTP/SSE fixture with split frames, duplicate events, paused calls and disconnects. Keep fixtures derived from redacted events captured against the pinned TrueForge pair. Test a genuine SDK session and authenticated MCP connector on native Windows using a trusted throwaway workspace. Only real TrueForge traces count as demo evidence.
- Launch the VS Code desktop test host with `@vscode/test-electron` on Windows and a Linux smoke target when available. Exercise commands, views, scheme registration, dirty buffers and editor mutations with temporary workspaces. Interact manually with keyboard focus, actual hunk diff and final recording. [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension).
- Use small generated repos for unrelated-language changes and a synthetic large repo with ranked hits and decoys. Use the pinned Flask release for official cases. Keep credentials and checkpoints outside fixtures. Make Windows process and filesystem failures reproducible through injection where possible.

## Integration and fault matrix

| Case | Exercise | Assertions and evidence |
| --- | --- | --- |
| EXT-01 | Clean VS Code user data and trusted local project. Activate, run the keybinding with selection and invoke the Studio. Repeat without TrueForge running. | Registered commands and view appear, selection captured, status actionable, editor navigation responsive. |
| EXT-02 | Keyboard-only operation, screen reader, high contrast, light/dark themes, narrow sidebar and 200% zoom. Reload webview during a stream. | Focus moves to prompts and returns, controls have names, status is readable without color, transcript resumes from host state, no duplicate operations. |
| EXT-03 | Run history across two workspaces, reload, connection failure, model switch and concurrent view actions. | Correct workspace history and profile, genuine test/diagnostic results, stale and forged UI actions rejected, UI remains responsive. |
| TF-01 | Native Windows server and matched SDK. Check health, create a live session, send a turn and identify it in TrueForge. Repeat with a second model profile during release rehearsal. | Version and session ID recorded. Source review confirms only TrueForge traffic for model operations. |
| TF-02 | Genuine token deltas and tool events, then replay split SSE frames, duplicate sequence IDs, disconnect, partial deltas and terminal error from fixtures. | Incremental output, orderly tool timeline, replay dedup preserves distinct deltas sharing a logical event ID, final state matches server, bounded render overhead. |
| TF-03 | Real active turn, MCP tool paused for review, and delayed MCP call. Call native cancel during each. Send explicit deny on a separate gated call. | Confirm actual per-turn API semantics and terminal events, old connector loses authority, denied call never dispatches. Run local cancellation races under REL-01. |
| TF-04 | Real agent with selected tool schemas deferred, followed by equivalent eager configuration. | TrueForge session records actual deferred discovery and use. Account for schemas saved versus extra turns and failures. Confirm gating or keep gated tools eager. |
| MCP-01 | Register loopback connector, initialize and discover tools, invoke a bounded read, search and stage from one turn. Start a second workspace and try wrong, missing, expired and stale connector credentials. | Header authentication works, actual dispatch and selected file paths in trace, staging isolated, denied requests produce no tool effects, owned resources disposed. |
| MCP-02 | Trigger `review_proposal`: accept one hunk and reject a second, reject all in another run. Try alternate TrueForge UI approval, duplicate event, altered arguments, a changed proposal and cancel during pause. | Native TrueForge approval linked to revision. Only accepted hunks enter the approved overlay and later commit. Denial, replay, late tool calls and external approvals produce no unapproved writes. |
| MCP-03 | Approve a trusted test profile for a disposable snapshot containing an accepted overlay. Repeat with rejection, invalid arguments and cancellation after spawning a child/grandchild on Windows. | Capped result/exit status, real workspace untouched by test, rejected input never runs, child tree stops or residual state is visible. |
| CTX-01 | Resolve explicit file/symbol, unsaved buffers, ambiguous mention and missing language provider. | Correct ranges and provenance. Ambiguities surfaced, lexical fallback useful, document versions respected. |
| CTX-02 | Run against large fixture with close decoys and import edges. Repeat with warm cache and no `rg`. | Relevant symbols and direct dependencies rank ahead of decoys, deduped ranges and reproducible reasons, fallback remains bounded. Record expected versus retrieved ranges. |
| CTX-03 | Exceed initial and cumulative tool budget, including repeats and multibyte text. | Hard byte and line caps, conservative token estimates, visible omitted content and reasons, no cap bypass through repeated reads. |
| EDIT-01 | Two separated hunks, reject one, apply the other, then undo. Repeat for selection edge, CRLF, UTF-8 BOM, Unicode and existing unsaved edits. | Preview matches selected patch, reject outcome unchanged, apply and undo restore appropriate disk and buffer state. |
| EDIT-02 | Change a reviewed file after staging, add a new file at a proposed path, and switch workspace trust mid-run. | Stale or untrusted targets blocked, user changes preserved, new review required. |
| EDIT-03 | Fault-inject a failed resource create/save, false result from `applyEdit`, restart during apply, formatter edits and external file edits. Re-run recovery and undo twice. | Original or approved final state where recovery preconditions hold. Divergent files preserved with a recoverable conflict and useful diff. Duplicate apply and undo have no extra effect. |
| SEC-01 | Try `..`, absolute, drive-relative, UNC/device/ADS paths, case aliases, symlink/junction escapes, sensitive files and fake root IDs through all tool inputs. | Path traversal and secret reads denied, including new-file parents. Verify trustworthy search arguments and ignored paths. |
| SEC-02 | Insert prompt injection in repository and tool results, scripts/HTML in streamed markdown and spoofed messages from a stale webview. | Content rendered inert, scopes and approval hold, logs/trace/export redact synthetic credentials, side effects stay gated. |
| SEC-03 | Test command delimiters and injection payloads, repository-supplied executable or environment, unauthorized working directory, repeated grant and untrusted repo. | No arbitrary shell, executable swap or command replay. Verify profile schema and its trusted runtime boundary. |
| REL-01 | Cancel during context search, streaming, proposal staging, paused approval, command and apply handoff. Disconnect during cancel and reopen. | Local cancellation indication target under 200 ms on the rehearsal machine. Zero unapproved disk changes and rejected late work. An already-started approved commit finishes or recovers. Confirm terminal state or explicitly report remote timeout. |
| REL-02 | Inject timeouts, 429/5xx and ambiguous POST success. Reconnect after partial SSE. Delay responses through retry deadlines. | Bounded backoff without duplicate turns, approvals or tools, clear error and finish state, editor remains interactive. |
| REL-03 | Primary provider auth failure or unreachable provider with separate working secondary model configured. Test unavailable secondary, ambiguous primary effects and cancellation. | At most one automatic fallback on a classified model error, fresh session and review, old attempt revoked, model change visible, clean disk. No fallback after a command starts or the user cancels. |
| DEMO-GENERIC | Use a different repository, language and multi-file change request. | Agent chooses files through tools, pipeline works without the Flask task or file names in the implementation. |

## Official tasks and recording

Set up an editable Flask install from tag `3.1.3`, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Use separate clean checkouts or worktrees for A, B and C. Verify each checkout and its working directory with `git rev-parse HEAD` and `git status --short`. Confirm Python imports the pinned checkout before recording. Keep the Python environment and transient outputs outside the demo repositories or ignored. Use exact prompts from PDF pp. 4–5.

### DEMO-A Inline edit

1. Open `src/flask/helpers.py`, select `get_debug_flag`, invoke the keyboard shortcut and enter the PDF prompt.
2. Show the native diff and per-hunk controls. Review the condition and docstring. Pinned source treats unset, empty, `0`, `false` and `no` as false. The new false values are `off` and `n`, also case-insensitive. Accept the correct patch.
3. Verify `False` on screen. In PowerShell, run the following with the demo Python environment active. In rehearsal also test `OFF`, `N`, the previous false cases and a true case.

```powershell
$env:FLASK_DEBUG = 'off'
python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
Remove-Item Env:FLASK_DEBUG
```

4. Show VANTA's tested undo action and restoration of the prior state. Keep the required Task A `False` verification visible before undo.

### DEMO-B Autonomous agent

1. Use an empty editor context and a fresh Agent Studio session. Paste the PDF prompt with no filenames or mentions. Show genuine streaming, discovered files and context reasons.
2. Review and accept the intended hunks at the native approval pause. Confirm the documentation hunk is present. After the turn completes, show the Task B trace with session ID, representative search/read/stage calls, the approval and deferred tool discovery. Check that at least three distinct files changed and the agent located them without a hidden task-specific hint.
3. On screen run `pytest tests/test_cli.py -q`, show `flask --help` with `config`, and run `flask --app <demo-app> config` against a prepared app with fake secret-like values. Show valid JSON, `***` for the four key patterns and an ordinary value intact.
4. Record a short separate interrupted generation after the successful B verification if time allows. Show Cancel and the before/after workspace state (on a clean rehearsal worktree or unchanged B baseline) and record it in the rubric scorecard. Preserve the A→B→C order and the successful prompt-to-diff sequence.

### DEMO-C Resilience

1. Use the clean C checkout. Switch the primary TrueForge profile to an intentionally unreachable provider endpoint or invalid disposable credential. Keep a working independently configured secondary if testing the highest anchor. Use a provider-level failure so the TrueForge server remains reachable.
2. Repeat A and show that the editor stays responsive. Show the failure message or automatic secondary-model switch. Keep any resulting diff staged. Record `git status` and verify clean disk, unchanged buffers and an intact harness session. Reset the demo profile afterwards.

## Release verification

| Case | Evidence required |
| --- | --- |
| RELEASE-01 | Clean Windows clone, local `npx @truefoundry/trueforge@latest` setup, agent definition loading and example model config. Build and install/launch the extension. Exercise two models, scan commit history and tracked files for secrets, verify license and reuse declaration, and test public access. |
| RELEASE-02 | Time a complete recording at four minutes or less. A, B, C in order, verification after each, true B session visible, prompts and diffs legible. Observe PDF editing rules. Verify any extra undo/cancel evidence fits the cap. Test the video link while signed out. |
| RELEASE-03 | Open the 1–3 page PDF, check exactly eight headings in official order and verify each claimed scorecard timestamp. Record exact model/profile, location, approximate cost, switching, AI tools, trade-offs and limitations. Test public link access. |
| RELEASE-04 | Team verifies registration, current portal deadlines and all public links before upload. Record the portal receipt and final revision when submitted. |

Keep private rehearsal traces minimized and redacted. For each demonstrated case record extension commit, OS/VS Code, TrueForge/SDK versions, model profile, fixture revision, actual result and recording time. Use synthetic configuration values and exclude headers, credentials and actual private source from public evidence.
