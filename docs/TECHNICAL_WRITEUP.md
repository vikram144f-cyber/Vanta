# VANTA

TrueFoundry Forge-a-thon · Technical write-up

## Team

Hex Appeal. Member names, college or employer, and GitHub handles are pending team confirmation.

## Starting point

Built from scratch as an MIT-licensed VS Code extension. VANTA uses TrueForge, React, the Model Context Protocol SDK and VS Code APIs. Flask 3.1.3 at `22d92470` is a separate evaluation checkout. The project does not fork Flask or TrueForge.

## Architecture on TrueForge

VANTA brings a local TrueForge coding agent to Windows VS Code. A strict TypeScript extension host creates inline sessions through SDK 0.185.0 against TrueForge v0.185.1. It streams events to Agent Studio. TrueForge runs the model loop, selects tools, pauses on tool approvals and records the turn. The extension makes no direct provider requests.

Each workspace-enabled run uses an authenticated Streamable HTTP MCP connector on loopback. The connector exposes bounded reads, search, symbol lookup, proposed edits, review and a restricted pytest profile. Deferred discovery reduces the tool descriptions sent up front and lets the model request the repository tools it needs.

Quick Edit captures a source selection and opens a real VS Code diff. Agent Mode stages edits across files. VANTA binds an approval receipt to the staged revision, file fingerprints and accepted hunks. A separate approval permits pytest in a disposable snapshot with only the accepted edits. The successful check and completed turn are required before Agent Mode writes to editor buffers. Save remains explicit. Undo checks the recorded file state before restoring a patch.

## How context is selected

Context starts from the selected code, explicit `@file` and `@symbol` references, or model-requested repository discovery. VANTA confines reads to one trusted workspace, excludes ignored and sensitive paths, and ranks candidates using filename, task, symbol and related test or documentation signals. It groups focused ranges, deduplicates previously shared ranges and records why each excerpt was selected. The default repository context budget is an estimated 8,000 tokens. Agent Mode shares eight repository discovery or read calls per run. Context Explorer makes the estimates and source locations visible.

## Model setup

The native Task A pass used Google-hosted Gemini 3.5 Flash. The passing invoice adapter used Google-hosted Gemini 3.5 Flash Lite. Task C used a loopback OpenAI-compatible fixture returning HTTP 503 through TrueForge, with zero external model API cost. Other hosted rehearsals are listed in the M5 evidence. The logs show free-tier limits on some hosted runs. Aggregate API charges were not measured.

Configure providers and credentials in the local TrueForge dashboard. Select a registered profile in Agent Studio and refresh the list after a provider change. An optional secondary profile is only eligible for a confirmed early failure and starts with fresh local authority.

## Scorecard

The timestamps below are planned. Replace them with exported-video timestamps before submission. The fixture is evidence of a general workflow. Official Flask Task B remains incomplete.

| Criterion | Planned time | Evidence and limit |
| --- | --- | --- |
| A1 Inline edit | 0:17–1:37 | Task A native diff and separate hunk decisions. |
| A2 Agent mode | 1:37–2:47 | Three-file invoice adapter pass. Official Flask Task B has no acceptance pass. |
| A3 Streaming and cancellation | 0:17–1:37 | TrueForge output streams in Studio. Cancellation has targeted tests. Live cancellation is not in the planned cut. |
| B1 Context assembly | 1:37–2:47 | Recorded traces show bounded MCP discovery and source selection. |
| B2 Diff safety | 0:17–1:37 | Approved Task A save and targeted undo restored the original SHA-256. |
| B3 Resilience | 2:47–3:42 | Native local HTTP 503. Clear recovery message, responsive editor and clean disk. |
| B4 TrueForge integration | 1:37–2:47 | Recorded deferred MCP discovery and two separate approval gates. |
| C1 Video | 0:00–3:55 | Timed plan in A, B, C order. Official B evidence is incomplete. |
| C2 Write-up | — | This document records architecture, tests, trade-offs and limitations. |

## Tools used

VS Code and its Extension Development Host, Node.js, TypeScript, React, esbuild, PowerShell, Git, Python and pytest. OpenAI Codex assisted implementation, verification and documentation. TrueForge orchestrated the Google Gemini and Gemma model attempts. The M7 validation uses local fixtures and avoids provider API calls.

## Known limitations and what you would do with another month

Task A passed 24 behavior cases and a native Save and Undo. The non-Flask invoice adapter passed snapshot pytest with two tests and exercised three staged files. Official Flask Task B did not pass acceptance. Attempts stopped on quota or provider failures or produced incomplete or invalid code. The failed syntax proposal reached pytest and application stayed blocked. Task C verified a clear native recovery path. Successful fallback to an external provider remains unverified.

Agent Mode is limited to existing files in one trusted local workspace and the configured pytest profile. Snapshot isolation protects the original editor files during verification. A trusted pytest profile still runs code with the user's privileges. Additional time would go to official Task B acceptance with a suitable model, measured cost and latency, and live fallback verification.
