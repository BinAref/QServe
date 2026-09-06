/**
 * Vendor console (spec §29, §30).
 *
 * Plain ES modules, no build step and no framework — the same discipline the
 * restaurant terminals follow. `h()` is a 20-line element builder that keeps
 * everything below it declarative without shipping a runtime.
 */

const api = {
  async call(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = payload?.error?.details?.field
        ? `${payload.error.code}: ${payload.error.details.field}`
        : (payload?.error?.code ?? `HTTP ${response.status}`);
      throw new Error(message);
    }
    return payload;
  },
  get: (p) => api.call('GET', p),
  post: (p, b) => api.call('POST', p, b ?? {}),
  patch: (p, b) => api.call('PATCH', p, b),
  put: (p, b) => api.call('PUT', p, b),
};

/* ------------------------------------------------------------------ helpers */

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'html') element.innerHTML = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

const badge = (status) => h('span', { class: `badge badge-${status}` }, status);

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const short = (value, length = 16) =>
  value ? `${String(value).slice(0, length)}…` : '—';

function toast(message, kind = 'info') {
  const node = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), 5000);
}

async function guarded(fn) {
  try {
    await fn();
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* -------------------------------------------------------------------- views */

const state = { view: 'licenses', selectedLicense: null };

const views = {
  async licenses(main, query = '') {
    const { licenses } = await api.get(`/admin/api/licenses?query=${encodeURIComponent(query)}`);

    const search = h('input', {
      placeholder: 'Search by Licence ID, Restaurant ID, restaurant name or key hint…',
      value: query,
      onInput: debounce((event) => render('licenses', event.target.value), 250),
    });

    main.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row row-between' },
          h('h2', {}, 'Licences'),
          h('span', { class: 'muted' }, `${licenses.length} shown`)),
        h('div', { style: 'margin-top:12px' }, search)),
      licenses.length === 0
        ? h('div', { class: 'card empty' }, 'No licences match this search.')
        : h('div', { class: 'card' },
            h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {},
                  h('th', {}, 'Licence ID'), h('th', {}, 'Restaurant'),
                  h('th', {}, 'Status'), h('th', {}, 'Bound device'),
                  h('th', {}, 'Transfers'), h('th', {}, 'Activated'))),
                h('tbody', {}, licenses.map((license) =>
                  h('tr', { onClick: () => openLicense(license.license_id) },
                    h('td', { class: 'mono' }, license.license_id),
                    h('td', {}, `${license.restaurantName} (${license.restaurant_id})`),
                    h('td', {}, badge(license.status)),
                    h('td', { class: 'mono' }, short(license.boundDevice)),
                    h('td', {}, String(license.transfer_count)),
                    h('td', { class: 'muted' }, when(license.activated_at))))))))
    );
  },

  async restaurants(main, query = '') {
    const { restaurants } = await api.get(
      `/admin/api/restaurants?query=${encodeURIComponent(query)}`);

    main.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, 'Restaurants'),
        h('p', { class: 'muted' },
          'Restaurant identity is permanent. It survives every device change, ' +
          'so the operational data on the restaurant PC is never orphaned.'),
        h('div', { style: 'margin-top:12px' },
          h('input', {
            placeholder: 'Search by Restaurant ID, name, phone or email…',
            value: query,
            onInput: debounce((event) => render('restaurants', event.target.value), 250),
          }))),
      h('div', { class: 'card' },
        h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Restaurant ID'), h('th', {}, 'Name'), h('th', {}, 'Contact'),
              h('th', {}, 'Licences'), h('th', {}, 'Created'))),
            h('tbody', {}, restaurants.map((restaurant) =>
              h('tr', { onClick: () => openRestaurant(restaurant.restaurant_id) },
                h('td', { class: 'mono' }, restaurant.restaurant_id),
                h('td', {}, restaurant.name),
                h('td', { class: 'muted' },
                  restaurant.contact_phone || restaurant.contact_email || '—'),
                h('td', {}, String(restaurant.licenses)),
                h('td', { class: 'muted' }, when(restaurant.created_at)))))))),
    );
  },

  async issue(main) {
    const form = h('form', { class: 'grid grid-2' },
      h('div', {},
        h('label', {}, 'Restaurant name',
          h('input', { name: 'restaurantName', required: true, placeholder: 'Al Bait Restaurant' })),
        h('label', {}, 'Existing Restaurant ID (for an additional licence)',
          h('input', { name: 'restaurantId', placeholder: 'REST-000123' })),
        h('label', {}, 'Contact name', h('input', { name: 'contactName' })),
        h('label', {}, 'Contact phone', h('input', { name: 'contactPhone', placeholder: '+9665…' }))),
      h('div', {},
        h('label', {}, 'Contact email', h('input', { name: 'contactEmail', type: 'email' })),
        h('label', {}, 'Country', h('input', { name: 'country' })),
        h('label', {}, 'Notes', h('textarea', { name: 'notes', rows: 3 })),
        h('label', {}, 'Licence type',
          h('input', { value: 'Perpetual', disabled: true }))));

    const result = h('div');

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      const body = {};
      for (const [key, value] of Object.entries(data)) {
        if (String(value).trim() !== '') body[key] = String(value).trim();
      }
      // Either identify an existing restaurant or name a new one, never both.
      if (body.restaurantId) delete body.restaurantName;

      guarded(async () => {
        const issued = await api.post('/admin/api/licenses', body);
        result.replaceChildren(
          h('div', { class: 'card key-reveal' },
            h('h2', {}, 'Licence created'),
            h('p', { class: 'muted' },
              'This key is shown once. The server stores only its hash and ' +
              'cannot display it again — record it with the customer now.'),
            h('div', { class: 'key-value' }, issued.licenseKey),
            h('div', { class: 'row' },
              h('button', {
                class: 'btn',
                onClick: () => {
                  navigator.clipboard?.writeText(issued.licenseKey);
                  toast('Licence key copied', 'success');
                },
              }, 'Copy key'),
              h('button', {
                class: 'btn btn-primary',
                onClick: () => openLicense(issued.license.license_id),
              }, 'Open licence')),
            h('h3', {}, 'Identifiers'),
            h('p', { class: 'mono' },
              `Restaurant ID: ${issued.restaurant.restaurant_id}`,
              h('br'),
              `Licence ID: ${issued.license.license_id}`)));
        form.reset();
        toast('Licence issued', 'success');
      });
    });

    main.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, 'Issue a perpetual licence'),
        h('p', { class: 'muted' },
          'Identifiers and key material are generated by the server. ' +
          'You never type cryptographic material by hand.'),
        h('div', { style: 'margin-top:16px' }, form),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn btn-primary', onClick: () => form.requestSubmit() },
            'Create licence'))),
      result);
  },

  /**
   * Pricing and contact details (spec §6, §29).
   *
   * QServe takes no payment anywhere. A restaurant that wants a licence talks
   * to whoever sells it one, pays however the two of them agree, and is given a
   * key to type in — so the only thing the software has to know is who to
   * contact and what to expect to pay, and both are written here.
   *
   * The prices are free text on purpose. "1,500 SAR", "٥٠٠ ر.س شامل التركيب",
   * "first transfer free" — a vendor selling in three countries can say what is
   * actually true, which a number and a currency code cannot.
   */
  async pricing(main) {
    const info = await api.get('/admin/api/vendor-info');

    const contactRows = h('div', { class: 'contact-rows' });
    const addContact = (contact = { kind: 'WHATSAPP', label: '', value: '' }) => {
      const row = h('div', { class: 'row contact-row' },
        h('select', { class: 'contact-kind' },
          ['WHATSAPP', 'PHONE', 'EMAIL', 'TELEGRAM', 'WEBSITE', 'OTHER'].map((kind) =>
            h('option', { value: kind, ...(kind === contact.kind ? { selected: true } : {}) },
              kind.charAt(0) + kind.slice(1).toLowerCase()))),
        h('input', { class: 'contact-label', placeholder: 'Label, e.g. Sales', value: contact.label }),
        h('input', { class: 'contact-value', placeholder: '+966 50 123 4567', value: contact.value }),
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onClick: () => row.remove(),
        }, 'Remove'));
      contactRows.append(row);
    };
    for (const contact of info.contacts) addContact(contact);
    if (info.contacts.length === 0) addContact();

    const field = (label, value, placeholder = '') =>
      h('label', {}, label, h('input', { value: value ?? '', placeholder }));

    const vendorName = field('Your name, as restaurants see it', info.vendorName, 'QServe Gulf');
    const tagline = field('Tagline (optional)', info.tagline, 'Local restaurant systems');
    const activationPrice = field('Activation price', info.pricing.activation.price, '1,500 SAR');
    const activationNote = field('Activation note (optional)', info.pricing.activation.note, 'includes setup');
    const transferPrice = field('Transfer price', info.pricing.transfer.price, '150 SAR');
    const transferNote = field('Transfer note (optional)', info.pricing.transfer.note, '');
    const instructions = h('label', {}, 'How to buy — shown under the prices',
      h('textarea', { rows: '5' }, info.instructions ?? ''));

    const value = (node, selector) => node.querySelector(selector).value.trim();

    const save = () => guarded(async () => {
      await api.put('/admin/api/vendor-info', {
        vendorName: vendorName.querySelector('input').value.trim(),
        tagline: tagline.querySelector('input').value.trim() || null,
        contacts: [...contactRows.querySelectorAll('.contact-row')].map((row) => ({
          kind: value(row, '.contact-kind'),
          label: value(row, '.contact-label'),
          value: value(row, '.contact-value'),
        })).filter((contact) => contact.value !== ''),
        pricing: {
          activation: {
            price: activationPrice.querySelector('input').value.trim(),
            note: activationNote.querySelector('input').value.trim() || null,
          },
          transfer: {
            price: transferPrice.querySelector('input').value.trim(),
            note: transferNote.querySelector('input').value.trim() || null,
          },
        },
        instructions: instructions.querySelector('textarea').value.trim() || null,
      });
      toast('Saved — restaurants see this the next time they refresh', 'success');
      render('pricing');
    });

    main.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, 'Pricing and contact'),
        h('p', { class: 'muted' },
          'This is the only place a price is written. The application takes no payment: ' +
          'restaurants read this on their licence screen and contact you directly.'),
        h('div', { class: 'form-grid', style: 'margin-top:16px' }, vendorName, tagline)),

      h('div', { class: 'card' },
        h('h3', {}, 'Prices'),
        h('p', { class: 'muted' },
          'Free text — write it the way you would say it. Left blank, restaurants ' +
          'are told to ask you. The transfer price is what moving a licence to ' +
          'another computer costs.'),
        h('div', { class: 'form-grid', style: 'margin-top:16px' },
          activationPrice, activationNote, transferPrice, transferNote)),

      h('div', { class: 'card' },
        h('h3', {}, 'How restaurants reach you'),
        contactRows,
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => addContact() },
            'Add a contact'))),

      h('div', { class: 'card' },
        instructions,
        h('div', { class: 'row', style: 'margin-top:16px' },
          h('button', { class: 'btn btn-primary', onClick: save }, 'Save'),
          info.updatedAt && !info.updatedAt.startsWith('1970')
            ? h('span', { class: 'muted' }, `Last changed ${when(info.updatedAt)}`)
            : null)));
  },

  async audit(main) {
    const { entries } = await api.get('/admin/api/audit?limit=200');
    main.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, 'Audit log'),
        h('p', { class: 'muted' }, 'Every licence action, newest first.'),
        h('div', { class: 'table-wrap', style: 'margin-top:12px' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'When'), h('th', {}, 'Actor'), h('th', {}, 'Action'),
              h('th', {}, 'Licence'), h('th', {}, 'Detail'))),
            h('tbody', {}, entries.map((entry) =>
              h('tr', {},
                h('td', { class: 'muted' }, when(entry.at)),
                h('td', {}, entry.actor),
                h('td', {}, entry.action),
                h('td', { class: 'mono' }, entry.license_id ?? '—'),
                h('td', { class: 'mono muted' }, entry.detail))))))));
  },
};

/* ----------------------------------------------------------------- details */

async function openLicense(licenseId) {
  const main = document.getElementById('main');
  await guarded(async () => {
    const data = await api.get(`/admin/api/licenses/${encodeURIComponent(licenseId)}`);
    const { license, restaurant, liveActivation, activations, transfers } = data;

    const action = (label, path, options = {}) =>
      h('button', {
        class: options.danger ? 'btn btn-danger' : 'btn',
        onClick: () => guarded(async () => {
          const body = {};
          if (options.needsReason) {
            const reason = window.prompt(`${label}: reason for the record?`);
            if (reason === null) return;
            body.reason = reason;
          }
          if (options.needsFee) {
            const feeReference = window.prompt('Transfer fee reference (invoice/receipt id):');
            if (feeReference === null) return;
            body.feeReference = feeReference;
          }
          await api.post(`/admin/api/licenses/${encodeURIComponent(licenseId)}/${path}`, body);
          toast(`${label} done`, 'success');
          await openLicense(licenseId);
        }),
      }, label);

    main.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:14px' },
        h('button', { class: 'btn btn-ghost', onClick: () => render('licenses') }, '← Licences')),

      h('div', { class: 'card' },
        h('div', { class: 'row row-between' },
          h('div', {},
            h('h2', {}, license.license_id),
            h('p', { class: 'muted' },
              `${restaurant.name} · ${restaurant.restaurant_id} · ${license.license_type}`)),
          badge(license.status)),

        h('div', { class: 'grid grid-2', style: 'margin-top:18px' },
          h('div', {},
            h('h3', {}, 'Binding'),
            h('p', { class: 'mono' },
              `Device: ${liveActivation?.device_fingerprint ?? 'not bound'}`),
            h('p', { class: 'muted' },
              `Label: ${liveActivation?.device_label || '—'}`, h('br'),
              `App version: ${license.app_version ?? '—'}`, h('br'),
              `Activated: ${when(license.activated_at)}`)),
          h('div', {},
            h('h3', {}, 'Transfers'),
            h('p', {},
              `${license.transfer_count} completed · `,
              h('strong', {}, `${license.transfer_credits} credit(s) available`)),
            h('p', { class: 'muted' },
              license.transfer_credits > 0
                ? 'The restaurant may activate a new device now.'
                : 'A new device needs a transfer credit granted after the fee is settled.'))),

        h('h3', {}, 'Actions'),
        h('div', { class: 'row' },
          action('Release device', 'release', { needsReason: true }),
          action('Grant transfer credit', 'transfer-credit', { needsFee: true }),
          license.status === 'REVOKED'
            ? action('Reinstate', 'reinstate', { needsReason: true })
            : action('Revoke', 'revoke', { needsReason: true, danger: true }))),

      h('div', { class: 'card' },
        h('h2', {}, 'Activation history'),
        h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Device fingerprint'), h('th', {}, 'Label'), h('th', {}, 'Version'),
              h('th', {}, 'Activated'), h('th', {}, 'Released'), h('th', {}, 'Reason'))),
            h('tbody', {}, activations.map((activation) =>
              h('tr', {},
                h('td', { class: 'mono' }, short(activation.device_fingerprint, 24)),
                h('td', {}, activation.device_label ?? '—'),
                h('td', {}, activation.app_version ?? '—'),
                h('td', { class: 'muted' }, when(activation.activated_at)),
                h('td', { class: 'muted' }, when(activation.released_at)),
                h('td', { class: 'muted' }, activation.release_reason ?? '—')))))) ),

      h('div', { class: 'card' },
        h('h2', {}, 'Transfer history'),
        transfers.length === 0
          ? h('p', { class: 'muted' }, 'No transfers recorded.')
          : h('div', { class: 'table-wrap' },
              h('table', {},
                h('thead', {}, h('tr', {},
                  h('th', {}, 'When'), h('th', {}, 'From'), h('th', {}, 'To'),
                  h('th', {}, 'Reason'), h('th', {}, 'Fee reference'), h('th', {}, 'By'))),
                h('tbody', {}, transfers.map((transfer) =>
                  h('tr', {},
                    h('td', { class: 'muted' }, when(transfer.created_at)),
                    h('td', { class: 'mono' }, short(transfer.from_fingerprint)),
                    h('td', { class: 'mono' }, short(transfer.to_fingerprint)),
                    h('td', {}, transfer.reason ?? '—'),
                    h('td', {}, transfer.fee_reference ?? '—'),
                    h('td', {}, transfer.performed_by)))))))
    );
  });
}

async function openRestaurant(restaurantId) {
  const main = document.getElementById('main');
  await guarded(async () => {
    const { restaurant, licenses } = await api.get(
      `/admin/api/restaurants/${encodeURIComponent(restaurantId)}`);

    main.replaceChildren(
      h('div', { class: 'row', style: 'margin-bottom:14px' },
        h('button', { class: 'btn btn-ghost', onClick: () => render('restaurants') },
          '← Restaurants')),
      h('div', { class: 'card' },
        h('h2', {}, restaurant.name),
        h('p', { class: 'mono' }, restaurant.restaurant_id),
        h('p', { class: 'muted' },
          `${restaurant.contact_name ?? '—'} · ${restaurant.contact_phone ?? '—'} · ` +
          `${restaurant.contact_email ?? '—'} · ${restaurant.country ?? '—'}`),
        restaurant.notes ? h('p', {}, restaurant.notes) : null),
      h('div', { class: 'card' },
        h('h2', {}, 'Licences'),
        h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {},
              h('th', {}, 'Licence ID'), h('th', {}, 'Status'),
              h('th', {}, 'Bound device'), h('th', {}, 'Created'))),
            h('tbody', {}, licenses.map((license) =>
              h('tr', { onClick: () => openLicense(license.license_id) },
                h('td', { class: 'mono' }, license.license_id),
                h('td', {}, badge(license.status)),
                h('td', { class: 'mono' }, short(license.boundDevice)),
                h('td', { class: 'muted' }, when(license.created_at)))))))));
  });
}

/* ------------------------------------------------------------------ plumbing */

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function render(view, argument) {
  state.view = view;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  const main = document.getElementById('main');
  main.replaceChildren(h('div', { class: 'card empty' }, 'Loading…'));
  await guarded(() => views[view](main, argument));
}

function showApp(session) {
  document.getElementById('login').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('who').textContent = session.displayName ?? session.username;
  render('licenses');
}

function showLogin() {
  document.getElementById('app').hidden = true;
  document.getElementById('login').hidden = false;
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const view = event.target.closest('.tab')?.dataset.view;
  if (view) render(view);
});

document.getElementById('logout').addEventListener('click', () => {
  guarded(async () => {
    await api.post('/admin/api/logout');
    showLogin();
  });
});

document.getElementById('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const errorNode = document.getElementById('login-error');
  errorNode.hidden = true;
  const data = Object.fromEntries(new FormData(event.target).entries());

  api.post('/admin/api/login', { username: data.username, password: data.password })
    .then(showApp)
    .catch((error) => {
      errorNode.textContent = error.message.includes('UNAUTHENTICATED')
        ? 'Incorrect username or password.'
        : error.message;
      errorNode.hidden = false;
    });
});

api.get('/admin/api/me')
  .then((session) => (session.authenticated ? showApp(session) : showLogin()))
  .catch(showLogin);
