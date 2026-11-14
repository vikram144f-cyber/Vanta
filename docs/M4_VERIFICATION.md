# M4 Windows verification

Tested in Windows VS Code Extension Development Host 1.144.1 with TrueForge 0.185.1, SDK 0.185.0 and the existing network policy and loopback allowlist. Quick Edit uses the configured model through TrueForge. The agent tools and prompts are general-purpose.

## Observed Task A result

`google-gemini/gemini-3-5-flash` completed the exact prompt in TrueForge session `01m7cxb7matpbwh1v60w7rftqs`. The Windows shortcut selected the real Quick Edit command, and a native editor diff showed two independent hunks. Proposal `0ac02b1d-930d-4595-85fd-9bf16193c457` paused on `review_quick_edit`, and the matching review receipt allowed both hunks. The file hash stayed unchanged through staging and buffer apply. The tester then saved from VS Code.

Python imported `src/flask/helpers.py` from the pinned checkout. `off`, `OFF`, `Off`, `n`, `N`, `0`, `false`, `no`, the empty string and unset each returned `False`. `on` and `Y` returned `True`. The generated docstring covered the empty and unset cases as well as all five false literals. Native Undo and Save restored the original SHA-256 `49848f1857424cdf16e411d1da93b9e36dcbbaf6b1e324166a67634be7c4fcc7` and a clean checkout.

An independent native partial review in session `01m7cxjy5h0rmjzreq3brcw9mj` rejected the docstring hunk and accepted the logic hunk. The saved Git diff added only the new return line. Undo and Save again restored the original hash and clean checkout.

Several earlier attempts with `google-gemini/gemini-3-5-flash-lite` passed the behavior check but omitted the empty-string case from the docstring. `google-gemini/gemini-flash-latest` returned a provider 503 before proposing a patch. The passing Task A used 3.5 Flash selected in Studio. Rehearse with the intended demo model and inspect both hunks before retaining the result.

## Reproduce Task A

1. Follow the [Windows setup](../README.md). Clone Flask, check out tag `3.1.3` and verify `HEAD` is `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Start with an empty `git status --porcelain`.
2. Press **F5** in VANTA's repository. Open Flask as the one trusted folder in the Extension Development Host. In `src/flask/helpers.py`, select `get_debug_flag` from line 28 through the last return statement. Run **VANTA: Quick Edit**.
3. Enter the competition prompt exactly.

   > Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

4. Review the native diff and verify that the docstring covers both the literal values and the empty or unset case. Select the intended hunks, apply, then save. In a PowerShell session with Flask's dependencies available, run from the pinned Flask checkout.

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'src'
$env:PYTHONDONTWRITEBYTECODE = '1'
python -c "from flask import helpers; print(helpers.__file__)"
foreach ($value in 'off', 'OFF', 'Off', 'n', 'N', '0', 'false', 'no') {
  $env:FLASK_DEBUG = $value
  python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
}
Remove-Item Env:FLASK_DEBUG -ErrorAction SilentlyContinue
```

5. Press **Ctrl+Z** in the source editor and save. Confirm that `git status --porcelain` is empty again. For a partial review rehearsal, accept one hunk and reject the other, apply, inspect the saved diff, then undo and save again.

## Checks

| Check | Evidence |
| --- | --- |
| Static checks and build | `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run build` passed. |
| Unit and local HTTP MCP | 24 tests passed, including Unicode, CRLF, line offsets, schema validation, scoped reads, partial selection, stale capture, missing or replayed approval and cancellation at multiple phases. |
| Windows extension integration | Activated and executed its commands, captured a dirty editor buffer, applied one of two proposed hunks and restored the earlier unsaved user change with native Undo. |
| M3 live regression | Gemini Flash Lite streamed real text, passed overview Allow/Reject/Stop, and returned Flask implementation, test and documentation locations with genuine deferred tool events. Follow-up symbol discovery and explicit mentions reused the same session. |
| Context Explorer | The live discovery suite observed returned Flask locations and selection reasons in the host state. The Windows sidebar rendered real results after Quick Edit, and clicking the CLI result opened `src/flask/cli.py` in the editor. |

The local suites use deterministic fixtures. The live regression evidence comes from `test/live/flask.test.ts` and `test/live/trueforge.test.ts`. The real Quick Edit check uses the Windows Development Host, the production command and actual provider responses. [Design and scope](QUICK_EDIT.md).
