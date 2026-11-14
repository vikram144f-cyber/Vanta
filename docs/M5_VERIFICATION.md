# M5 verification

VANTA uses TrueForge 0.185.1 and the 0.185.0 TypeScript SDK. Agent Mode is instantiated by `agentModeDefinition` in [src/trueforge.ts](../src/trueforge.ts). See the [Agent Mode guide](AGENT_MODE.md) for settings, review and verification scope.

## Local checks

- The overlay unit fixture verified only the approved version of a Python source file while its original disk contents stayed unchanged. It also checked output bounds and redaction, timeout, snapshot cleanup, and Windows cancellation. A spawned grandchild had time to write a marker after cancellation if it survived. The marker never appeared.
- The transaction fault injection wrote one file, diverged a second buffer and simulated a failure. Compensation restored the exact after-state of the first file and reported the second file for manual recovery. Receipt tests cover revision mismatch and replay, rejected hunks, missing and ambiguous anchors, overlapping edits and malformed inputs.
- Windows VS Code 1.144.1 Extension Development Host successfully applied and undid three CRLF editor buffers with the on-disk content unchanged. It rejected a dirty target and a target deleted after capture. The suite also exercised Quick Edit selection, preservation of a dirty-buffer edit and native Undo. The installed updater held its startup mutex during the first attempt. The passing test used an isolated copy of the same VS Code build.
- The pinned Flask 3.1.3 baseline ran under an isolated Python 3.13 interpreter with pytest 9.0.2, Click 8.3.1 and distribution metadata available. Python imported the source via the checkout's `src` directory. The overlay environment omits the optional python-dotenv dependency because hidden files are outside the snapshot policy. Baseline `pytest tests/test_cli.py -q` produced 55 passed and three optional skips.

## Live evidence

The Flask fixture started at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. In VS Code Agent Studio, the official Task B prompt ran verbatim without filename hints, attachments or a selected editor range.

| Session | Observed result |
| --- | --- |
| `01m7d05eqsy85vqfw37641dzqe` | Native Studio with Gemini 3.5 Flash. Deferred trace `list_tools`, `get_tool_info`, `call_tool` then `search_workspace`. Returned `src/flask/cli.py:971–993` (filename, declaration and import matches), `tests/test_cli.py:322–344` (related tests and task terms), and `docs/cli.rst:419–441` (related docs). Provider rate limit ended the turn before staging. The Flask working tree was clean before and after. |
| `01m7cztt9gcazhghh786rty9wy` | Non-Flask invoice fixture through the live TrueForge gateway and an in-memory editor adapter. Deferred discovery returned the implementation, test and docs. Gemini 3.5 Flash staged `totals.py` and `tests/test_totals.py`. A provider rate limit ended the run before review or verification. |
| `01m7czvrf652t5p12efq85tj54` | M3 regression with Gemini 3.5 Flash Lite. Flask repository search and same-session symbol lookup passed. The explicit-reference turn reached the provider quota limit. |
| `01m7czwst74sxvkm860tbbwhff` | Streamed chat completed with three incremental updates. The subsequent overview call reached native allow and tool response before a provider quota error ended that turn. |

The saved Task B change, CLI help, masked synthetic JSON and final on-disk test run require a live run that reaches both approvals and completion. M6 resilience will need the same clean-worktree rehearsal as well as a verified secondary-model attempt.
