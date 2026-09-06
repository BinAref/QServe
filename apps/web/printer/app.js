/**
 * Printer bridge (spec §36, PrinterTransport.BROWSER).
 *
 * A tablet or old laptop parked next to a USB receipt printer. The server sends
 * it print jobs over the realtime channel; it renders them and calls
 * `window.print()`. This is how a restaurant uses a printer that has no network
 * interface, without anyone installing a driver on the main PC.
 *
 * It deliberately does almost nothing else: no queue of its own, no retry
 * logic. The server owns the job record, and a failed job is retried from the
 * console where somebody is actually looking.
 */

import { boot, connectionIndicator, offlineBanner, api, t } from '../shared/boot.js';
import { h, mount } from '../shared/dom.js';
import { pick, formatTime } from '../shared/i18n.js';

const state = {
  session: null,
  log: [],
  /** Jobs are printed one at a time; the browser dialog is modal. */
  queue: [],
  printing: false,
  autoPrint: true,
};

const root = document.getElementById('app');
const printArea = h('pre', { id: 'print-area' });
let realtime;

function note(message) {
  state.log.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
  state.log = state.log.slice(0, 200);
  render();
}

/* --------------------------------------------------------------- printing */

function enqueue(job) {
  // Only jobs addressed to this station: the server names the terminal on
  // BROWSER-transport jobs, and every other terminal ignores them.
  if (job.deliverTo && job.deliverTo !== state.session.terminal?.id) return;
  if (typeof job.body !== 'string') return;

  state.queue.push(job);
  note(`${t('printing.jobs')}: ${job.jobId ?? ''}`);
  drain();
}

function drain() {
  if (state.printing || !state.autoPrint) return;
  const job = state.queue.shift();
  if (!job) return;

  state.printing = true;
  printArea.textContent = job.body;
  render();

  // Let the DOM paint before the modal print dialog freezes the page.
  requestAnimationFrame(() => {
    try {
      window.print();
      note(`${t('common.print')} ✓`);
    } catch (error) {
      note(`${t('error.internal')}: ${String(error)}`);
    } finally {
      state.printing = false;
      // Chain the next job after the dialog closes.
      setTimeout(drain, 400);
    }
  });
}

/* ----------------------------------------------------------------- render */

function render() {
  mount(root,
    offlineBanner(realtime),
    h('div', { class: 'bridge' },
      h('div', { class: 'qs-card' },
        h('div', { class: 'qs-card-head' },
          h('h1', {}, t('printing.title')),
          connectionIndicator(realtime)),

        h('p', { class: 'bridge-status' },
          state.session?.terminal
            ? pick(state.session.terminal.name)
            : t('terminals.scan_hint')),

        h('label', { class: 'qs-check', style: { marginBlock: 'var(--qs-spacing-md)' } },
          h('input', {
            type: 'checkbox',
            checked: state.autoPrint,
            onChange: (event) => {
              state.autoPrint = event.target.checked;
              if (state.autoPrint) drain();
            },
          }),
          h('span', {}, `${t('common.print')} — ${t('common.enabled')}`)),

        h('div', { class: 'qs-row' },
          h('button', {
            class: 'qs-btn',
            disabled: state.queue.length === 0,
            onClick: drain,
          }, `${t('common.print')} (${state.queue.length})`),
          h('button', {
            class: 'qs-btn qs-btn-ghost',
            onClick: () => { state.log = []; render(); },
          }, t('common.refresh'))),

        h('div', { class: 'qs-section-title' }, t('printing.jobs')),
        h('div', { class: 'bridge-log' },
          state.log.length === 0 ? t('common.empty') : state.log.join('\n')))),
    printArea);
}

/* ------------------------------------------------------------------ boot */

async function main() {
  const started = await boot({
    topics: ['printing', 'system'],
    requireTerminal: true,
  });
  state.session = started.session;
  realtime = started.realtime;

  render();
  note(t('app.name'));

  realtime.on('print.job_queued', (job) => enqueue(job));

  // Anything queued while this bridge was asleep is printed on reconnect.
  realtime.onStateChange((connection) => {
    if (connection === 'open') note(t('app.reconnected'));
  });
}

void main().catch((error) => console.error('[printer]', error));
