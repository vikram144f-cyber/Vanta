import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, UIEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { isBusy } from '../protocol';
import type { StudioAction, StudioState, StudioUpdate } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: StudioAction): void };
const host = acquireVsCodeApi();
const titles = { checking: 'Connecting', connected: 'Connected', offline: 'Offline' } as const;

function Studio() {
  const [state, setState] = useState<StudioState>();
  const [draft, setDraft] = useState('');
  const [shareContext, setShareContext] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const log = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const prompt = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const receive = ({ data }: MessageEvent<StudioUpdate>) => {
      if (data?.type === 'snapshot') setState(data.state);
      if (data?.type === 'insertReference') {
        setDraft((value) => `${value.trimEnd()} ${data.text} `.trimStart());
        prompt.current?.focus();
      }
    };
    window.addEventListener('message', receive);
    host.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (log.current && atBottom.current) log.current.scrollTop = log.current.scrollHeight;
  }, [state?.messages]);

  if (!state) return <main className="boot" role="status">Opening Agent Studio…</main>;
  const { connection, messages, activity, phase, approval, sessionId, error } = state;
  const review = state.review;
  const busy = isBusy(phase);
  const canSend = !busy && connection.status === 'connected' && !!(connection.selectedModel || (!agentMode && connection.agentName))
    && (!agentMode || shareContext);
  const status = phase === 'approval' ? 'Waiting for approval' : phase === 'cancelling' ? 'Cancelling'
    : phase === 'streaming' ? 'Model generating' : phase === 'starting' ? 'Starting session' : '';

  function send() {
    if (!canSend || !draft.trim()) return;
    atBottom.current = true;
    host.postMessage({ type: 'submitPrompt', text: draft, shareContext, agentMode });
    setDraft('');
    setShareContext(false);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    send();
  }
  function onPromptKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }
  function onScroll(event: UIEvent<HTMLElement>) {
    const node = event.currentTarget;
    atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
  }

  return <main className="studio">
    <header className="masthead">
      <div className="brand-row">
        <span className="brand">VANTA</span>
        <span className={`connection ${connection.status}`} role="status"><span aria-hidden="true" />{titles[connection.status]}</span>
      </div>
      <div className="model-row">
        {connection.agentName ? <span className="agent-name" title={connection.agentName}>{connection.agentName}</span>
          : <label className="model-control"><span className="sr-only">TrueForge model</span>
            <select value={connection.selectedModel ?? ''} disabled={busy || connection.status !== 'connected'}
              onChange={(event) => host.postMessage({ type: 'selectModel', model: event.currentTarget.value })}>
              <option value="" disabled>{connection.models.length ? 'Select a model' : 'No models loaded'}</option>
              {connection.models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select></label>}
        <button className="subtle" type="button" disabled={busy} onClick={() => host.postMessage({ type: 'refreshConnection' })}>Refresh</button>
      </div>
      <details className="connection-details" open={connection.status === 'offline' || connection.attention || undefined}>
        <summary>Connection details</summary>
        <p role={connection.status === 'offline' || connection.attention ? 'alert' : undefined}>{connection.detail}{connection.version ? ` Version ${connection.version}.` : ''}</p>
      </details>
    </header>

    <section className="conversation" aria-label="Conversation" onScroll={onScroll} ref={log} tabIndex={0}>
      {messages.length === 0 && <div className="empty">
        <h2>What are you working on?</h2>
        <p>Ask a coding question or request an overview of the open workspace.</p>
      </div>}
      {messages.map((message) => <article key={message.id} className={`message ${message.role}`}>
        <h2>{message.role === 'user' ? 'You' : 'VANTA'}</h2><p>{message.text}</p>
      </article>)}
      {status && <p className="run-status" role="status">{status}{state.activeModel ? ` · ${state.activeModel}` : ''}…</p>}
      {error && <p className="error" role="alert">{error}{phase === 'failed' && state.quickEdit ? ' Run Quick Edit again from the editor to retry.' : ''}</p>}
    </section>

    {approval && <section className="approval" aria-label="Tool approval">
      <h2>{approval.label}</h2><p>{approval.detail}</p>
      <div className="button-row">
        {approval.canAllow && <button className="primary" onClick={() => host.postMessage({ type: 'decideApproval', id: approval.id, allow: true })}>Allow once</button>}
        <button onClick={() => host.postMessage({ type: 'decideApproval', id: approval.id, allow: false })}>Reject</button>
      </div>
    </section>}

    {review && <section className="approval quick-review" aria-label={review.files ? 'Agent Mode review' : 'Quick Edit review'}>
      <h2>{review.files ? 'Review Agent changes' : 'Review Quick Edit'}</h2>
      {review.files ? <p>Accepting part of a patch can break related changes.</p> : <p>{review.path} · {review.explanation}</p>}
      <p>{review.hunks.filter((hunk) => hunk.status === 'pending').length} pending</p>
      <div className="button-row">
        <button type="button" disabled={review.current <= 1} onClick={() => host.postMessage({ type: 'reviewHunk', id: review.id, hunk: review.current - 1, decision: 'view' })}>Previous hunk</button>
        <button type="button" disabled={review.current >= review.hunks.length} onClick={() => host.postMessage({ type: 'reviewHunk', id: review.id, hunk: review.current + 1, decision: 'view' })}>Next hunk</button>
      </div>
      {(review.files ?? [{ path: review.path, summary: '', hunks: review.hunks }]).map((file) => <div className="review-file" key={file.path}>
      {review.files && <><h3>{file.path}</h3><p>{file.summary}</p></>}
      <ol className="quick-hunks">{file.hunks.map((hunk) => <li key={hunk.id}>
        <button type="button" className="subtle" aria-current={review.current === hunk.id ? 'true' : undefined}
          onClick={() => host.postMessage({ type: 'reviewHunk', id: review.id, hunk: hunk.id, decision: 'view' })}>Hunk {hunk.id} · line {hunk.line} · {hunk.status}</button>
        <div className="button-row">
          <button type="button" aria-label={`Accept hunk ${hunk.id}`} aria-pressed={hunk.status === 'accepted'} onClick={() => host.postMessage({ type: 'reviewHunk', id: review.id, hunk: hunk.id, decision: 'accepted' })}>Accept</button>
          <button type="button" aria-label={`Reject hunk ${hunk.id}`} aria-pressed={hunk.status === 'rejected'} onClick={() => host.postMessage({ type: 'reviewHunk', id: review.id, hunk: hunk.id, decision: 'rejected' })}>Reject</button>
        </div>
      </li>)}</ol></div>)}
      <div className="button-row">
        <button type="button" disabled={!review.hunks.some((hunk) => hunk.status === 'pending')}
          onClick={() => host.postMessage({ type: 'rejectRemaining', id: review.id })}>Reject remaining</button>
        <button type="button" className="primary" disabled={review.hunks.some((hunk) => hunk.status === 'pending') || !review.hunks.some((hunk) => hunk.status === 'accepted')}
          onClick={() => host.postMessage({ type: 'finishReview', id: review.id, apply: true })}>{review.files ? 'Approve selected hunks' : 'Apply accepted changes'}</button>
        <button type="button" onClick={() => host.postMessage({ type: 'finishReview', id: review.id, apply: false })}>Discard proposal</button>
      </div>
    </section>}

    <details className="activity" open={activity.length ? true : undefined}>
      <summary>Agent activity</summary>
      {sessionId && <p className="session" title={sessionId}>Session <code>{sessionId}</code></p>}
      {activity.length === 0 ? <p className="muted">No runs yet.</p> : <ol>
        {activity.map((item, index) => <li key={index}><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</li>)}
      </ol>}
    </details>
    <section className="workspace-tabs" aria-label="Workspace features">
      <details className="context-explorer" open={state.context?.length ? true : undefined}>
        <summary>Context Explorer</summary>
        {!state.context?.length && <p>Enable workspace context to share snippets and see how files were selected.</p>}
        {!!state.context?.length && <>
          <p>{state.context.at(-1)?.estimatedTokens.toLocaleString()} / {state.context.at(-1)?.budget.toLocaleString()} estimated tokens this turn</p>
          <div className="context-results">
            {state.context.map((report, index) => <section key={index}>
              <h2>{report.operation}{report.backend && ` · ${report.backend}`}</h2>
              {report.limited && <p>Scan or result limit reached.</p>}
              {report.omitted > 0 && <p>{report.omitted} skipped to stay within budget.</p>}
              {report.hits.length === 0 && <p>No new matching locations.</p>}
              <ul>{report.hits.map((hit, hitIndex) => <li key={hitIndex}>
                <button type="button" className="subtle context-link" onClick={() => host.postMessage({ type: 'openContext', path: hit.path, line: hit.start })}>
                  {hit.path}:{hit.start}{hit.end > hit.start && `–${hit.end}`}
                </button>
                <small>{hit.selected ? 'Returned' : 'Budget skipped'} · {hit.symbol && `${hit.symbol} · `}{hit.reason}</small>
              </li>)}</ul>
            </section>)}
          </div>
        </>}
      </details>
      {state.changes && <details open><summary>Changes</summary>
        <p>{state.changes.status === 'applied' ? 'Applied to editor buffers. Save in VS Code to persist changes.' : 'Undone in editor buffers.'}</p>
        <ul>{state.changes.paths.map((path) => <li key={path}>{path}</li>)}</ul>
        {state.changes.status === 'applied' && <button type="button" disabled={busy} onClick={() => host.postMessage({ type: 'undoAgent' })}>Undo Agent changes</button>}
      </details>}
      {state.verification && <details open><summary>Test Results</summary>
        <p><code>{state.verification.command}</code> · {state.verification.status}{state.verification.exitCode != null && ` · exit ${state.verification.exitCode}`}</p>
        {state.verification.output && <pre className="verification-output">{state.verification.output}</pre>}
      </details>}
    </section>

    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="prompt">Message VANTA</label>
      <textarea id="prompt" ref={prompt} rows={3} maxLength={12_000} placeholder="Message VANTA…" value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={onPromptKey} />
      <div className="composer-context">
        <label title="Discover, stage, review and verify changes across existing files">
          <input type="checkbox" checked={agentMode} disabled={busy} onChange={(event) => setAgentMode(event.currentTarget.checked)} /> Agent Mode
        </label>
        <label title="Share eligible filenames, symbols and snippets with TrueForge and its model for this turn">
          <input type="checkbox" checked={shareContext} disabled={busy} onChange={(event) => setShareContext(event.currentTarget.checked)} /> Share workspace context
        </label>
        <button type="button" className="subtle" disabled={busy} onClick={() => host.postMessage({ type: 'pickReference' })}>Add file…</button>
      </div>
      {state.sessionId && <p className="muted context-note">{state.agentMode ? 'Agent Mode uses a separate TrueForge session for each request.'
        : state.quickEdit ? 'Quick Edit uses a separate TrueForge session.' : 'Follow-ups can use context shared earlier in this conversation.'}</p>}
      <div className="composer-footer">
        <button type="button" className="subtle" disabled={busy || !messages.length} onClick={() => {
          host.postMessage({ type: 'clearConversation' });
          prompt.current?.focus();
        }}>New conversation</button>
        {state.retry && !busy && <button type="button" className="subtle" disabled={!!draft.trim()} onClick={() => {
          if (!state.retry) return;
          setDraft(state.retry.prompt);
          setShareContext(state.retry.shareContext);
          setAgentMode(state.retry.agentMode);
          prompt.current?.focus();
        }}>Restore prompt</button>}
        {busy ? <button type="button" disabled={phase === 'cancelling'} onClick={() => host.postMessage({ type: 'cancelRun' })}>Stop</button>
          : <button className="primary" disabled={!canSend || !draft.trim()} type="submit">Send</button>}
      </div>
    </form>
  </main>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Studio />);
