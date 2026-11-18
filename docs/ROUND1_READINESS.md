# Round 1 readiness audit

**82/100 on the evidence available on November 18, 2026.** This is a rehearsal estimate. The judges score the final public artifacts and their eligibility checks. [Official rubric, PDF pp. 6–9](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf#page=6)

| Criterion | Marks | Evidence and work remaining |
| --- | ---: | --- |
| A1 Inline editing | 10/10 | Native Quick Edit renders a real VS Code diff with individual hunk decisions. The exact Task A approved proposal passed all 24 behavior cases and the docstring check. |
| A2 Agent mode | 10/10 | One verbatim Task B request independently located the CLI, tests and documentation. Both approval gates ran. The saved CLI tests, help, masked JSON and built-in documentation placement passed. |
| A3 Streaming and cancellation | 10/10 | The live Windows host streamed Gemini text and called Stop during generation. Local cancelling state appeared in 5.11 ms. TrueForge acknowledged termination and Git stayed clean. Show it on screen for the judged anchor. |
| B1 Context assembly | 15/15 | The passing Task B trace shows reasons and file ranges in its first bundle, with 3,256 estimated tokens used out of an 8,000-token budget. Studio exposes those reports in Context Explorer. Show the budget and evidence on screen. |
| B2 Diff safety | 10/10 | Native per-hunk review, save and targeted Task A undo were verified, including preservation of an unrelated dirty buffer. Show undo in the recording. |
| B3 Resilience | 10/10 | The exact Task C run used an unreachable primary. A working Gemini backup automatically produced a valid native diff, a discarded proposal left Git clean, and an unrelated unsaved edit survived. Show the same behavior in the recording. |
| B4 TrueForge integration | 7/10 | The passing B trace shows real MCP tools and both TrueForge approvals. The B discovery tools were preloaded. A live Quick Edit session separately proved deferred tool lookup and a real read. Show that invocation and explain what it saved or enabled before claiming 10. |
| C1 Video | 0/10 | No final recording was reviewed. Record A, B and C in order with their on-screen checks and the matching B session. |
| C2 Write-up | 10/15 | The draft covers architecture, trade-offs and known limits. Actual timestamps and the confirmed roster are pending. |
| **Total** | **82/100** |  |

## Verified sessions

| Evidence | Local TrueForge session |
| --- | --- |
| Task A native pass including saved undo | `01m7hpy7qrsxx9dywp780r3ddm` |
| Task A with a genuine deferred file read | `01m7pey6v6a0bsa8csdsv2abvj` |
| Task B with correct built-in section placement and 60 tests | `01m7phecrcsx83s5wj1e73mbkd` |
| Task C unreachable primary then working backup | `01m7ph8gf9rywjeq3gerbgq3ka` and `01m7ph8gq9bnr9vtr2ra5cq1mk` |
| Stop during live streaming | `01m7phj68c40abyjqqys2h2ybs` |

## Release and submission

- Use the [public `main` branch](https://github.com/vikram144f-cyber/Vanta/tree/main) for the submission. Verify that a signed-out download contains the revision used in the recording.
- Record the [four-minute demo](DEMO_SCRIPT.md) and complete the [submission checklist](DEMO_CHECKLIST.md). Confirm the roster, declared model costs and tools, and actual timestamps. Export the final 1–3 page PDF.
- Submit the publicly accessible GitHub, video and PDF links by **November 20, 2026, 23:59 IST**. Team ID and submission receipt must be checked in the competition portal. [Official submission rules](REQUIREMENTS.md)
