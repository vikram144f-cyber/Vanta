# VANTA competition requirements

## Source and scope

- Primary source is the supplied 13-page *Techfest 2026–27 TrueFoundry Forge-a-thon* PDF, SHA-256 `5feeee151edc6bf098743e6eaf5e87b8996adc7bc13abbe1fc8409074d6ddb49`. Page references below use the PDF page count. The attachment was read from Downloads because `docs/competition.pdf` was absent. The public copy has the same SHA-256 hash. [Official competition PDF](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf), [event page and dates](https://techfest.org/competitions/forge-a-thon).
- The PDF governs eligibility, judging and submission. The project brief adds TypeScript, Quick Edit, Agent Studio, no paid dependency, native Windows, recovery and the M0 documentation scope. The PDF's request to star TrueForge is an onboarding instruction for participants. Account actions, registration, uploads and submissions remain participant activities.
- The PDF excludes completion/FIM, model training or hosting as project scope, hosted VANTA infrastructure, accounts/authentication and Marketplace publishing. Participants may use a free, paid, gateway or local-compatible model configured in TrueForge. The project chooses a reproducible route without a paid API requirement.
- No competition behavior has been demonstrated by VANTA at M0. The milestones and case IDs below identify planned work. [Architecture](ARCHITECTURE.md), [roadmap](ROADMAP.md), [test strategy](TEST_STRATEGY.md).

## Eligibility and mandatory capabilities

| ID | Requirement and PDF page | Implementation milestone | Verification |
| --- | --- | --- | --- |
| E1 | Desktop VS Code extension, TrueForge owns the loop, session and turn calls through SDK or HTTP, real stream in editor (pp. 1–2, 6). | M1 host and M2 adapter and streamed UI. | EXT-01, TF-01, TF-02, DEMO-A and DEMO-B. Inspect agent loop boundary. |
| E2 | Agent chooses when to read, search, propose writes and run commands through MCP (p. 6). | M3 authenticated editor bridge, M4 proposal checkpoint, M5 command profiles and multi-file run. | MCP-01, MCP-02, MCP-03, DEMO-B. |
| E3 | Local TrueForge quickstart setup, optional sandbox (pp. 4, 6–7). | M2 source-matched integration and native Windows baseline. M8 local `@latest` rehearsal and clean setup README. | TF-01, RELEASE-01. |
| E4 | Configured model provider or OpenAI-compatible model through TrueForge. Provider portability and zero direct model requests (pp. 2–3, 7, 11). | M2 profile settings, M6 secondary model and safe fallback. | TF-01, REL-03, DEMO-C, RELEASE-01. Prepare for organiser-chosen model. |
| E5 | TrueForge Task B session shows turns and tool calls, and used agent definition is in public repo (p. 7). | M5 versioned redacted agent definition/template and exact load instructions, M8 screen evidence. | DEMO-B, RELEASE-01 and RELEASE-02. |
| F1 | Select code, use keyboard shortcut, give natural-language instruction, get a real editor diff and accept or reject (p. 2). | M1 command and M4 selection-scoped Quick Edit. | EXT-01, EDIT-01, DEMO-A. |
| F2 | Single panel request discovers and changes at least three unnamed files through a tool loop (p. 2). | M3 search and context, M4 staging, M5 Agent Studio orchestration through TrueForge. | MCP-01 through MCP-03, DEMO-B and DEMO-GENERIC. |
| F3 | Explicit `@file` and `@symbol`, automatic code retrieval and scored harness context features (p. 2). | M3 selection, ranking, budget and reasons, M5 deferred tool use. | CTX-01 through CTX-03, TF-04, DEMO-B. |
| F4 | Visible hunk previews, accept/reject per hunk before workspace writes, applied change can be undone (p. 2). | M4 native diff, revisioned approvals and guarded undo. | EDIT-01 through EDIT-03, MCP-02, DEMO-A. |
| F5 | Real incremental generation, mid-flight interrupt, responsive editor and consistent workspace (p. 2). | M2 event stream and cancel API, M6 end-to-end cancellation and recovery. | TF-02, TF-03, REL-01, DEMO-B recording evidence. |

## Fixed-task and submission traceability

M3 implements and tests the read-only retrieval path for F3 and B1, and exercises the deferred-loading portion of B4. These checks precede the official Task B editing and review demo. See the [context engine](CONTEXT_ENGINE.md) and [M3 verification](M3_VERIFICATION.md).

M4 implements the selection-scoped path for F1 and F4, and exercises native TrueForge approval for the B4 review requirement. [Task A and safety evidence](M4_VERIFICATION.md).

M5 implements existing-file Agent Mode, with separate TrueForge gates for patch review and a pytest profile. Local and live evidence for MCP-03, TF-04, DEMO-B and DEMO-GENERIC is tracked in the [M5 verification report](M5_VERIFICATION.md).

| ID | Requirement and PDF page | Delivery and verification |
| --- | --- | --- |
| D1 | Pinned `pallets/flask` tag `3.1.3`, commit `22d92470`. Task A uses `get_debug_flag`, handles `off` and `n` case-insensitively and lists every false value (pp. 4–5). | M4/M8. DEMO-A uses PDF wording, native review and an on-screen `False` check. |
| D2 | Task B adds built-in `flask config` with masked JSON for keys containing SECRET, PASSWORD, TOKEN or KEY, `--help`, test and documentation. At least three files, zero filenames in prompt (p. 5). | M5/M8. DEMO-B shows discovery, diff, session trace, CLI help, passing `pytest tests/test_cli.py -q` and masked JSON. |
| D3 | Task C repeats A with configured model failure, shows responsive editor and clear error or automatic fallback, and clean `git status` (p. 5). | M6/M8. DEMO-C uses a separate clean clone/worktree and leaves any fallback proposal unapplied for the clean check. |
| S1 | Public GitHub repo, clean-clone README with local TrueForge setup and agent definition loading, example model config, open-source license, fork point/attribution if applicable and no secrets (pp. 3, 6–7, 11). | M8 RELEASE-01. Current baseline is from scratch and MIT. Document any future reuse and changes. Declare approximate model cost and each AI tool used. |
| S2 | Public screen recording up to 4 minutes, A then B then C, with on-screen verification and the B session. Respect the PDF's edit rules (pp. 5–6). | M8 RELEASE-02. Plan the recording to preserve each prompt-to-diff sequence. Verify viewing without an authorised account. |
| S3 | Public write-up PDF, one to three pages, eight headings in specified order (p. 6). | M8 RELEASE-03. Use **Team**, **Starting point**, **Architecture on TrueForge**, **How context is selected**, **Model setup**, **Scorecard**, **Tools used**, **Known limitations and what you would do with another month**. Include team affiliations and GitHub handles, all models and where they ran, approximate costs and switching steps, harness choices, measured costs or estimates, per-criterion video timestamps and honest limitations. |
| S4 | Submit all three public links in Techfest Competition Portal by **20 November 2026, 23:59 IST**. Eligibility and registration apply (pp. 5–6, 10–12). | Team checks registration by **15 November 2026**, Team ID, all members age 18+ at registration with photo ID, team of up to five, one registration/team per participant, public links, declared reuse and original/licensed work. Confirm the latest portal details. M8 RELEASE-04. |
| S5 | Round 1 results 30 November. Shortlisted teams may repeat A live in a 10-minute call using the organisers' model and explain the code. Round 2 is 16–18 December at IIT Bombay and includes a TrueForge contribution PR (pp. 3, 9–11). | Prepare switch-model instructions and architecture walkthrough in M8. Treat finalist problem and PR as later scope once their brief is released. |

The optional social-media award operates separately from the technical score (pp. 9–10). The PDF describes permitted platforms, hashtags, the posting window and the organizer form. It is outside the Round 1 engineering milestones.

## 100-point rubric

These are targets. Judges pick the evidenced anchor and use the lower one for intermediate results. Use the recorded video to assign actual claims in the write-up.

| Criterion | Points | Evidence needed at the highest anchor | Planned cases |
| --- | ---: | --- | --- |
| A1 Inline editing | 10 | Real editor diff with per-hunk accept and reject. | DEMO-A, EDIT-01 |
| A2 Agent mode | 10 | TrueForge finds and edits at least three unnamed files in Task B. | DEMO-B, MCP-01 |
| A3 Streaming and cancellation | 10 | Visible genuine deltas, immediate interruption and consistent workspace. | TF-02, REL-01, DEMO-B recording segment |
| B1 Context assembly | 15 | Bounded retrieval, documented strategy and visible file selection with reasons in Task B. | CTX-01 through CTX-03, DEMO-B |
| B2 Diff safety | 10 | Per-hunk review and working undo shown on screen. | EDIT-01 through EDIT-03, DEMO-A |
| B3 Resilience | 10 | Automatic switch to a second configured model, workspace unchanged. Clear error earns the 4-point anchor. Backoff followed by clear error earns 7 if demonstrated. | REL-02, REL-03, DEMO-C |
| B4 TrueForge integration | 10 | MCP capabilities and TrueForge tool approval visibly drive diff review, plus meaningful use of deferred tool loading or another named harness feature visible in the session and explained in the write-up. | MCP-02, TF-04, DEMO-B |
| C1 Video | 10 | All tasks complete, legible, ordered and visibly verified. | RELEASE-02 |
| C2 Write-up | 15 | Architecture and trade-offs, context, model setup, accurate timestamp scorecard and honest limitations. | RELEASE-03 |

## VANTA project requirements beyond the official wording

| ID | Requirement | Delivery and verification |
| --- | --- | --- |
| V1 | Strict TypeScript, keyboard-first Quick Edit, accessible Studio UI with activity, diagnostics, tests, history, model settings and connection status. | M1/M2/M4/M5/M7 and EXT-01 through EXT-03. |
| V2 | Workspace-bound paths, untrusted inputs, no secrets in telemetry, safe command approval, recoverable mutations and undo. | M3/M4/M5/M6 and MCP-02, MCP-03, SEC-01 through SEC-03, EDIT-02 and EDIT-03. |
| V3 | Native Windows, budgeted retrieval with dependency expansion and deduplication, retries and configurable provider-neutral fallback. | M3/M6 and CTX-01 through CTX-03, REL-01 through REL-03, RELEASE-01. |
| V4 | General-purpose behavior on arbitrary coding prompts. Flask fixture instructions live in verification materials. | M5 DEMO-GENERIC. Verify distinct repositories and models during rehearsal. |
