# M5 verification

VANTA uses TrueForge 0.185.1 and the 0.185.0 TypeScript SDK. Agent Mode is instantiated by `agentModeDefinition` in [src/trueforge.ts](../src/trueforge.ts). See the [Agent Mode guide](AGENT_MODE.md) for settings, review and verification scope.

## Local checks

- The overlay unit fixture verified only the approved version of a Python source file while its original disk contents stayed unchanged. It also checked output bounds and redaction, timeout, snapshot cleanup, and Windows cancellation. A spawned grandchild had time to write a marker after cancellation if it survived. The marker never appeared.
- The transaction fault injection wrote one file, diverged a second buffer and simulated a failure. Compensation restored the exact after-state of the first file and reported the second file for manual recovery. Receipt tests cover revision mismatch and replay, rejected hunks, missing and ambiguous anchors, overlapping edits and malformed inputs.
- `npm run typecheck`, `npm run lint` and `npm run build` passed. Setting `VANTA_TEST_PYTHON` to the rehearsal interpreter ran 33 unit and transport tests, including command allow, deny, cancel and forged-response cases.
- Windows VS Code 1.144.1 Extension Development Host successfully applied and undid three CRLF editor buffers with the on-disk content unchanged. It rejected a dirty target and a target deleted after capture. The suite also exercised Quick Edit selection, preservation of a dirty-buffer edit and native Undo. The installed updater held its startup mutex during the first attempt. The passing test used an isolated copy of the same VS Code build.
- The pinned Flask 3.1.3 baseline ran under an isolated Python 3.13 interpreter with pytest 9.0.2, Click 8.3.1 and distribution metadata available. Python imported the source via the checkout's `src` directory. The overlay environment omits the optional python-dotenv dependency because hidden files are outside the snapshot policy. Baseline `pytest tests/test_cli.py -q` produced 55 passed and three optional skips.

## Live evidence

The Flask fixture started at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. In VS Code Agent Studio, the official Task B prompt ran verbatim without filename hints, attachments or a selected editor range.

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

| Session | Observed result |
| --- | --- |
| `01m7d05eqsy85vqfw37641dzqe` | Native Studio with Gemini 3.5 Flash. Deferred trace `list_tools`, `get_tool_info`, `call_tool` then `search_workspace`. Returned `src/flask/cli.py:971–993` (filename, declaration and import matches), `tests/test_cli.py:322–344` (related tests and task terms), and `docs/cli.rst:419–441` (related docs). Provider rate limit ended the turn before staging. The Flask working tree was clean before and after. |
| `01m7cztt9gcazhghh786rty9wy` | Non-Flask invoice fixture through the live TrueForge gateway and an in-memory editor adapter. Deferred discovery returned the implementation, test and docs. Gemini 3.5 Flash staged `totals.py` and `tests/test_totals.py`. A provider rate limit ended the run before review or verification. |
| `01m7czvrf652t5p12efq85tj54` | M3 regression with Gemini 3.5 Flash Lite. Flask repository search and same-session symbol lookup passed. The explicit-reference turn reached the provider quota limit. |
| `01m7czwst74sxvkm860tbbwhff` | Streamed chat completed with three incremental updates. The subsequent overview call reached native allow and tool response before a provider quota error ended that turn. |
| `01m7d0f4rts3bvx1w2ppj0xy70` | Native Task B using Gemini Flash Lite Latest. Deferred discovery returned the implementation, tests and docs. An initial pair of exact anchors was rejected. The model successfully staged two implementation hunks and one test hunk before the turn errored. The original checkout remained clean. |
| `01m7d0rp11xad8k5g0dwb99g3d`, `01m7d0x6v9y0ghy9qrtytbpyfw` | Further native Task B attempts with Gemini Flash Lite Latest and Gemini 3.5 Flash Lite. The provider returned HTTP 429 before the review gate. |
| `01m7d10gpqwygypngddqjda9hg` | Native Task B with batched reads and Gemini Flash Lite Latest. The provider reported a free-tier request limit of 15 and returned HTTP 429 before staging. |
| `01m7d14gebwnb6hznagfa1h1wn`, `01m7d15h9xf4bmky98r194fgsw` | Native Task B with batched reads and staging available. Gemini 3.5 Flash hit 429 on the initial model call. Gemini Flash Lite Latest found all three paths and hit 429 after discovery and focused reads. Git status remained clean. |
| `01m7d17h3fqpjk5yb46rwzfvsh` | Attempt through the live adapter with Gemini 3.1 Pro Preview. The provider returned 429 and reported a free-tier limit of zero. |
| `01m7d1ac4bxjwskszm1a60sns1` | Native Task B with Gemini Flash Lite Latest. Deferred discovery, literal search and batched reads returned source from all three paths. The model exhausted its request limit before issuing staging. |
| `01m7d1df6h1dygn87d9xjbc3an` | Task B through the live adapter using Gemini 3.1 Flash Lite. Returned source from the pinned checkout. The provider returned 429 before staging. |
| `01m7d1ecrm7886jwa82he1wb4y` | Native Task A regression with Gemini Flash Lite Latest revealed that TrueForge can request Quick Edit approval through its deferred `call_tool` helper. This version initially rejected it and cancelled without applying. The host now checks the exact connector, tool and arguments for deferred Quick Edit and Agent Mode review calls. |
| `01m7d0gx5wcpnqmhjtm6vjhg7s` | M3 live regression passed with Gemini Flash Lite Latest. Deferred discovery found all three paths, and same-session symbol lookup and explicit references completed. |
| `01m7d0kgdqj4ns2yacsdm6bk8t` | Live streaming and MCP overview regression passed with Gemini Flash Lite Latest. Separate sessions verified native allow, deny and cancellation. |
| `01m7d0krr94tw5xynp6g2hef4p` | Non-Flask invoice fixture passed through live TrueForge with Gemini 3.5 Flash Lite and an in-memory editor adapter. Deferred discovery returned `totals.py` (filename and task match), `tests/test_totals.py` (related test), and `docs/invoices.md` (filename and task match). All three staged files reached revision 3. TrueForge emitted `tool.approval_required`, `user.tool_approval` and `tool.response` for each of `review_changes` and `run_verification`, followed by `turn.done`. The command `python -m pytest tests/test_totals.py -q` had exit 0 and two passing tests. The adapter's apply and undo assertions passed and the Git worktree stayed clean. |

The final verification runner also executed the unchanged Flask checkout from its disposable snapshot. It returned exit 0 with 55 passed and three optional skips. The saved Task B change, CLI help, masked synthetic JSON and final on-disk test run require a live run that reaches both approvals and completion. M6 resilience will need the same clean-worktree rehearsal as well as a verified secondary-model attempt.

The live adapter is reproducible by setting `VANTA_AGENT_MODEL` and `VANTA_TEST_PYTHON`, then running `npx tsx --test test/live/agentMode.test.ts`. Set `VANTA_AGENT_FLASK` to a clean pinned checkout to run the exact Task B through the adapter. Native review, buffer apply and save should be reproduced from Agent Studio using the [Agent Mode guide](AGENT_MODE.md).
