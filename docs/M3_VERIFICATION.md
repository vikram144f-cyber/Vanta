# M3 verification

Verified on Windows 11 with TrueForge 0.185.1, SDK 0.185.0, VS Code 1.144.1 and the configured `google-gemini/gemini-3-5-flash-lite` model. The local TrueForge network policy and exact loopback allowlist stayed enabled. The Flask checkout was pinned to `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. `git status --porcelain` was empty before and after the run.

| Check | Result |
| --- | --- |
| Unnamed Flask discovery | The genuine context bundle returned `src/flask/cli.py:607–629`, `tests/test_cli.py:322–344` and `docs/cli.rst:419–441`. These came from an implementation/test/docs question without file names. |
| Deferred tools | TrueForge session `01m7cvp69ja3thmj4m57efkne2` emitted `list_tools`, `get_tool_info` and `call_tool`. The MCP bridge returned the repository evidence from that call. |
| Follow-up and symbol | The same session resolved `get_debug_flag` to `src/flask/helpers.py:28` through the declaration fallback. The next turn also retained the session and resolved explicit file and scoped symbol references. |
| Baseline streaming and approval | Two live suites passed. The short chat emitted four incremental updates in the passing run. Native MCP Allow, Reject and Stop during an approval pause passed. |
| Local limits and isolation | Unit and HTTP transport tests cover ignore rules, traversal, a junction escape, suspicious names, credential redaction, missing and ambiguous references, nested declarations, budget omissions, repeat bundles, turn reuse, cleanup and missing sharing consent. |
| Windows extension host | The real Extension Development Host activated VANTA and executed its three commands. |
| Windows Context Explorer | In the native sidebar, enabling workspace context and asking an unnamed CLI question showed all three Flask locations, filename reasons and the estimated budget. Clicking the implementation location opened `cli.py` in the editor. |

An earlier run exhausted the agent iteration limit after repeated reads. A subsequent run completed discovery but was rate-limited after returning symbol evidence. The passing run followed a narrower agent instruction that asks it to answer directly from a discovery bundle. A later repeat passed all three Flask turns again, then Gemini rate-limited the separate overview regression suite after its streaming check. The extension reports rate or quota errors without displaying raw provider data.

## Reproduce

Start TrueForge using the [Windows setup](../README.md) and select a configured model. Clone Flask into a separate folder and check out `3.1.3`. In PowerShell from this repository run:

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:extension
$env:VANTA_FLASK_ROOT = 'C:\path\to\clean\flask'
$env:VANTA_LIVE_MODEL = 'google-gemini/gemini-3-5-flash-lite'
$env:VANTA_LIVE_MCP = '1'
npm.cmd run test:live
```

For sidebar verification, launch VANTA in an Extension Development Host and open the pinned Flask checkout as the only trusted folder. Check **Share workspace context**, ask which parts implement built-in CLI commands and their tests and docs, and open a reported location from Context Explorer. Re-enable sharing for each new turn that needs repository data. Ask for `get_debug_flag`, then try `@symbol:src/flask/helpers.py#get_debug_flag` and `@file:docs/cli.rst`. Confirm the session identifier stays the same and that Flask remains clean.

M3 exercises the read-only discovery portion of the competition. The next milestone is native Quick Edit, staging and guarded hunk review. [Context engine](CONTEXT_ENGINE.md), [roadmap](ROADMAP.md).
