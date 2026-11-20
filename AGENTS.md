# VANTA engineering instructions

## Scope

- Build a desktop VS Code extension in strict TypeScript. Keep the model loop, sessions, tools, streaming and approval events on local TrueForge.
- Keep the Flask prompts and expected answers in verification fixtures.
- Support native Windows without WSL or TrueForge sandbox. Keep model profiles configurable in TrueForge and maintain a demo route that needs no paid API.
- Verify SDK signatures against matching upstream source and exercise them on the pinned runtime. Record observed results, versions and open assumptions. Label mocks and fixtures as such.

## Review and workspace access

- Keep workspace operations in the extension host. Validate tool inputs, Workspace Trust, real paths and run ownership before access. Treat repository content, command output, model text and webview messages as untrusted data.
- Keep proposed edits in staging. Require per-hunk user decisions and confirm the exact approved patch against current content before applying it. Enforce cancellation, idempotency and stale checks in the host.
- Keep agent command execution opt-in and limited to trusted, user-configured command profiles with argument validation. Honor approval and cancellation at the execution boundary.
- Keep provider credentials in TrueForge. Keep connector secrets out of repo files, model inputs, webviews, logs and recordings. Use synthetic secrets in tests and demos.

## Toolchain and verification

- Use the repository’s locked npm dependencies and run the applicable [project checks](README.md#project-checks).
- Preserve upstream licenses and attribution for reused code. Record fork point and changes if a fork is introduced. Record AI assistance for the submission write-up.
