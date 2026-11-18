# VANTA Quick Edit

## Review a change

1. Open a trusted local folder and select one code region in a file. Press **Ctrl+Alt+I** on Windows or choose **VANTA: Quick Edit** from the editor context menu or Command Palette. You can rebind the command in Keyboard Shortcuts.
2. Enter the instruction and, if needed, pick a configured TrueForge model. The selected text and bounded workspace context can be sent to that model.
3. Review the native VS Code diff side by side. In Agent Studio, select a hunk or use **Previous hunk** and **Next hunk**. Accept and reject decisions are independent. **Reject remaining** resolves pending hunks without changing earlier decisions.
4. Select **Apply accepted changes** after deciding on every hunk, or **Discard proposal** to deny the review. **Stop** cancels a pending change. Save the source file with **Ctrl+S** when ready. **Ctrl+Z** in the source editor undoes an unsaved VANTA edit in one step. If you have already saved or switched to another editor, use **VANTA: Undo Last Quick Edit** from the Command Palette, then save again to persist the undo.

Review uses the full proposal as its visual baseline, with hunk status shown in Agent Studio. The final result uses just the accepted offsets against the original buffer, so inserted lines and rejected hunks do not shift other edits.

## Capture and staging

Quick Edit captures the document version, buffer text, file path, EOL, and selection offsets before showing the instruction input. It sends the instruction verbatim, followed by evidence with the relative path, language, 1-based range, exact selection, nearby code, and overlapping VS Code symbols when available. The nearby code includes up to ten lines on each side. For a partial function or method selection, Quick Edit can include up to 30 lines on either side within that function when the source is safe to share and fits the budget. The initial selection evidence uses up to half of the configured context budget. Deferred `read_file` and `find_symbol` calls share the remaining balance.

The `propose_quick_edit` tool accepts a strict replacement-and-explanation object. Its target is implicit in the captured selection. The proposal result records an ID, file, original SHA-256, version and hunks with UTF-16 offsets. A bounded line diff produces ordered nonoverlapping hunks in memory and normalizes the proposed text to the document EOL. The extension previews separate read-only virtual documents using `vscode.diff`. [VS Code diff command](https://code.visualstudio.com/api/references/commands#_commands).

Quick Edit uses high reasoning effort when TrueForge lists it as supported by the selected model. It uses medium if high is unavailable and medium is supported. Other models use their provider default. Higher reasoning effort can add latency and token usage.

## Approval and application

Quick Edit opens a dedicated TrueForge session so the chat conversation can continue from its existing session. After staging a draft, the agent calls `check_quick_edit` to trace concrete outcomes and compare requested documentation with the resulting behavior. For explicit documentation edits, the check requires quotes from the final selection. VANTA checks that the quoted text exists and names the concrete inputs cited by the model. The check can replace the draft once. A replacement gets a new ID and revokes the draft. The native diff remains the place to judge accuracy and completeness. The agent calls `review_quick_edit` with the checked proposal ID. VANTA reconstructs the streamed tool arguments and checks the native `tool.approval_required` call and source event before showing review controls. VANTA manages the hunk decisions. TrueForge approves or denies the whole checkpoint.

**Apply accepted changes** creates a one-use host grant bound to the proposal, accepted IDs and digest of the resulting buffer. VANTA posts `user.tool_approval` through `createTurnEvents`. The checkpoint consumes the grant and returns the receipt, with no editor write. A decision in the TrueForge web dashboard alone cannot create the grant. The extension requires the matching streamed approval event, matching checkpoint response and successful terminal turn before applying. Agent activity links the proposal ID and accepted hunk IDs to the applied edit. [TrueForge approvals API](https://trueforge.dev/api/use-agent#tool-approvals).

Apply checks the current trusted scope, exact document version and text, and UTF-8 disk contents against the captured state. One VS Code `TextEditor.edit` applies all approved ranges between native undo stops. Stop wins until the editor transaction begins. Once dispatched, the approved editor transaction resolves as a unit. VANTA does not auto-save or overwrite newer edits to roll back an unexpected post-apply buffer state. Use native undo to reverse the product's edit while retaining earlier changes. Disk save behavior, including configured formatters and auto-save, is controlled by VS Code.

The **VANTA: Undo Last Quick Edit** command keeps an in-memory snapshot of the latest applied Quick Edit in the current window. It can restore the captured buffer after Save All and can reopen the source when another editor is active. It checks that the document still has the exact applied text and version, and that disk contains either the original or applied text. If the source changed, undo is refused; after undoing a saved edit, save the restored buffer again.

## Scope

| Case | Behavior |
| --- | --- |
| Empty or multiple selections | Prompts for one nonempty region. |
| Dirty buffer for an existing local file | Uses in-memory text and guards both the captured buffer and original disk contents. |
| Untitled, virtual, remote or non-file documents | Quick Edit requires an existing local file. |
| Untrusted or multi-root workspace | Quick Edit requires one trusted local workspace folder. |
| Binary, invalid UTF-8, oversized or ignored file | Declines Quick Edit. The text limit is 96 KiB. UTF-8 BOM and native LF or CRLF are supported through VS Code's text editor. |
| Stale, deleted or replaced file contents | Apply is refused. Start a new Quick Edit from the current file. |
| Stop, denied approval, failed generation or missing receipt | The in-memory proposal loses authority and the source stays unchanged. A recent diff may remain visible for inspection. |

M4 handles one proposal in one existing file per turn. It changes the source buffer only and leaves filesystem transactions and multi-file recovery for a later milestone. [Verification](M4_VERIFICATION.md).
