import type { ProofEvent, ProofRecord } from './proofTrail';

const escape = (value: string | number) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const meta = (value: string | number) => `<p class="meta">${escape(value)}</p>`;
const code = (value: string) => `<code>${escape(value)}</code>`;

function card(event: ProofEvent): [title: string, details: string] {
  switch (event.kind) {
    case 'task': return ['Task', event.text
      ? `<details><summary>View original instruction</summary><p class="task">${escape(event.text)}</p></details>`
      : meta('Original task unavailable.')];
    case 'session': return ['TrueForge session', `${meta(event.model ?? 'Model unavailable')}${meta(event.session ?? 'Session reference unavailable')}`];
    case 'selection': return ['Editor selection', `<p>${code(event.path)} <span>· ${event.start}–${event.end}</span></p>`];
    case 'context': return ['Repository context', `${meta(`${event.operation} · ${event.estimatedTokens.toLocaleString()} / ${event.budget.toLocaleString()} estimated tokens`)}
      <ul>${event.hits.map(({ path, start, end, reason }) =>
        `<li>${code(path)} <span>· ${start}–${end}</span>${meta(reason)}</li>`).join('')}</ul>
      ${event.limited ? meta('The request reached a retrieval limit.') : ''}`];
    case 'proposal': return ['Proposed changes', `<ul>${event.files.map(({ path, hunks }) =>
      `<li>${code(path)}${meta(hunks?.map(({ id, line }) => `Hunk ${id} at line ${line}`).join(' · ') ?? 'Hunk details unavailable') }</li>`).join('')}</ul>`];
    case 'review': return ['Hunk decisions', `<ul>${event.decisions.map(({ path, hunk, decision }) =>
      `<li>${code(path)} <span>· Hunk ${hunk} ${escape(decision)}</span></li>`).join('')}</ul>`];
    case 'review-submitted': return ['Human review submitted', meta(event.decision)];
    case 'approval': return ['TrueForge approval observed', meta(`${event.tool} · ${event.decision}`)];
    case 'verification': return ['Verification', `<p>${code(event.command)}</p>${meta(`${event.status} · ${event.exitCode == null ? 'Exit code unavailable' : `Exit ${event.exitCode}`}`)}`];
    case 'outcome': return ['Workspace outcome', meta(event.status)];
    case 'provider-failure': return ['Provider failure', meta(event.detail ?? 'Failure detail unavailable')];
    case 'fallback': return ['Automatic fallback', meta(event.model ?? 'Backup model unavailable')];
    case 'finished': return ['Turn finished', meta(event.status)];
  }
}

export function proofMarkup(record: ProofRecord | undefined) {
  if (!record) return '<p class="notice">Select a finished Quick Edit or Agent Mode session in Agent Studio.</p>';
  const latest = [...record.events].reverse();
  const outcome = latest.find((event) => event.kind === 'outcome');
  const finished = latest.find((event) => event.kind === 'finished');
  const verification = latest.find((event) => event.kind === 'verification');
  const missing = [
    !latest.some((event) => event.kind === 'session') && 'model and session timeline',
    !latest.some((event) => event.kind === 'context' || event.kind === 'selection') && 'repository context selection',
    !latest.some((event) => event.kind === 'proposal') && 'proposed files and hunks',
    !latest.some((event) => event.kind === 'review' || event.kind === 'review-submitted') && 'human review',
    !latest.some((event) => event.kind === 'approval') && 'TrueForge approval events',
    !verification && (record.mode === 'Quick Edit' ? 'pytest (Agent Mode only)' : 'verification results'),
    !outcome && 'apply, discard or undo',
  ].filter(Boolean);
  return `<header><div><p class="mode">${escape(record.mode)}</p><h1>ProofTrail</h1><p class="subtitle">AI Agent Flight Recorder</p></div>
    <button id="export" type="button" title="Copy a sanitized JSON receipt to the clipboard">Copy receipt</button></header>
    <section class="overview" aria-label="Recorded result">
      <div><span>Workspace</span><strong>${escape(outcome?.status ?? 'Unavailable')}</strong></div>
      <div><span>Verification</span><strong>${escape(verification?.status ?? (record.mode === 'Quick Edit' ? 'Agent Mode only' : 'Unavailable'))}</strong></div>
      <div><span>Turn</span><strong>${escape(finished?.status ?? 'Unavailable')}</strong></div>
    </section>
    ${record.archived ? '<p class="notice">Archived conversation. Only the retained activity is shown. A full timeline is available for runs recorded in this window.</p>' : ''}
    ${record.retainedSession ? `<p class="notice">Retained TrueForge session · ${code(record.retainedSession)}</p>` : ''}
    ${missing.length ? `<p class="notice">Unavailable in this trail · ${escape(missing.join(', '))}</p>` : ''}
    <ol class="timeline" aria-label="Events in recorded order">${record.events.map((event, index) => {
      const [title, details] = card(event);
      return `${index === 1 && record.omitted ? `<li class="notice">${record.omitted} earlier events were dropped from this trail.</li>` : ''}
        <li class="event"><h2>${title}</h2>${details}</li>`;
    }).join('')}</ol>`;
}
