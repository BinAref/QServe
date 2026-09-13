/**
 * The vendor console, as one page.
 *
 * Served by an Edge Function so it needs nothing installed and nothing running:
 * the vendor opens a URL on a laptop, or the vendor phone app opens the same
 * URL in its WebView, and both are looking at the same live database. There is
 * no local server any more, which was the point.
 *
 * Written as a string rather than as files because an Edge Function deploys a
 * module, not a directory of assets, and one page with its styles and its
 * behaviour inside it is honest about what this is: a few hundred lines that
 * put four database functions in front of a person.
 */

export const CONSOLE_PAGE = (config: { url: string; anonKey: string }) => `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>QServe — licences</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f5f7; --surface: #ffffff; --surface-2: #f0f1f4;
    --text: #14181f; --muted: #5c6672; --border: #dfe3e8; --border-strong: #c3cad3;
    --accent: #1a56db; --accent-text: #ffffff;
    --danger: #b42318; --warn: #a86a00; --ok: #067647;
    --radius: 12px; --pad: 16px;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --surface: #171b21; --surface-2: #1e232a;
      --text: #e7ebf0; --muted: #9aa4b1; --border: #2a313a; --border-strong: #3a434f;
      --accent: #4b82f7; --danger: #f97066; --warn: #e0aa3e; --ok: #47cd89;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  header.bar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 14px var(--pad); padding-top: calc(14px + env(safe-area-inset-top, 0px));
    background: var(--surface); border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 10;
  }
  .mark {
    inline-size: 30px; block-size: 30px; border-radius: 8px; flex: none;
    background: var(--accent); color: var(--accent-text);
    display: grid; place-items: center; font-weight: 700; font-size: 13px;
  }
  h1 { font-size: 16px; margin: 0; font-weight: 650; }
  .grow { flex: 1; }
  main { max-width: 900px; margin: 0 auto; padding: var(--pad); }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: var(--pad); margin-bottom: 14px;
  }
  h2 { font-size: 15px; margin: 0 0 10px; font-weight: 650; }
  p { margin: 0 0 10px; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  .mono { font-family: var(--mono); }
  label { display: block; margin-bottom: 10px; }
  label > span { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input, textarea {
    width: 100%; padding: 10px 12px; font: inherit; color: var(--text);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 9px; min-height: 42px;
  }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .row > * { flex: 1 1 190px; }
  button {
    font: inherit; padding: 10px 16px; border-radius: 9px; cursor: pointer;
    border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
    min-height: 42px;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  button.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
  button.ghost { background: transparent; border-color: transparent; color: var(--muted); padding: 6px 10px; min-height: 34px; }
  .pill {
    display: inline-block; padding: 2px 9px; border-radius: 999px;
    font-size: 12px; font-weight: 600; border: 1px solid var(--border-strong);
  }
  .pill.ok { color: var(--ok); }
  .pill.pending { color: var(--warn); }
  .pill.gone { color: var(--muted); }
  .restaurant { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; }
  .restaurant > summary {
    padding: 12px var(--pad); cursor: pointer; background: var(--surface);
    display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
  }
  .restaurant > summary::-webkit-details-marker { display: none; }
  .restaurant[open] > summary { border-bottom: 1px solid var(--border); }
  .restaurant .body { padding: var(--pad); background: var(--surface); }
  .licence {
    border: 1px solid var(--border); border-radius: 10px; padding: 12px;
    margin-bottom: 10px; background: var(--surface-2);
  }
  .licence.gone { opacity: 0.62; }
  .keyout {
    font-family: var(--mono); font-size: 19px; letter-spacing: 0.06em;
    padding: 14px; border-radius: 10px; text-align: center; word-break: break-all;
    border: 1px solid var(--border-strong);
  }
  dialog {
    border: 1px solid var(--border); border-radius: 14px; padding: 0;
    background: var(--surface); color: var(--text); max-width: 460px; width: calc(100% - 32px);
  }
  dialog::backdrop { background: rgb(0 0 0 / 0.5); }
  dialog .inner { padding: var(--pad); }
  dialog footer { display: flex; gap: 10px; justify-content: flex-end; padding: 0 var(--pad) var(--pad); }
  .toast {
    position: fixed; inset-inline: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    margin-inline: auto; max-width: 420px; padding: 12px 16px; border-radius: 10px;
    background: var(--text); color: var(--bg); text-align: center; z-index: 50;
  }
  .empty { text-align: center; color: var(--muted); padding: 28px 0; }
  /*
   * A telephone number reads left to right in every language on earth: the
   * digits are the same digits, and only their position on the page would
   * otherwise flip. This keeps the +90 at the front where it belongs instead
   * of stranding the plus sign at the end of the line.
   */
  .tel { unicode-bidi: isolate; direction: ltr; font-family: var(--mono); }
</style>
</head>
<body>

<div id="signin" class="card" style="max-width:380px;margin:14vh auto;">
  <h2>QServe licences</h2>
  <p class="muted small">Sign in with the vendor account.</p>
  <form id="signin-form">
    <label><span>Email</span><input name="email" type="email" required autocomplete="username" /></label>
    <label><span>Password</span><input name="password" type="password" required autocomplete="current-password" /></label>
    <button class="primary" style="width:100%" type="submit">Sign in</button>
  </form>
  <p id="signin-error" class="small" style="color:var(--danger);display:none;margin-top:10px;"></p>
</div>

<div id="app" hidden>
  <header class="bar">
    <div class="mark">QS</div>
    <h1>Licences</h1>
    <span class="grow"></span>
    <span id="who" class="muted small"></span>
    <button id="signout" class="ghost">Sign out</button>
  </header>
  <main>
    <div class="card">
      <h2>New restaurant</h2>
      <p class="muted small">Creates the restaurant and issues its first licence. The key is
        shown once and never stored — only its fingerprint is kept.</p>
      <form id="new-form">
        <label><span>Restaurant name</span><input name="restaurantName" required maxlength="200" /></label>
        <div class="row">
          <label><span>Contact name</span><input name="contactName" maxlength="120" /></label>
          <label><span>Phone</span><input name="contactPhone" maxlength="40" inputmode="tel" dir="ltr" /></label>
        </div>
        <div class="row">
          <label><span>Email</span><input name="contactEmail" type="email" maxlength="200" /></label>
          <label><span>Country</span><input name="country" maxlength="80" /></label>
        </div>
        <label><span>Notes</span><textarea name="notes" rows="2" maxlength="2000"></textarea></label>
        <button class="primary" type="submit">Create and issue a licence</button>
      </form>
    </div>
    <div id="list"></div>
  </main>
</div>

<dialog id="keydialog">
  <div class="inner">
    <h2 id="keytitle">The licence key</h2>
    <p class="small muted">Copy it now. It is shown once — the database keeps only its
      fingerprint, so nobody, including us, can read it back.</p>
    <div class="keyout" id="keyvalue"></div>
  </div>
  <footer>
    <button id="keycopy">Copy</button>
    <button class="primary" id="keydone">Done</button>
  </footer>
</dialog>

<dialog id="askdialog">
  <div class="inner">
    <h2 id="asktitle"></h2>
    <p id="askbody" class="small muted"></p>
    <label><span>Reason (kept in the log)</span><input id="askreason" maxlength="200" /></label>
  </div>
  <footer>
    <button id="askno">Cancel</button>
    <button class="danger" id="askyes"></button>
  </footer>
</dialog>

<script type="module">
const URL_BASE = ${JSON.stringify(config.url)};
const ANON = ${JSON.stringify(config.anonKey)};

/* ------------------------------------------------------------ licence keys */

/*
 * A copy of packages/shared/src/license-key.ts, because this page runs in a
 * browser with no access to the repository. \`validate:supabase\` checks this
 * copy against the original on every build — a key generated here that the
 * restaurant's checksum rejects would be a key somebody has paid for.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LENGTH = 19;

function checksumChar(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += ALPHABET.indexOf(body[i]) * (i + 2);
  return ALPHABET[sum % 32];
}

function generateLicenseKey() {
  const bytes = new Uint8Array(BODY_LENGTH);
  crypto.getRandomValues(bytes);
  let body = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) body += ALPHABET[bytes[i] % 32];
  const full = body + checksumChar(body);
  const groups = [];
  for (let i = 0; i < full.length; i += 5) groups.push(full.slice(i, i + 5));
  return ['QSRV', ...groups].join('-');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ plumbing */

let session = null;
const el = (id) => document.getElementById(id);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/*
 * Everything on this page is built as nodes, never as HTML strings.
 *
 * Most of what is shown here was typed by the vendor, but not all of it: a
 * device label arrives from a restaurant's own computer during activation, and
 * a customer who named their machine with a script tag would be running it
 * inside the console that can revoke every licence in the database. One
 * innerHTML on that line is a stolen vendor session.
 */
function node(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'style') element.style.cssText = value;
    else if (key.startsWith('on')) element[key] = value;
    else element.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function toast(message) {
  const box = node('div', { class: 'toast' }, message);
  document.body.append(box);
  setTimeout(() => box.remove(), 3200);
}

async function rpc(name, args) {
  const res = await fetch(URL_BASE + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: {
      apikey: ANON,
      authorization: 'Bearer ' + session.access_token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200));
  const parsed = text ? JSON.parse(text) : null;
  if (parsed && parsed.error) throw new Error(parsed.detail || parsed.error);
  return parsed;
}

/* --------------------------------------------------------------- sign in */

el('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const error = el('signin-error');
  error.style.display = 'none';
  const res = await fetch(URL_BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
  });
  const body = await res.json();
  if (!body.access_token) {
    error.textContent = body.error_description || body.msg || 'Could not sign in.';
    error.style.display = 'block';
    return;
  }
  session = body;
  try { localStorage.setItem('qserve.session', JSON.stringify(body)); } catch { /* private mode */ }
  await start();
});

el('signout').addEventListener('click', () => {
  try { localStorage.removeItem('qserve.session'); } catch { /* nothing to clear */ }
  session = null;
  el('app').hidden = true;
  el('signin').style.display = '';
});

async function start() {
  el('signin').style.display = 'none';
  el('app').hidden = false;
  el('who').textContent = (session.user && session.user.email) || '';
  await refresh();
}

/* ----------------------------------------------------------------- asking */

function ask(options) {
  return new Promise((resolve) => {
    const dialog = el('askdialog');
    el('asktitle').textContent = options.title;
    el('askbody').textContent = options.body;
    el('askreason').value = '';
    el('askyes').textContent = options.confirmLabel;
    let answered = false;
    // Answered on the button, not on the dialog's close event: a browser that
    // misses that event would leave this promise unresolved forever.
    el('askyes').onclick = () => { answered = true; dialog.close(); };
    el('askno').onclick = () => { answered = false; dialog.close(); };
    dialog.onclose = () => resolve(answered ? (el('askreason').value.trim() || '—') : null);
    dialog.showModal();
  });
}

function showKey(key, title) {
  el('keytitle').textContent = title;
  el('keyvalue').textContent = key;
  el('keycopy').onclick = async () => {
    try { await navigator.clipboard.writeText(key); toast('Copied'); }
    catch { toast('Select it and copy by hand'); }
  };
  el('keydone').onclick = () => el('keydialog').close();
  el('keydialog').showModal();
}

/* ------------------------------------------------------------------ views */

function licenceCard(licence, restaurant) {
  const gone = Boolean(licence.deletedAt);
  const box = node('div', { class: 'licence' + (gone ? ' gone' : '') });

  const state = gone
    ? node('span', { class: 'pill gone' }, licence.status === 'TRANSFERRED' ? 'moved' : 'withdrawn')
    : licence.status === 'ACTIVE'
      ? node('span', { class: 'pill ok' }, 'in use')
      : node('span', { class: 'pill pending' }, 'not activated yet');

  box.append(node('div', { style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap' },
    node('strong', { class: 'mono' }, licence.licenseId),
    state,
    node('span', { style: 'flex:1' }),
    node('span', { class: 'muted small' }, 'ends ' + licence.keyHint)));

  const facts = ['issued ' + when(licence.createdAt)];
  if (licence.activatedAt) facts.push('activated ' + when(licence.activatedAt));
  if (licence.device) {
    facts.push('on ' + (licence.device.label || licence.device.fingerprint.slice(0, 12)));
  }
  if (licence.transferOf) facts.push('replaces ' + licence.transferOf);
  if (licence.deletedReason) facts.push(licence.deletedReason);
  box.append(node('div', { class: 'small muted' }, facts.join(' · ')));

  if (gone) return box;

  const move = node('button', {
    onclick: async () => {
      const reason = await ask({
        title: 'Move this licence',
        body: 'The current key stops working and a new one is issued to ' + restaurant.name
          + '. The machine holding it is released. Both halves are logged.',
        confirmLabel: 'Move it',
      });
      if (reason === null) return;
      const key = generateLicenseKey();
      const out = await rpc('transfer_license', {
        p_license_id: licence.licenseId,
        p_new_key_hash: await sha256Hex(key),
        p_new_key_hint: key.slice(-5),
        p_reason: reason,
        p_actor: session.user.email,
      }).catch((e) => { toast(e.message); return null; });
      if (!out) return;
      showKey(key, 'The replacement key');
      await refresh();
    },
  }, 'Move to a new key');

  const drop = node('button', {
    class: 'danger',
    onclick: async () => {
      const reason = await ask({
        title: 'Withdraw this licence',
        body: 'The key stops working and the machine holding it is released. Nothing is '
          + 'erased: the licence, its activations and its history stay in the record.',
        confirmLabel: 'Withdraw it',
      });
      if (reason === null) return;
      const out = await rpc('delete_license', {
        p_license_id: licence.licenseId, p_reason: reason, p_actor: session.user.email,
      }).catch((e) => { toast(e.message); return null; });
      if (!out) return;
      toast('Withdrawn');
      await refresh();
    },
  }, 'Withdraw');

  const history = node('button', {
    class: 'ghost',
    onclick: async () => {
      const out = await rpc('license_history', { p_license_id: licence.licenseId })
        .catch((e) => { toast(e.message); return null; });
      if (!out) return;
      const lines = out.log.map((l) => when(l.at) + ' · ' + l.action + ' · ' + l.actor)
        .concat(out.activations.map((a) => when(a.activatedAt) + ' · activated on '
          + (a.label || a.device.slice(0, 12))
          + (a.releasedAt ? ' (released ' + when(a.releasedAt) + ')' : '')));
      history.replaceWith(node('pre', {
        class: 'small mono', style: 'white-space:pre-wrap;margin-top:10px',
      }, lines.join('\\n') || 'nothing recorded yet'));
    },
  }, 'History');

  box.append(node('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
    move, drop, history));
  return box;
}

async function refresh() {
  const list = el('list');
  list.replaceChildren();
  const data = await rpc('vendor_overview').catch((e) => { toast(e.message); return []; });

  if (!data || data.length === 0) {
    list.append(node('div', { class: 'card empty' }, 'No restaurants yet.'));
    return;
  }

  for (const restaurant of data) {
    const live = restaurant.licenses.filter((l) => !l.deletedAt);

    const summary = node('summary', {},
      node('strong', {}, restaurant.name),
      node('span', { class: 'mono small muted' }, restaurant.restaurantId),
      node('span', { style: 'flex:1' }),
      node('span', { class: 'small muted' },
        live.length + ' live · ' + restaurant.licenses.length + ' total'));

    const body = node('div', { class: 'body' });

    const facts = [restaurant.contactName, restaurant.country].filter(Boolean);
    if (facts.length || restaurant.contactPhone || restaurant.contactEmail) {
      const line = node('p', { class: 'small muted' }, facts.join(' · '));
      if (restaurant.contactPhone) {
        line.append(facts.length ? ' · ' : '',
          node('bdi', { class: 'tel', dir: 'ltr' }, restaurant.contactPhone));
      }
      if (restaurant.contactEmail) line.append(' · ' + restaurant.contactEmail);
      body.append(line);
    }

    for (const licence of restaurant.licenses) body.append(licenceCard(licence, restaurant));

    body.append(node('button', {
      onclick: async () => {
        const key = generateLicenseKey();
        const out = await rpc('issue_license', {
          p_restaurant_id: restaurant.restaurantId, p_restaurant_name: null,
          p_contact_name: null, p_contact_phone: null, p_contact_email: null,
          p_country: null, p_notes: null, p_license_type: 'PERPETUAL',
          p_key_hash: await sha256Hex(key), p_key_hint: key.slice(-5),
          p_actor: session.user.email,
        }).catch((e) => { toast(e.message); return null; });
        if (!out) return;
        showKey(key, 'The licence key for ' + restaurant.name);
        await refresh();
      },
    }, 'Issue another licence'));

    const box = node('details', { class: 'restaurant' }, summary, body);
    if (live.length > 0) box.open = true;
    list.append(box);
  }
}

el('new-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const key = generateLicenseKey();
  const out = await rpc('issue_license', {
    p_restaurant_id: null,
    p_restaurant_name: form.get('restaurantName'),
    p_contact_name: form.get('contactName') || null,
    p_contact_phone: form.get('contactPhone') || null,
    p_contact_email: form.get('contactEmail') || null,
    p_country: form.get('country') || null,
    p_notes: form.get('notes') || null,
    p_license_type: 'PERPETUAL',
    p_key_hash: await sha256Hex(key),
    p_key_hint: key.slice(-5),
    p_actor: session.user.email,
  }).catch((e) => { toast(e.message); return null; });
  if (!out) return;
  event.target.reset();
  showKey(key, 'The licence key for ' + out.restaurantId);
  await refresh();
});

/* ------------------------------------------------------------------- boot */

try {
  const stored = localStorage.getItem('qserve.session');
  if (stored) {
    session = JSON.parse(stored);
    // A stored token may have expired while the page was closed; one call
    // proves it either way, and failing lands on the sign-in form.
    await rpc('vendor_overview');
    await start();
  }
} catch (error) {
  session = null;
}
</script>
</body>
</html>`;
