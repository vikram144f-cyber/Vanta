# M3 repository context

## Refined M3 brief

Implement read-only repository discovery in VANTA on TrueForge 0.185.1. Reuse the current session for follow-ups, chain from the last completed turn, and rotate the MCP endpoint and bearer secret on every turn. Preserve streaming, cancellation and native approval for workspace overview. Require explicit consent before sharing new workspace context with TrueForge and its model.

Expose bounded filename and text search, symbol navigation, snippet reads, and deterministic task-based ranking through the authenticated MCP bridge. Resolve explicit file and symbol references before sending. Show returned paths, locations, reasons and estimated budget use in Context Explorer. Keep reads inside one trusted local workspace and make file discovery work without ripgrep.

On the pinned Flask checkout, prove that a prompt with no filenames returns implementation, test and documentation locations. Show actual deferred discovery and invocation in TrueForge. Resolve `get_debug_flag` and explicit references in follow-up turns under the same session ID. Confirm the checkout stays clean. Run unit, HTTP transport, native Windows extension and live TrueForge checks. Label unverified behavior and leave file editing and command execution for later milestones.

## Use Agent Studio

- Check **Share workspace context** before sending a repository question. It applies to new repository reads on that turn. Previously shared text can remain in TrueForge conversation history. **New conversation** clears the view and starts a new session on the next submission.
- Use `@file:src/module.py`, `@file:"docs/user guide.md"`, `@symbol:entry_point`, or `@symbol:src/module.py#entry_point`. Quote references with spaces. Add file opens a searchable native picker. Resolve missing or ambiguous references before submitting. A workspace scan that reaches its cap requires a file-scoped symbol mention.
- **Context Explorer** displays the 12 latest retrieval reports with paths, line ranges, signals, estimated usage and omissions. Clicking a location opens it after a fresh workspace check. The labels describe what VANTA returned, which can include matches that the model did not mention in its answer.

## Discovery and budget

| Tool | Use |
| --- | --- |
| `list_workspace_files` | Up to 35 paths matching an optional literal path fragment. |
| `search_workspace` | Up to 30 filename or literal case-insensitive text matches with line numbers. |
| `read_file` | Up to 60 lines from a validated path, with 1-based inclusive locations. |
| `find_symbol` | Up to 24 exact or partial declaration matches, optionally scoped to a file. |
| `get_context_bundle` | Up to 12 ranked snippets, usually 23 lines each, with reasons. |

Catalog discovery uses an absolute ripgrep executable found outside the workspace. The fallback performs a bounded, sorted directory walk. Both apply local `.gitignore` rules, workspace containment and file exclusions. The catalog holds up to 1,200 files. Content scoring inspects up to 260 candidates, ordered by task terms in paths. Search uses literal matching over the same bounded, validated UTF-8 reads. Windows does not require ripgrep on PATH. The fallback checks at most 5,000 directory entries. Global ignore rules are outside this policy.

Ranking combines filename tokens, task terms on the strongest matching line, exact names in declarations and lexical import references. It prioritizes a result from each of implementation, tests and docs when those groups qualify. Import references and related filenames are signals for ranking and do not establish a resolved dependency graph. Overlapping repeated bundle results are omitted within a turn. Explicit reference excerpts merge when the result fits within 60 lines.

VS Code document and workspace symbol providers supply function, class and method ranges when available. The bounded Python and JS/TS declaration fallback reports the actual matched line. The fallback lacks a full parser and does not classify every method or distinguish every declaration from a string or comment. Dirty buffers for eligible existing files take precedence over disk.

Set `vanta.contextBudget` from 2,000 to 16,000 estimated tokens. The default is 8,000, with up to half available to explicit references and 60% to an individual bundle. The shared ledger charges serialized payload bytes divided by three plus a small envelope allowance. Follow-up calls share the remaining budget. This measures repository payloads only. Actual provider usage also includes prompt, conversation history and TrueForge tool overhead. The bridge permits one repository tool call at a time, at most 24 per turn, and applies a 7.5-second tool deadline and a 96 KiB file cap.

## Sessions and security

The session is bound to the TrueForge origin, agent or model, workspace scope and tool setting. Follow-up turns use the documented `previousTurnId` of the last completed turn. A failed or stopped turn does not advance history. If cancellation cannot be confirmed, the next submission opens a new session. Turn POSTs are never automatically replayed. Each turn gets a fresh loopback port and bearer secret. VANTA registers that endpoint under the conversation's connector name and removes it after closing the listener. The stateless transport keeps a late request to an old endpoint from inheriting the next turn's credential.

The overview is eager and retains its native one-use approval. The repository tools are deferred and require the current turn's sharing consent in the host. File checks reject hidden and suspicious names, ignored paths, links, hardlinks, rooted paths, traversal and Windows device or stream syntax. A line-based credential filter is defense in depth. Share only repositories permitted for your configured model. The filesystem checks assume a trusted, stable workspace and do not provide OS sandbox isolation against concurrent hostile filesystem changes. [TrueForge deferred loading](https://trueforge.dev/key-features/deferred-tool-loading), [pinned resource resolver](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge-core/src/agent-session/TurnResourceResolver.ts), [VS Code symbol commands](https://code.visualstudio.com/api/references/commands).
