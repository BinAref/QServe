/**
 * Paste and clear, on every box a person can type into.
 *
 * The product is used on phones and tablets held in one hand, often by somebody
 * standing up with a tray in the other. On a phone, clearing a field means
 * holding a finger down until a magnifier appears, dragging to select, then
 * hitting backspace; pasting means the same dance in reverse and usually a
 * mis-tap. Both are a button here instead.
 *
 * The rules are the same in every field in the product, because a control that
 * appears in some boxes and not others is a control nobody trusts:
 *
 *   Clear   shows only when there is something to clear. An empty box has no
 *           clear button, so the button appearing *is* the signal that the box
 *           has content — which matters on a small screen where the text may
 *           be scrolled out of sight.
 *   Paste   shows only where pasting can actually work. Offering a button that
 *           does nothing is worse than offering nothing.
 *
 * Nothing calls this per field. It is applied once at boot and then watches the
 * document, because the terminals re-render whole subtrees on every change and
 * a field decorated by hand would lose its buttons on the next repaint.
 */

import { t } from './i18n.js';
import { toast } from './dom.js';

/** Types that are a box with text in it. Everything else has its own controls. */
const TEXTUAL = new Set([
  'text', 'search', 'tel', 'url', 'email', 'password', 'number', '',
]);

const decorated = new WeakSet();

/* -------------------------------------------------------------- the clipboard */

/**
 * Reading the clipboard, in the three situations this product runs in.
 *
 * The web Clipboard API exists only in a secure context. The console is on
 * 127.0.0.1, which browsers count as secure, so it has one. Every other screen
 * — the waiter's phone, the kitchen tablet, the diner at table nine — reaches
 * the restaurant over plain HTTP on the local network, which is not a secure
 * context and never will be: there is no certificate authority reachable from a
 * building with no internet, which is the whole premise of the product.
 *
 * So on those screens the browser will not read a clipboard, and the QServe
 * Android app hands one over itself through `QServeNative`. A staff phone
 * running the app gets the button; the same phone in Chrome does not, and is
 * shown nothing rather than a button that fails.
 */
function clipboardReader() {
  const native = globalThis.QServeNative;
  if (native && typeof native.clipboardText === 'function') {
    return async () => String(native.clipboardText() ?? '');
  }
  if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
    return () => navigator.clipboard.readText();
  }
  return null;
}

/* ------------------------------------------------------------------- the icons */

const svg = (...paths) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '2');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    node.append(path);
  }
  return node;
};

const clipboardIcon = () => svg(
  'M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z',
  'M8 6H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2',
);
const crossIcon = () => svg('M6 6l12 12', 'M18 6L6 18');

/* --------------------------------------------------------------- writing to it */

/**
 * Put text where the caret is, the way the platform's own paste does.
 *
 * A field the person has not touched gets the text at the end rather than at
 * position zero, which is where an untouched caret sits and is never where
 * somebody means to paste an address onto the end of what is already there.
 */
function insert(field, text) {
  const hadFocus = document.activeElement === field;
  field.focus({ preventScroll: true });

  try {
    if (!hadFocus) {
      const end = field.value.length;
      field.setSelectionRange(end, end);
    }
    const from = field.selectionStart ?? field.value.length;
    const to = field.selectionEnd ?? from;
    field.setRangeText(text, from, to, 'end');
  } catch {
    // `number`, `email` and friends refuse selection APIs. Appending is the
    // only thing left, and for those types it is what pasting means anyway.
    field.value += text;
  }

  // The views watch these. A price preview, a live search, a save button that
  // enables itself — none of them can know about a value set from code.
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function clear(field) {
  field.value = '';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.focus({ preventScroll: true });
}

/* ------------------------------------------------------------ deciding what gets it */

function wanted(field) {
  if (decorated.has(field)) return false;
  if (field.disabled || field.readOnly) return false;
  // An explicit opt-out, for the rare box where a button would be in the way.
  if (field.closest('[data-field-actions="off"]')) return false;

  if (field.tagName === 'TEXTAREA') return true;
  if (field.tagName !== 'INPUT') return false;
  return TEXTUAL.has(field.type);
}

/* ---------------------------------------------------------------- the decoration */

function decorate(field, readClipboard) {
  if (!wanted(field)) return;
  decorated.add(field);

  /*
   * A div, not a span. These boxes sit inside `label.qs-field`, where
   * `.qs-field > span` is the rule that styles the label's own text — a span
   * here would come out looking like a second label.
   */
  const wrap = document.createElement('div');
  wrap.className = 'qs-fa';
  if (field.tagName === 'TEXTAREA') wrap.classList.add('qs-fa-tall');

  field.replaceWith(wrap);
  wrap.append(field);

  /*
   * The buttons follow the box, not the page.
   *
   * Almost every field reads in the restaurant's own direction, and on an
   * Arabic screen that puts the buttons on the left where the text ends. A
   * price is the exception: an amount is written left to right in every
   * language, so on that same Arabic screen its digits start on the left —
   * which is exactly where the buttons would have been, sitting on top of the
   * first digit. Taking the direction from the field itself puts them at the
   * end of the text in both cases.
   */
  const direction = getComputedStyle(field).direction;
  if (direction) wrap.style.direction = direction;

  const buttons = document.createElement('div');
  buttons.className = 'qs-fa-buttons';

  const button = (kind, label, icon, onClick) => {
    const node = document.createElement('button');
    // Always: these boxes live inside forms, and a button with no type submits.
    node.type = 'button';
    node.className = `qs-fa-btn qs-fa-${kind}`;
    node.tabIndex = -1;          // keyboard users have Ctrl+V and Ctrl+A already
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon);
    node.addEventListener('click', (event) => {
      // Inside a <label>, a click would otherwise also be a click on the field.
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return node;
  };

  let count = 0;

  if (readClipboard) {
    count += 1;
    buttons.append(button('paste', t('common.paste'), clipboardIcon(), async () => {
      try {
        const text = await readClipboard();
        if (text) insert(field, text);
        else toast(t('common.clipboard_empty'), 'info');
      } catch {
        // Firefox and Safari can refuse, and a phone can have no clipboard
        // permission at all. Say so rather than appear to have done nothing.
        toast(t('common.clipboard_blocked'), 'error');
      }
    }));
  }

  count += 1;
  const clearButton = button('clear', t('common.clear'), crossIcon(), () => clear(field));
  buttons.append(clearButton);

  wrap.append(buttons);
  wrap.dataset.buttons = String(count);

  /*
   * The clear button is the field's own state made visible: present when there
   * is something to clear, gone when there is not. `hidden` rather than a class,
   * so it leaves the accessibility tree too and a screen reader is not offered
   * a button that clears nothing.
   */
  const sync = () => { clearButton.hidden = field.value.length === 0; };
  sync();
  field.addEventListener('input', sync);
  field.addEventListener('change', sync);
}

/* ------------------------------------------------------------------------ wiring */

/** Decorate everything inside a subtree. */
function sweep(root, readClipboard) {
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.matches?.('input, textarea')) decorate(root, readClipboard);
  for (const field of root.querySelectorAll?.('input, textarea') ?? []) {
    decorate(field, readClipboard);
  }
}

let watching = false;

/**
 * Apply this to the whole document, now and to whatever is drawn later.
 *
 * Called once by `boot()`, so every terminal gets it without a single view
 * having to know it exists.
 */
export function fieldActions() {
  if (watching) return;
  watching = true;

  const readClipboard = clipboardReader();
  sweep(document.body, readClipboard);

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) sweep(node, readClipboard);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
