# Windows vertical slice verification

Verified on 14 November 2026 with Windows 11, VS Code 1.144.1, Node.js 22.17.0, TrueForge server 0.185.1, `@truefoundry/trueforge-sdk` 0.185.0 and `google-gemini/gemini-3-5-flash-lite` as listed by the local server. TrueForge was run locally, with workspace inspection explicitly enabled by the user's loopback allowlist. The Gemini model was already configured in TrueForge.

| Acceptance item | Observed result |
| --- | --- |
| Compiles and activates | Strict TypeScript, lint and build passed. The Extension Development Host suite activated the extension and executed the open, Quick Edit placeholder and cancel commands. |
| Sidebar and prompt submission | The VANTA activity bar icon opened Agent Studio. The live sidebar accepted Enter and Send, and switching to Explorer and back restored the transcript. |
| Local session and configured model | Live SDK test created a session on port 8790 and received four incremental assistant updates for the two-sentence prompt. The sidebar displayed the session ID. |
| Visible streaming | A longer prompt produced 18 separately observed sidebar text updates, growing from 2 to 2,287 characters. Short, fast responses can be painted in a single update. |
| Connection errors and responsiveness | The controller displayed an actionable offline state when port 8790 was unreachable. Sidebar switching and interactive controls worked in the native Windows development host. |
| MCP allow and rejection | The live Gemini test paused on `get_workspace_overview`. Allow returned the actual fixture folder name. Reject withheld it. Both outcomes also passed through the sidebar buttons. |
| Cancellation | Stop at a live approval pause cancelled the TrueForge run and produced no workspace result. The same outcome was observed through the sidebar. Mid-generation end-to-end cancellation and recovery are broader later-milestone cases. |
| Tool safety and cleanup | Automated tests covered auth, origin, one-use authorization, revoked workspace scope, sensitive names, a junction, cancellation and connector disposal. The live suite observed no cleanup error. |

`test/unit/` contains deterministic controller fixtures and a local MCP transport test. `test/extension/` runs the commands inside a real Extension Development Host. `test/live/` drives the configured TrueForge model through the same extension-host controller and MCP implementation. The separately exercised sidebar run used a synthetic workspace. [Run instructions](../README.md).

## Contract findings

- Default TrueForge rejected connector registration with HTTP 400 and `Outbound URL blocked for host "127.0.0.1"`. Chat continued without the tool. With `127.0.0.1` expressly allowed, native TrueForge Connector registration, header authentication and Streamable HTTP discovery worked on Windows. [TrueForge connector API source](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge/src/apis/mcpServers.ts).
- Eagerly load the first tool and gate it by literal name. The controller resolves the approval against the originating tool call and sends allow or deny through `sessions.createTurnEvents`. The live test verified allow, deny and cancel on v0.185.1. Deferred tools are later milestone work. [TrueForge session SDK source](https://github.com/truefoundry/trueforge/blob/v0.185.1/packages/trueforge-sdk/src/api/resources/sessions/client/Client.ts).
- VS Code provided a lowercase Windows drive letter for the workspace URI. Normalizing the drive letter before comparing canonical paths fixed the live host. Junction paths remain excluded.
- Sessions are fresh per request and the displayed history is in memory. Automatic follow-up context, general reconnect, multi-model fallback and crash-time cleanup of inactive connector records remain outside this slice. A stale connector from an abrupt host exit loses its listening endpoint and can be removed in TrueForge Settings → Connectors.

The next milestone is M3 context assembly on the proven connector path. Keep the first tool read-only while expanding bounded search, symbol lookup and transparent context selection.
