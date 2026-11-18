# VANTA roadmap

M0 is the documentation milestone. M1–M8 are proposed. The contest window is short. Registration closes **15 November 2026** and Round 1 entries are due **20 November 2026, 23:59 IST**. Confirm the team's registration and set aside time to rehearse and export the three required artifacts. [Official competition page](https://techfest.org/competitions/forge-a-thon).

| Milestone | Depends on | Scope | Exit evidence |
| --- | --- | --- | --- |
| M0 Requirements and design | Supplied PDF, repository inspection, upstream source | Define boundaries, eligibility, anchors and tests. | Six planning docs, consistent case references, documented source and runtime baseline. |
| M1 Desktop scaffold | M0 | Strict TypeScript, npm lockfile, extension host activation, keybinding and input, lean Studio view, typed message boundary, Windows debug launch and integration runner. Keep setup and view responsive with no server present. | Extension Development Host opens on Windows. Build, typecheck and EXT-01 pass. Live output and evidence require M2. |
| M2 TrueForge and contract checks | M1 | Add pinned SDK adapter and health panel. Create a real session and turn, render SSE and terminal state. Use a narrowly scoped echo connector to test authenticated loopback and a gated call. Verify subscription and native cancel on the target server. | TF-01 through TF-03 pass. Save redacted event and pause/cancel traces with versions. Gate M3 and M4 on confirmed connector and approval behavior. |
| M3 MCP and context | M2 | Add confined root and live buffer reads, search, mentions, symbol fallback, context budget and explanations. Verify deferred discovery on the Windows path. | CTX-01 through CTX-03, MCP-01, SEC-01 and initial TF-04 pass on large fixtures. Show content reason and budget ledger. |
| M4 Quick Edit and diff review | M2 pause contract and M3 scoped read | Stage one selection-scoped proposal, present a native diff, gate reviewed hunks, and apply one undoable buffer edit. Rehearse fixed Task A. | Single-file EDIT-01 and EDIT-02, MCP-02 and DEMO-A. The multi-file recovery checks in EDIT-03 belong to M5 and M6. [Evidence](M4_VERIFICATION.md). |
| M5 Autonomous Agent Studio | M3 and M4 | Discover and stage existing files, review native diffs and verify the approved revision with a scoped pytest profile. Instantiate the versioned TrueForge agent from the extension. | MCP-03, TF-04, DEMO-B and DEMO-GENERIC. See the [verification report](M5_VERIFICATION.md) for observed results. |
| M6 Resilience | M2 transport, M4 staged commit and M5 command runner | Bound retry/reconnect, finish cancellation at local and remote boundaries, fault-inject recovery and verify one automatic secondary-model attempt. Run Task C. | Record primary failure, fallback status and a clean worktree. [Observed Task C and offline results](M6_VERIFICATION.md). |
| M7 Demo and submission readiness | Working M4–M6 flows | Prepare the timed demo and technical write-up, audit Windows setup and fix demo-blocking UI issues. | [Demo script](DEMO_SCRIPT.md), [recording checklist](DEMO_CHECKLIST.md) and [M7 verification](M7_VERIFICATION.md). Official Task B remains incomplete. |
| M8 Competition verification and submission package | M4–M6 and legible core UI | Clean-clone validation with local `@latest`, exact prompts and regular/alternate model checks. Record evidence, make the public links and prepare the timestamped write-up. | RELEASE-01 through RELEASE-04. Confirm all three links and deadlines with the team. |

Run typecheck, build and relevant tests at each implementation milestone. Keep each milestone committable. Capture runtime evidence only after executing the case on the target stack.

## Critical path to Round 1

1. Time-box the scaffold and verify the source-backed SDK, connector and native approval contracts early in M2. Mix local fake-service tests with a real TrueForge smoke test. Keep the first Studio limited to input, output, connection and cancel.
2. Make one Quick Edit instruction travel all the way through a live harness pause to a safe editor diff. Confirm reject, apply and undo. Expand into complete Task B only after the same review path safely supports multiple files.
3. Rehearse C against a separate clean checkout as soon as staging is reliable. Verify clear failure before adding automatic fallback. Reserve the remaining time for the alternate model, graceful failure, visible context reasons and native tool approval evidence.
4. Begin artifact preparation while testing the fixed tasks. Prioritize exact prompts, clear verification and compliance over secondary UI features. Recovery, trust, approvals and eligibility remain core gates. Preserve time to view the resulting public links as a judge.

## Risk register

| Risk | Earliest check | Response |
| --- | --- | --- |
| Windows loopback, dynamic connector auth or MCP discovery fails | M2 register a minimal connector and trace discovery/call and headers. | Use an explicitly configured local connector with per-run authorization if dynamic provisioning is unreliable. Keep the native host boundary. Reject a configuration that exposes editor capabilities without auth. |
| Native gate, event cursor or source-call payload differs by version | M2 real gated echo tool and reconnect. | Use the source-matched pair and compare latest in a clean run. Use documented HTTP for an SDK-specific defect. Keep review/command eager if deferred argument mapping fails. |
| Weak tool calling, context overruns or limited free quota jeopardizes B | M2 tool-call probe; M3 budget/ranking fixture; M5 repeated blind Task B. | Tune tool descriptions and evidence budgets using observed traces. Compare supported models through TrueForge. Prefer one proven no-paid primary path and an independently testable secondary profile. |
| Partial or stale edits, save-time formatters or external races | M4 fault tests around commits and undo. | Preserve pre/post journals and repair only matching writes. Surface conflicts and keep unsupported mutation types out of scope. |
| Approved test profile escapes expected project effects or leaves a child process | M5 process termination and snapshot fixture. | Start with trusted runtime and explicit profiles, isolate routine writes in disposable snapshots, confirm process termination and disclose OS isolation limits. |
| Fallback error shape is ambiguous or can duplicate side effects | M6 injected auth, network and ambiguous turn/approval cases. | Reconcile and revoke old grants. Fall back once only for a classified provider failure with no executed command and no applied changes. Record the evidenced rubric anchor. |
| Timing or editing rules limit recording space | M5 dry recording with real latency and undo/cancel evidence. | Prepare clean, independent worktrees and concise verification commands. Keep optional UI details out of the video and retain a legible prompt-to-diff sequence. |

See [Test strategy](TEST_STRATEGY.md) for case IDs and [Decisions](DECISIONS.md) for trade-offs and unknowns.
