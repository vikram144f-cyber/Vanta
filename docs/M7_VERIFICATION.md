# M7 demo readiness verification

Windows checks used Node.js 22.17.0, npm 10.9.2, VS Code 1.146.0, and Python 3.13.1 for the local pytest fixtures. The preparation started from a clean `codex/vanta-vertical-slice` at `f2a6b0d`. The pinned Flask rehearsal worktree remained clean at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`.

| Check | Result |
| --- | --- |
| `npm.cmd ci --no-audit --no-fund` | Exit 0. Installed 248 packages from the lockfile. |
| `npm.cmd run typecheck` and `npm.cmd run lint` | Exit 0 for both. |
| `npm.cmd run test:extension` | Build and native Windows Extension Host suite exited 0. The host activated VANTA, registered commands, checked Quick Edit undo after save, and exercised three-file buffer application and undo using local fixtures. |
| `npm.cmd test` with `VANTA_TEST_PYTHON` | 58 passed, zero failed or skipped. Ran once as the M7 regression gate. |
| TrueForge baseline | Local `/healthz` reported `ok` and `0.185.1`. The Windows startup settings match the pinned runtime configuration. The existing A, B failure, invoice fixture, and C sessions were still accessible by ID. |
| Agent Studio | The composer footer can wrap its controls at narrow widths. The extension launched and Studio connected. A complete manual narrow-sidebar recovery walkthrough remains to be checked during recording. |
| Write-up | Two-page PDF with the eight required headings in order. Team roster and actual video times remain pending. |
| Packaging | Source checkout and F5 launch are supported. No configured VSIX workflow was present. |

No Gemini requests were made by this preparation and no official Flask Task B attempt was started. The offline HTTP 503 demonstration remains documented in [M6 verification](M6_VERIFICATION.md). The official Task B success criteria remain open, even though the separate invoice adapter fixture passed. The [timed script](DEMO_SCRIPT.md) preserves that distinction.

The demo has a 3:55 recording plan. The published video, confirmed team roster, final video timestamps, signed-out link checks and portal submission remain separate deliverables. [Submission checklist](DEMO_CHECKLIST.md).
