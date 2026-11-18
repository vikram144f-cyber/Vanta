# VANTA demo and submission checklist

## Before recording

- [ ] Use the committed VANTA development branch and note its revision. Install on Windows with `npm.cmd ci` and open **Run VANTA** with **F5**. Use a sidebar wide enough to show the diff controls, the model picker and run status.
- [ ] Start local TrueForge with the README's loopback allowlist. Check that `/healthz` reports `0.185.1` and the Studio shows **Connected**. Keep Settings credential fields, connector headers and private logs closed.
- [ ] Open the recorded rehearsal sessions listed in [Round 1 readiness](ROUND1_READINESS.md). In the final video, show the TrueForge session from the exact Task B request visible in that video.
- [ ] Keep separate trusted worktrees for A, B and C, all pinned to `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Check `git status --porcelain` before each task.
- [ ] Prepare Task A's keyboard shortcut, behavior check and undo. For B, review section placement, save all three files, run saved-disk pytest and show masked JSON. For C, use an unreachable primary and configured live backup. Discard the backup proposal to show clean Git status.
- [ ] Keep each exact prompt-to-diff sequence intact. Use [the timed script](DEMO_SCRIPT.md).

## Before submitting

- [ ] Export a screen recording of at most four minutes with A, B and C in order. Confirm the editor, commands and results are readable. Document any missing footage or evidence.
- [ ] Finalize **Hex Appeal** member names, affiliations and GitHub handles. Confirm any tools and costs that the team should declare. Replace planned scorecard times with actual video timestamps, then regenerate the 1–3 page PDF from [the write-up source](TECHNICAL_WRITEUP.md).
- [ ] Publish the video as an unlisted YouTube link or a Drive link accessible to anyone with the link. Publish the final PDF via an accessible link. Verify both while signed out.
- [ ] Confirm the public GitHub link targets the intended development branch or exact revision. Open the repository while signed out. The README should show Windows install, local TrueForge startup, [example model manifest](model-provider.example.json), versioned agent definition, license and evidence.
- [ ] Check the team's registration and verify the portal instructions and deadline. Submit the public GitHub, video and PDF links through the Techfest Competition Portal by **20 November 2026, 23:59 IST**. Save the portal receipt. [Official requirements](REQUIREMENTS.md).
