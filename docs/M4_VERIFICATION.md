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

5. Run **VANTA: Undo Last Quick Edit** and save. Confirm that `git status --porcelain` is empty again. For a partial review rehearsal, accept one hunk and reject the other, apply, inspect the saved diff, then undo and save again.

## Checks

| Check | Evidence |
| --- | --- |
| Static checks and build | `npm.cmd run typecheck`, `npm.cmd run lint`, `npm.cmd run build` passed. |
| Unit and local HTTP MCP | 24 tests passed, including Unicode, CRLF, line offsets, schema validation, scoped reads, partial selection, stale capture, missing or replayed approval and cancellation at multiple phases. |
| Windows extension integration | Activated and executed its commands, captured a dirty editor buffer, applied one of two proposed hunks and restored the earlier unsaved user change with native Undo. |
| M3 live regression | Gemini Flash Lite streamed real text, passed overview Allow/Reject/Stop, and returned Flask implementation, test and documentation locations with genuine deferred tool events. Follow-up symbol discovery and explicit mentions reused the same session. |
| Context Explorer | The live discovery suite observed returned Flask locations and selection reasons in the host state. The Windows sidebar rendered real results after Quick Edit, and clicking the CLI result opened `src/flask/cli.py` in the editor. |

## Later Task A regression and targeted undo

A later native retest in TrueForge session `01m7d1m6gaphjx2w5bwjkvvk7h` reached the deferred review gate and applied the two displayed hunks after approval. Twelve runtime cases passed, but the generated docstring omitted the empty and unset inputs. The UI undo attempt did not restore the saved file; the rehearsal source was restored from the pinned commit and its original SHA-256 was checked. This retest does not confirm the documentation requirement.

The continuation added **VANTA: Undo Last Quick Edit**, which retains the applied buffer snapshot and refuses undo if the document version, buffer contents, trust scope, or disk contents have changed unexpectedly. The Windows Extension Host test on VS Code 1.146.0 passed the saved-file case from a different active editor, verified the disk after saving the undo, and confirmed a later user edit is preserved by refusing stale undo. This local test does not replace a successful native Task A retest.

On 2026-11-16, Gemini Flash Lite Latest session `01m7hdr8aqr65abbyg3b0kdd8g` reached the native review with two hunks. The logic added both requested values, but the docstring again omitted the empty and unset cases. The tester discarded the proposal at review. A subsequent run with the original passing model, Gemini 3.5 Flash, timed out before producing a proposal (`01m7hdtgpfezvfdqhq8pn6w3sf`). The helper file retained its baseline SHA-256 and the Flask checkout was clean after both runs.

The local suites use deterministic fixtures. The live regression evidence comes from `test/live/flask.test.ts` and `test/live/trueforge.test.ts`. The real Quick Edit check uses the Windows Development Host, the production command and actual provider responses. [Design and scope](QUICK_EDIT.md).

## Controlled Task A acceptance at `fa36cda`

On 2026-11-16, the Windows Extension Development Host submitted the exact competition instruction once through TrueForge v0.185.1 using Gemini Flash Lite Latest. The recorded selection covered the entire `get_debug_flag` function, from line 28 column 1 to line 34 column 1. Session `01m7hp8x9qmjadh3spbf7f8mcd` showed the native `VANTA Quick Edit · helpers.py` diff with two hunks and paused on `review_quick_edit` for proposal `8b25eaf0-ddbf-4bd4-a7c6-ec852bb6d2d7`.

An in-memory replay matched the pinned source fingerprint, the raw model replacement and both staged hunks. The source compiled and all 24 behavior cases passed, including unset, empty, all five false strings and their applicable case variants, plus true and whitespace cases outside that set. The docstring named `0`, `false`, `no`, `off` and `n` but omitted unset and empty inputs. The acceptance check exited 3 for those omissions.

The proposal was discarded in native review. TrueForge recorded a deny and no accepted receipt. Apply, Save and **VANTA: Undo Last Quick Edit** were not exercised because the proposal failed review. The unrelated unsaved README marker survived the rejection and was then removed from its buffer. The disposable Flask checkout remained clean at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, and the SHA-256 of `src/flask/helpers.py` remained `49848f1857424cdf16e411d1da93b9e36dcbbaf6b1e324166a67634be7c4fcc7`. The incomplete model docstring is the acceptance blocker. A native save and targeted undo on a valid proposal remain open.

## Gemini 3.5 Flash rehearsal at `8c72cf2`

The Windows Extension Development Host sent the official instruction once through TrueForge v0.185.1 using `google-gemini/gemini-3-5-flash`. Session `01m7hpy7qrsxx9dywp780r3ddm` reached native `VANTA Quick Edit · helpers.py` review for proposal `00577b72-ce57-4524-87f3-4aad7fcf4897`. The trace confirmed a clean pinned base and the full selection, line 28 column 1 through line 34 column 1.

The exact two staged hunks matched the generated replacement when replayed in memory. The proposal compiled, all 24 behavior cases passed, and the docstring correctly covers unset, empty, `0`, `false`, `no`, `off` and `n`, plus the true result for other nonempty values. The targeted pre-approval check exited 0.

The tester explicitly accepted both hunks in the native review and chose **Apply accepted changes**. TrueForge recorded an allow decision and a receipt for hunks 1 and 2, then finished the turn. Agent Studio recorded **Quick Edit applied to buffer**. The pinned disk hash remained unchanged until the tester's approved patch was explicitly saved from VS Code.

After the first Save, the file matched the approval receipt and `git status --porcelain` listed only `src/flask/helpers.py`. The saved file SHA-256 was `8fbbc88822699a36a75637c3d249e5e1ac96bd17fbc899f3a8728ed3754126d6`. Python imported `helpers.py` from the pinned local checkout and passed all 24 behavior cases and the docstring checks with exit code 0.

In the same Windows Extension Development Host, **VANTA: Undo Last Quick Edit** was invoked from the unrelated dirty README editor. It reopened `helpers.py` with the original code and preserved the unsaved README marker. A second Save restored the baseline `helpers.py` SHA-256 `49848f1857424cdf16e411d1da93b9e36dcbbaf6b1e324166a67634be7c4fcc7`. The README's disk hash stayed unchanged. The rehearsal marker was then removed from its own buffer, and `git status --porcelain` was empty at Flask commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Task A passed on the current build, including native Save and Undo.

## Task A recheck on November 17, 2026

The local TrueForge trace for the passing native turn contains the recorded allow event `01m7hqbskabc5xp0nj78egwn1t` and `turn.done`. Replaying the exact `propose_quick_edit` replacement on the pinned source reproduced the recorded saved SHA-256. The resulting helper passed all 24 behavior cases and the documentation checks again.

A later Flash Lite proposal passed the behavior cases but quoted a generic default statement to claim coverage for an absent input. Quick Edit now checks that the documentation quote explicitly names absence or emptiness when the reported scenario names that condition. The rule applies to any explicit documentation request. The exact Task A prompt and its acceptance checks are in `test/live/quickEdit.test.ts` and `test/live/check_task_a.py`. Set `VANTA_QUICK_FLASK` to a clean pinned checkout, `VANTA_QUICK_MODEL` to a configured TrueForge model and `VANTA_TEST_PYTHON` to a trusted interpreter. Then run `npx tsx --test test/live/quickEdit.test.ts`. The live fixture uses an in-memory editor and leaves the checkout clean.

The updated build passed the live fixture with Gemini Flash Lite Latest in TrueForge session `01m7mwv07zvqnq8y8v3wjtmhkw`. Quick Edit rejected the first documentation check, accepted the revised seven-scenario check and presented the corrected two-hunk patch. All 24 behavior cases and the docstring checks passed before the fixture approved the two hunks. TrueForge completed the turn and VANTA applied the exact reviewed content to the in-memory editor. The pinned checkout stayed clean. The Windows Extension Host suite independently passed save and targeted undo on the same VANTA build.
