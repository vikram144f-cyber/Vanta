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
  const log = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const prompt = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const receive = ({ data }: MessageEvent<StudioUpdate>) => {
      if (data?.type === 'snapshot') setState(data.state);
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
  const busy = isBusy(phase);
  const canSend = !busy && connection.status === 'connected' && !!(connection.selectedModel || connection.agentName);
  const status = phase === 'approval' ? 'Waiting for approval' : phase === 'cancelling' ? 'Cancelling'
    : phase === 'streaming' ? 'Model generating' : phase === 'starting' ? 'Starting session' : '';

  function send() {
    if (!canSend || !draft.trim()) return;
    atBottom.current = true;
    host.postMessage({ type: 'submitPrompt', text: draft });
    setDraft('');
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
      <details className="connection-details" open={connection.status === 'offline' || undefined}>
        <summary>Connection details</summary>
        <p>{connection.detail}{connection.version ? ` Version ${connection.version}.` : ''}</p>
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
      {status && <p className="run-status" role="status">{status}…</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>

    {approval && <section className="approval" aria-label="Tool approval">
      <h2>{approval.label}</h2><p>{approval.detail}</p>
      <div className="button-row">
        {approval.canAllow && <button className="primary" onClick={() => host.postMessage({ type: 'decideApproval', id: approval.id, allow: true })}>Allow once</button>}
        <button onClick={() => host.postMessage({ type: 'decideApproval', id: approval.id, allow: false })}>Reject</button>
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
      {['Context Explorer', 'Changes', 'Test Results'].map((label) => <details key={label}>
        <summary>{label}</summary><p>Not available yet</p>
      </details>)}
    </section>

    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="prompt">Message VANTA</label>
      <textarea id="prompt" ref={prompt} rows={3} maxLength={12_000} placeholder="Message VANTA…" value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={onPromptKey} />
      <div className="composer-footer">
        <button type="button" className="subtle" disabled={busy || !messages.length} onClick={() => {
          host.postMessage({ type: 'clearConversation' });
          prompt.current?.focus();
        }}>Clear view</button>
        {busy ? <button type="button" disabled={phase === 'cancelling'} onClick={() => host.postMessage({ type: 'cancelRun' })}>Stop</button>
          : <button className="primary" disabled={!canSend || !draft.trim()} type="submit">Send</button>}
      </div>
    </form>
  </main>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Studio />);
