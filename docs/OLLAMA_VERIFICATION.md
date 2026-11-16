# Local Ollama and Qwen verification

Verified on November 16, 2026, from VANTA `156f3d3` on Windows 11 with VS Code 1.146.0. The three runs started in the native Extension Development Host's Agent Studio. TrueForge v0.185.1 handled all model calls through SDK 0.185.0. The workspace was a clean, trusted Flask 3.1.3 worktree at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`.

| Layer | Observed result |
| --- | --- |
| Ollama service | `http://127.0.0.1:11434/v1/models` returned `vanta-qwen4b:latest` and its base model `qwen3.5:4b-q4_K_M`. Ollama 0.40.16 listed the local alias at 3.3 GB. No direct generation test was submitted. |
| GPU and context | `ollama show --parameters` reported `num_ctx 8192`. Before and after the tests, `ollama ps` showed the alias at 3.4 GB loaded, **100% GPU**, **8192** context, and the `llamacpp` runner. The RTX 4050 Laptop GPU reported 6,141 MiB total VRAM. |
| TrueForge | `/healthz` returned HTTP 200, `ok`, version `0.185.1`. The existing `ollama-local` provider listed `ollama-local/vanta-qwen-4b-latest` with model ID `vanta-qwen4b:latest` and context length 8192. The session records used this exact profile. |
| VANTA model selection | Refreshed the model list and selected the local profile in Agent Studio. No secondary model was configured. |

## Native results

Elapsed times below are reported by TrueForge. Time spent waiting for a human decision is excluded.

| Test | TrueForge session and turn | Result |
| --- | --- | --- |
| Basic chat | Session `01m7j3v0ah2h6d91488xkhxvpc`, turn `01m7j3v0bq8ha0rqqrafka89xz` | **Passed, 33.4 s.** The exact prompt `Reply with exactly: VANTA LOCAL READY` returned `VANTA LOCAL READY` in Studio. The trace had `turn.created`, `mcp.initialize`, `model.message` and `turn.done` with status `done`. Studio showed **Completed** and restored the composer controls. |
| Read-only workspace overview | Session `01m7j3wrxpnjecqbdhy1v3nf8w`, turn `01m7j3wrytj8gk8wrmrkbntq8s` | **Passed with the existing read-only approval, 20.7 s.** The no-approval criterion was not met. Qwen called `get_workspace_overview` on the initialized VANTA MCP connector. TrueForge logged `tool.approval_required`, a matching human `user.tool_approval` with status `allow`, and a `tool.response` for `call_gl0cpo1v`. Studio displayed the same five visible files and four folders from the tool, including `pyproject.toml`, `docs`, `src` and `tests`. The turn finished successfully. |
| Optional symbol discovery | Session `01m7j3zz4h2130bh22h046vzvx`, turn `01m7j3zz51zz0dsz2t375mspa9` | **Did not pass, cancelled after 25.8 s of turn work.** Qwen used TrueForge's `list_tools` to discover the repository tools. It called `search_workspace`, `get_context_bundle`, `find_symbol` and `read_file` directly instead of using the deferred `call_tool` route. TrueForge returned “not found in tool mapping” for those direct calls. The overview calls it made along the way only returned top-level names. The source location `src/flask/helpers.py:28` was checked separately from the shell and was never returned by the model. **Stop** cancelled the turn and re-enabled the controls. |

Ollama's access log recorded a loopback HTTP 500 on `/v1/chat/completions` during the chat turn, followed by HTTP 200 before that same VANTA turn completed. The access log did not identify the cause. There was one user submission per test. No turn ended with a timeout or token-limit error. TrueForge's aggregate token totals for a multi-step turn are not a measurement of a single Ollama context window.

No edit was staged or applied. The Flask checkout remained clean. No extra model was installed, no external provider was called, and neither official Flask Task A nor B was run. No implementation defect was independently reproduced.

**Demo suitability:** Local Qwen is verified for basic Agent Studio chat and the approved read-only overview. This run does not establish reliable deferred source discovery or multi-file editing. Use the verified chat and overview flows for a basic local demo.
