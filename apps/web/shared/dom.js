/**
 * A 40-line element builder.
 *
 * The terminals ship as plain ES modules with no build step — a restaurant PC
 * should never need a toolchain to serve its own menu — so this stands in for a
 * framework. It is deliberately not one: `h()` creates elements, and each view
 * re-renders its own subtree. That is fast enough for a menu of a few hundred
 * items and leaves nothing to debug at 9pm on a Friday.
 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled') {
      el[key] = value;
      if (key !== 'value') el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Replace a container's contents in one operation, avoiding intermediate paints. */
export function mount(container, ...children) {
  const fragment = document.createDocumentFragment();
  append(fragment, children);
  container.replaceChildren(fragment);
  return container;
}

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Toast notifications. Created lazily so no app has to declare a container. */
export function toast(message, kind = 'info', ms = 4000) {
  let stack = document.getElementById('qs-toasts');
  if (!stack) {
    stack = h('div', { id: 'qs-toasts', class: 'qs-toasts' });
    document.body.append(stack);
  }
  const node = h('div', { class: `qs-toast qs-toast-${kind}`, role: 'status' }, message);
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, ms);
  return node;
}

/**
 * A modal built on <dialog>, so focus trapping and Escape come from the
 * platform rather than from code we would have to maintain.
 */
export function modal({ title, body, actions = [], onClose }) {
  const dialog = h('dialog', { class: 'qs-modal' },
    h('form', { method: 'dialog', class: 'qs-modal-inner' },
      h('header', { class: 'qs-modal-head' },
        h('h2', {}, title),
        h('button', { class: 'qs-icon-btn', value: 'cancel', 'aria-label': 'Close' }, '×')),
      h('div', { class: 'qs-modal-body' }, body),
      h('footer', { class: 'qs-modal-foot' }, actions)));

  dialog.addEventListener('close', () => {
    onClose?.(dialog.returnValue);
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** Confirmation that resolves to a boolean, for destructive actions. */
export function confirmDialog({ title, message, confirmLabel, cancelLabel, danger = true }) {
  return new Promise((resolve) => {
    let answered = false;
    const dialog = modal({
      title,
      body: h('p', {}, message),
      actions: [
        h('button', { class: 'qs-btn', value: 'cancel' }, cancelLabel),
        h('button', {
          class: danger ? 'qs-btn qs-btn-danger' : 'qs-btn qs-btn-primary',
          value: 'confirm',
          onClick: () => { answered = true; },
        }, confirmLabel),
      ],
      onClose: (value) => resolve(answered && value === 'confirm'),
    });
    dialog.querySelector('button[value="confirm"]')?.focus();
  });
}
