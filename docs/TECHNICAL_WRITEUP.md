# VANTA

TrueFoundry Forge-a-thon · Round 1 technical write-up draft

## Team

**Hex Appeal.** Member names, affiliations and GitHub handles await confirmation.

## Starting point

Built from scratch as an MIT-licensed Windows VS Code extension. VANTA uses the TrueForge TypeScript SDK, MCP SDK, React and VS Code APIs. The evaluation workspace is a separate checkout of Flask 3.1.3 at `22d92470`.

## Architecture on TrueForge

The desktop extension creates sessions on local TrueForge 0.185.1 through SDK 0.185.0 and streams events into Agent Studio. TrueForge owns generation, tool selection and approval events. VANTA exposes bounded reads, search, symbol lookup, staging and an approved pytest profile through a per-attempt authenticated loopback MCP connector.

Quick Edit captures the editor selection and opens a native diff. Agent Mode stores proposals until the user reviews the exact hunks. An independent approval permits pytest in an isolated snapshot with the accepted edits. After verification and terminal success, the host applies to editor buffers and leaves saving to the user. Undo checks the recorded source state. This costs a second approval but keeps arbitrary command execution and automatic disk writes out of the workflow.

### TrueForge Integration — Deferred Tool Loading

VANTA uses TrueForge's deferred tool loading to reduce upfront tool-schema context while retaining access to additional repository information.

In Quick Edit, frequently used editing and review tools are preloaded, while TrueForge loads the full definitions of `read_file` and `find_symbol` on demand.

A verified live Quick Edit session recorded `list_tools` → `get_tool_info(read_file)` → `call_tool(read_file)`, successfully retrieving source code from `src/flask/helpers.py`.

Agent Mode preloads `get_context_bundle` and `read_workspace_ranges` because repository-wide tasks typically require immediate context discovery.

This design reduces the initially exposed tool definitions without sacrificing access to missing context.

## How context is selected

VANTA ranks candidate files with task terms, declarations, filename matches and related tests or docs. It uses explicit references when supplied, deduplicates ranges, and explains each selection. Agent Mode defaults to an estimated 8,000 source tokens and eight repository calls. The verified Task B first bundle used 3,256 estimated tokens.

## Model setup

The passing Task B used Google-hosted Gemini 3.5 Flash Lite. Task A passed with Gemini 3.5 Flash and Flash Lite Latest. Task C used an unreachable loopback primary and succeeded with Gemini Flash Lite Latest as the backup. Rehearsals also tried Gemini 3.6, 3.7 and 3.8 Flash, Flash Latest, Gemma 4 31B, Groq-hosted GPT-OSS 120B and Qwen, and local Ollama Qwen 3.5 4B. Local and mock calls had zero external API cost. Some hosted runs used free-tier allowances. Aggregate billing awaits confirmation.

Register providers in TrueForge and select a profile in Agent Studio. Configure a different `vanta.secondaryModel` to allow one automatic switch after a confirmed early provider failure. The new session uses the original request and fresh approvals.

## Scorecard

Final video timestamps await the recording. These rows describe verified rehearsals and the remaining evidence.

| Criterion | Video time | Evidence |
| --- | --- | --- |
| A1 Inline editing | Pending | Native Quick Edit diff with per-hunk controls. |
| A2 Agent mode | Pending | One exact Task B prompt found and edited three files. The saved result passed 60 tests and the CLI checker. |
| A3 Streaming and cancellation | Pending | Live mid-stream Stop, local indication in 5.11 ms, TrueForge cancellation and clean disk. |
| B1 Context assembly | Pending | Task B showed file-selection reasons, source ranges and an 8,000-token estimated budget. |
| B2 Diff safety | Pending | Per-hunk decisions and native undo restored the saved Task A helper. |
| B3 Resilience | Pending | Unreachable primary, automatic live backup and clean Git after discard. |
| B4 TrueForge integration | Pending | Two native TrueForge approval gates in B. Genuine deferred file read in a separate Quick Edit. |
| C1 Video | Pending | A, B and C in order with checks and the matching B session. |
| C2 Write-up | Pending | Add final timestamps and confirm roster and costs. |

## Tools used

VS Code, Node.js, TypeScript, React, esbuild, PowerShell, Git, Python, Ruff, pytest and ReportLab. OpenAI Codex assisted implementation, verification and writing. TrueForge performed model calls.

## Known limitations and what you would do with another month

Agent Mode edits existing files in a single trusted local workspace and verifies through a configured Python profile. Hosted models can hit quotas or return incomplete proposals. A failed test stops application and requires a fresh review to revise. Fallback is limited to failures before model output or tool activity. Recent conversations are stored per workspace with bounded, redacted transcript text. Historical approvals and verification grants expire with their run. A month of follow-up would go to measured provider comparisons, richer verification profiles and safe recovery within one original request.
