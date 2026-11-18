# VANTA demo script

Target **3:55**, with a hard limit of **4:00**. Keep the VS Code editor visible and retain each prompt-to-diff sequence. These are planning times. Use actual export timestamps in the scorecard. [Competition brief](REQUIREMENTS.md)

| Time | Show |
| --- | --- |
| 0:00–0:12 | Agent Studio connected to local TrueForge and ready on the pinned Flask checkout. |
| 0:12–1:12 | **A.** Select `get_debug_flag`, use the Quick Edit shortcut and submit the exact Task A instruction. Show per-hunk review, apply and save. Set `$env:FLASK_DEBUG = 'off'` and show `False` from `python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`. Undo, save again and show clean Git status. |
| 1:12–2:40 | **B.** Start a new conversation in a clean checkout. With Agent Mode and workspace context enabled, submit the exact Task B prompt with no filenames or attachments. Show Context Explorer's budget and file-selection reasons. Review the three files and the docs placement. Approve pytest, save all, then show passing saved-disk pytest and run `flask config` against a synthetic app. Briefly show the matching TrueForge turn and both approvals. |
| 2:40–3:40 | **C.** In a separate clean checkout, use the unreachable primary and the working backup. Repeat Task A once. Show a responsive editor, the automatic switch, and the backup's real diff. Discard at review, show that an unsaved marker is still present, and show clean Git status. |
| 3:40–3:55 | If this fits while remaining legible, show a short live stream and Stop during generation, followed by a clean worktree. The deferred file read in a genuine Quick Edit session can support the integration score. |

The exact A and B prompts are in the [verification fixture](../test/extension/liveTasks.ts). The [checklist](DEMO_CHECKLIST.md) covers publication, and the [readiness audit](ROUND1_READINESS.md) lists the verified sessions. The saved-disk [Task B checker](../test/live/check_task_b.py) also runs the CLI on a synthetic app and confirms that unrelated routes still work.
