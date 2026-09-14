/**
 * The vendor console, as one page.
 *
 * Three verbs and nothing else: issue a licence, look at it, delete it. A
 * restaurant moving to a new computer is issued another licence like anybody
 * else — there is no transfer, and issuing one does not touch the old one. The
 * vendor decides when a licence goes.
 *
 * It ships inside the vendor's own download rather than being hosted, because
 * Supabase deliberately answers HTML from its own domain as plain text inside a
 * sandbox, so that a page served there cannot run same-origin with the API.
 * That turns out to be the better arrangement: nothing to keep online, and the
 * console works the moment it is installed.
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
  .keyline {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0;
  }
  .keyline code {
    font-family: var(--mono); font-size: 15px; letter-spacing: 0.04em;
    padding: 8px 12px; border-radius: 8px; background: var(--surface);
    border: 1px solid var(--border-strong); flex: 1 1 auto; word-break: break-all;
    user-select: all;
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

  <!-- Shown only on a computer where Windows Hello has been set up here. It is
       first because it is the way in: the password is underneath it for the
       day the face does not work. -->
  <div id="hello-box" hidden>
    <p class="muted small">Locked. Unlock with your face, fingerprint or PIN.</p>
    <button class="primary" style="width:100%" id="hello-unlock" type="button">Unlock</button>
    <p class="small" style="margin-top:10px;">
      <a href="#" id="hello-use-password">Use the password instead</a>
    </p>
  </div>

  <div id="password-box">
    <p class="muted small">Sign in with the vendor account.</p>
    <form id="signin-form">
      <label><span>Email</span><input name="email" type="email" required autocomplete="username" /></label>
      <label><span>Password</span><input name="password" type="password" required autocomplete="current-password" /></label>
      <button class="primary" style="width:100%" type="submit">Sign in</button>
    </form>
  </div>

  <p id="signin-error" class="small" style="color:var(--danger);display:none;margin-top:10px;"></p>
</div>

<div id="app" hidden>
  <header class="bar">
    <div class="mark">QS</div>
    <h1>Licences</h1>
    <span class="grow"></span>
    <button id="export" class="ghost">Download everything</button>
    <span id="who" class="muted small"></span>
    <button id="account" class="ghost">Account</button>
    <!-- Lock leaves the account signed in and asks for the face again; sign
         out forgets it. Two different intentions that used to be one button. -->
    <button id="lock" class="ghost" hidden>Lock</button>
    <button id="signout" class="ghost">Sign out</button>
  </header>
  <main>
    <div class="card">
      <h2>New restaurant</h2>
      <p class="muted small">Creates the restaurant and issues its first licence.</p>
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
        <label><span>Notes about this licence</span><textarea name="notes" rows="2" maxlength="2000"></textarea></label>
        <button class="primary" type="submit">Create and issue a licence</button>
      </form>
    </div>
    <div id="list"></div>
    <details class="card" id="archive-box">
      <summary><strong>Deleted licences</strong>
        <span class="muted small" id="archive-count"></span></summary>
      <p class="muted small" style="margin-top:10px">Kept on this computer only. Deleting a
        licence removes it from the database; this is the copy that stays with you.</p>
      <div id="archive"></div>
    </details>
  </main>
</div>

<dialog id="accountdialog">
  <div class="inner">
    <h2>Account</h2>
    <p class="small muted" id="account-who"></p>

    <h3 style="margin-top:18px;">Change the password</h3>
    <form id="password-form">
      <label><span>Current password</span>
        <input name="current" type="password" required autocomplete="current-password" /></label>
      <label><span>New password</span>
        <input name="next" type="password" required minlength="8" autocomplete="new-password" /></label>
      <label><span>New password again</span>
        <input name="again" type="password" required minlength="8" autocomplete="new-password" /></label>
      <button class="primary" type="submit">Change it</button>
    </form>

    <h3 style="margin-top:20px;">This computer</h3>
    <p class="small muted" id="hello-state"></p>
    <div class="row">
      <button id="hello-enrol" type="button">Set up Windows Hello</button>
      <button id="hello-forget" class="danger" type="button" hidden>Forget this computer</button>
    </div>

    <p id="account-message" class="small" style="display:none;margin-top:12px;"></p>
  </div>
  <footer>
    <button id="account-close">Close</button>
  </footer>
</dialog>

<dialog id="askdialog">
  <div class="inner">
    <h2 id="asktitle"></h2>
    <p id="askbody" class="small muted"></p>
    <label id="askreasonbox"><span>Reason (kept in the log)</span><input id="askreason" maxlength="200" /></label>
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
 * browser with no access to the repository. \`validate:supabase\` lifts this
 * copy back out of the built page and checks it against the original — a key
 * issued here that the restaurant's checksum rejects is a key somebody paid for.
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
 * inside the console that can delete every licence in the database.
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

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Select it and copy by hand');
  }
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

/* ---------------------------------------------- what stays on this computer */

/*
 * The vendor's own copy of what they deleted.
 *
 * Deleting a licence takes it out of the database, which is what deleting is
 * meant to mean. But the vendor still has to be able to answer "what did we
 * sell that restaurant in March", so the row is written here first. It never
 * leaves this machine and it is included in the download.
 */
const ARCHIVE = 'qserve.deleted';

function archived() {
  try { return JSON.parse(localStorage.getItem(ARCHIVE) || '[]'); } catch { return []; }
}

function archive(entry) {
  try {
    const all = archived();
    all.unshift(entry);
    localStorage.setItem(ARCHIVE, JSON.stringify(all.slice(0, 2000)));
  } catch {
    toast('Could not keep a local copy — this browser is blocking storage');
  }
}

/* -------------------------------------------------- the face on this computer

 * Windows Hello, and what it is actually protecting.
 *
 * What has to survive between one opening of this console and the next is the
 * refresh token: hold it and you are the vendor, with no password needed. It
 * used to sit in localStorage in the clear and be restored on load without
 * asking anybody anything, which made the lock on this console the lock on the
 * computer and nothing more.
 *
 * A passkey on its own would not fix that. An assertion is a yes or a no, and
 * a page that decides for itself what to do with a yes can be told to skip the
 * question by anyone able to edit the page or read the storage it guards. What
 * fixes it is the prf extension: the authenticator returns 32 bytes that exist
 * only after a real face, fingerprint or PIN, and those bytes are the key the
 * refresh token is encrypted with. No face, no key, no token — not a screen to
 * get past, a thing that cannot be decrypted.
 *
 * Not every Windows Hello can do that. Where it cannot, the passkey is still
 * required before the saved token is used, which is a lock on the screen
 * rather than on the file — better than what was here, and the Account panel
 * says plainly which of the two this computer is doing.
 *
 * All of it needs a real origin, which is why the vendor application serves
 * this page from http://localhost rather than opening it as a file. WebAuthn
 * refuses a file:// page: there is no domain for a credential to belong to.
 */

const SESSION = 'qserve.session';
const HELLO = 'qserve.hello';

const b64 = (buffer) => btoa(String.fromCharCode.apply(null, new Uint8Array(buffer)))
  .split('+').join('-').split('/').join('_').replace(/=+$/, '');
const unb64 = (text) => Uint8Array.from(
  atob(String(text).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function helloRecord() {
  try { return JSON.parse(localStorage.getItem(HELLO) || 'null'); } catch { return null; }
}
function forgetHello() {
  try { localStorage.removeItem(HELLO); } catch { /* nothing to forget */ }
}

async function platformAvailable() {
  try {
    return Boolean(window.PublicKeyCredential)
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

/** The 32 bytes a face is worth, as a key. */
const keyFrom = (bytes) => crypto.subtle.importKey(
  'raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/**
 * The key derived this session, held in a variable that dies with the tab.
 *
 * Asking for a face after every token refresh would be unusable, and the salt
 * is fixed per enrolment, so the same key can re-wrap for as long as the page
 * is open. It is never written anywhere.
 */
let liveKey = null;

/** Keep the current refresh token the best way this computer allows. */
async function keepSession() {
  const record = helloRecord();
  if (!record) {
    try { localStorage.setItem(SESSION, JSON.stringify(session)); } catch { /* private mode */ }
    return;
  }
  // Enrolled: a plain copy must not exist, or the lock guards nothing.
  try { localStorage.removeItem(SESSION); } catch { /* already gone */ }

  const token = new TextEncoder().encode(session.refresh_token);
  if (record.prf) {
    /*
     * No key in hand: this page was opened and signed in with the password
     * rather than unlocked with a face, so there is nothing to encrypt with.
     * The wrapped token already saved stays as it is — it still opens a
     * valid session — rather than being replaced by a readable one.
     */
    if (!liveKey) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, liveKey, token);
    record.iv = b64(iv);
    record.token = b64(sealed);
  } else {
    record.token = b64(token);
  }
  record.email = session.user && session.user.email;
  try { localStorage.setItem(HELLO, JSON.stringify(record)); } catch { /* private mode */ }
}

async function prfBytes(credential, salt) {
  const results = credential.getClientExtensionResults().prf;
  if (results && results.results && results.results.first) return results.results.first;
  if (!results || !results.enabled) return null;
  // Supported, but this browser only hands the bytes back on an assertion —
  // which is why setting it up can ask for a face twice.
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credential.rawId }],
      userVerification: 'required',
      timeout: 120000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  const second = assertion.getClientExtensionResults().prf;
  return (second && second.results && second.results.first) || null;
}

async function enrolHello() {
  if (!session || !session.user) throw new Error('sign in first');
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const handle = Uint8Array.from(
    String(session.user.id).replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: location.hostname, name: 'QServe licences' },
      user: { id: handle, name: session.user.email, displayName: session.user.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        // The face or finger belonging to this computer, not a key on a
        // lanyard: the point is that the vendor's own machine opens it and
        // nothing else does.
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      attestation: 'none',
      timeout: 120000,
      extensions: { prf: { eval: { first: salt } } },
    },
  });
  if (!credential) throw new Error('this computer did not create a passkey');

  const bytes = await prfBytes(credential, salt);
  const record = {
    credentialId: b64(credential.rawId),
    salt: b64(salt),
    prf: Boolean(bytes),
    email: session.user.email,
  };
  if (bytes) liveKey = await keyFrom(bytes);
  try { localStorage.setItem(HELLO, JSON.stringify(record)); } catch (failure) {
    throw new Error('this browser is blocking storage, so nothing could be saved');
  }
  await keepSession();
  return record;
}

async function sessionFromRefresh(refreshToken) {
  const res = await fetch(URL_BASE + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(body.error_description || body.msg || 'the saved sign-in has expired');
  }
  return body;
}

async function unlockWithHello() {
  const record = helloRecord();
  if (!record) throw new Error('this computer has no passkey for the console');

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: unb64(record.credentialId) }],
      userVerification: 'required',
      timeout: 120000,
      extensions: record.prf ? { prf: { eval: { first: unb64(record.salt) } } } : {},
    },
  });
  if (!assertion) throw new Error('the check was cancelled');

  let refreshToken;
  if (record.prf) {
    const results = assertion.getClientExtensionResults().prf;
    const bytes = results && results.results && results.results.first;
    if (!bytes) throw new Error('this computer would not give the key back');
    liveKey = await keyFrom(bytes);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(record.iv) }, liveKey, unb64(record.token));
    refreshToken = new TextDecoder().decode(plain);
  } else {
    refreshToken = new TextDecoder().decode(unb64(record.token));
  }

  session = await sessionFromRefresh(refreshToken);
  // Supabase hands out a new refresh token each time and spends the old one,
  // so the saved copy has to become the new one or the next unlock fails.
  await keepSession();
  await start();
}

/* --------------------------------------------------------------- sign in */

async function signInWithPassword(email, password) {
  const res = await fetch(URL_BASE + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(body.error_description || body.msg || 'Could not sign in.');
  }
  return body;
}

el('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const error = el('signin-error');
  error.style.display = 'none';
  try {
    session = await signInWithPassword(form.get('email'), form.get('password'));
  } catch (failure) {
    error.textContent = failure.message;
    error.style.display = 'block';
    return;
  }
  await keepSession();
  await start();
});

el('hello-unlock').addEventListener('click', async () => {
  const error = el('signin-error');
  error.style.display = 'none';
  el('hello-unlock').disabled = true;
  try {
    await unlockWithHello();
  } catch (failure) {
    error.textContent = failure.message;
    error.style.display = 'block';
    // A face that will not open it is not a dead end: the password is there.
    el('password-box').hidden = false;
  } finally {
    el('hello-unlock').disabled = false;
  }
});

el('hello-use-password').addEventListener('click', (event) => {
  event.preventDefault();
  el('password-box').hidden = false;
});

/* Lock puts the face back in the way; sign out forgets the computer. */
el('lock').addEventListener('click', () => {
  session = null;
  liveKey = null;
  el('app').hidden = true;
  el('signin').style.display = '';
  el('hello-box').hidden = false;
  el('password-box').hidden = true;
});

el('signout').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION); } catch { /* nothing to clear */ }
  forgetHello();
  session = null;
  liveKey = null;
  el('app').hidden = true;
  el('signin').style.display = '';
  el('hello-box').hidden = true;
  el('password-box').hidden = false;
});

/* --------------------------------------------------------------- account */

function accountSays(message, bad) {
  const line = el('account-message');
  line.textContent = message;
  line.style.color = bad ? 'var(--danger)' : 'var(--ok)';
  line.style.display = 'block';
}

async function drawAccount() {
  el('account-who').textContent = (session && session.user && session.user.email) || '';
  el('account-message').style.display = 'none';

  const record = helloRecord();
  const available = await platformAvailable();
  el('hello-enrol').hidden = Boolean(record);
  el('hello-forget').hidden = !record;
  el('hello-enrol').disabled = !available;

  if (record) {
    el('hello-state').textContent = record.prf
      ? 'Windows Hello is set up, and the saved sign-in on this computer is '
        + 'encrypted with a key your face or fingerprint produces. Without it '
        + 'there is nothing to read.'
      : 'Windows Hello is set up. This computer cannot encrypt with it, so it '
        + 'locks the screen rather than the saved sign-in — anybody who can '
        + 'read this browser profile could still take that sign-in.';
  } else if (available) {
    el('hello-state').textContent = 'You can open this console with your face, '
      + 'fingerprint or PIN instead of typing the password. It is set up per '
      + 'computer, and you may be asked to confirm twice while it is made.';
  } else {
    el('hello-state').textContent = 'This computer offers no Windows Hello (or '
      + 'this page is not being served from localhost), so there is nothing to '
      + 'set up here.';
  }
}

el('account').addEventListener('click', async () => {
  await drawAccount();
  el('accountdialog').showModal();
});
el('account-close').addEventListener('click', () => el('accountdialog').close());

el('hello-enrol').addEventListener('click', async () => {
  el('hello-enrol').disabled = true;
  try {
    const record = await enrolHello();
    el('lock').hidden = false;
    await drawAccount();
    accountSays(record.prf
      ? 'Done. The saved sign-in on this computer is now encrypted with it.'
      : 'Done. This computer cannot encrypt with Windows Hello, so it locks the '
        + 'screen rather than the saved sign-in.', false);
  } catch (failure) {
    await drawAccount();
    accountSays(failure.message || 'Windows Hello could not be set up.', true);
  }
});

el('hello-forget').addEventListener('click', async () => {
  forgetHello();
  liveKey = null;
  // The session still has to live somewhere, and it is no longer wrapped.
  await keepSession();
  el('lock').hidden = true;
  await drawAccount();
  accountSays('Forgotten. The passkey itself is still in Windows — remove it '
    + 'under Settings, Passkeys, if you want it gone from there as well.', false);
});

el('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const current = form.get('current');
  const next = form.get('next');
  if (next !== form.get('again')) {
    accountSays('The two new passwords are not the same.', true);
    return;
  }
  if (next === current) {
    accountSays('That is the password you already have.', true);
    return;
  }

  /*
   * The current password is proved first, and the token that proves it is the
   * one used to set the new one. Somebody who walked up to an unlocked console
   * does not get to change the password without knowing the old one.
   */
  let fresh;
  try {
    fresh = await signInWithPassword(session.user.email, current);
  } catch (failure) {
    accountSays('That is not the current password.', true);
    return;
  }

  const res = await fetch(URL_BASE + '/auth/v1/user', {
    method: 'PUT',
    headers: {
      apikey: ANON,
      authorization: 'Bearer ' + fresh.access_token,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: next }),
  });
  const body = await res.json();
  if (!res.ok) {
    accountSays(body.msg || body.error_description || 'The password was not changed.', true);
    return;
  }

  // Changing it can retire the tokens that were in the air, so the console
  // takes a clean one now rather than finding out on the next click.
  session = await signInWithPassword(session.user.email, next);
  await keepSession();
  event.target.reset();
  accountSays('Changed. The saved sign-in on this computer was updated too.', false);
});

async function start() {
  el('signin').style.display = 'none';
  el('app').hidden = false;
  el('who').textContent = (session.user && session.user.email) || '';
  el('lock').hidden = !helloRecord();
  await refresh();
}

/* ----------------------------------------------------------------- asking */

function ask(options) {
  return new Promise((resolve) => {
    const dialog = el('askdialog');
    el('asktitle').textContent = options.title;
    el('askbody').textContent = options.body;
    el('askreason').value = '';
    el('askreasonbox').hidden = options.reason === false;
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

/* ------------------------------------------------------------------ views */

function licenceCard(licence, restaurant) {
  const box = node('div', { class: 'licence' });

  box.append(node('div', { style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap' },
    node('strong', { class: 'mono' }, licence.licenseId),
    licence.status === 'ACTIVE'
      ? node('span', { class: 'pill ok' }, 'in use')
      : node('span', { class: 'pill pending' }, 'not activated yet'),
    node('span', { style: 'flex:1' }),
    node('span', { class: 'muted small' }, 'issued ' + when(licence.createdAt))));

  // The key, readable. A customer who has lost theirs rings up, and the vendor
  // has to be able to read it back rather than issue a replacement.
  box.append(node('div', { class: 'keyline' },
    node('code', {}, licence.key || '(key not recorded)'),
    node('button', {
      onclick: () => copy(licence.key || ''),
    }, 'Copy')));

  const facts = [];
  if (licence.activatedAt) facts.push('activated ' + when(licence.activatedAt));
  if (licence.deviceLabel || licence.device) {
    facts.push('on ' + (licence.deviceLabel || licence.device.slice(0, 12)));
  }
  if (licence.appVersion) facts.push('v' + licence.appVersion);
  if (facts.length) box.append(node('div', { class: 'small muted' }, facts.join(' · ')));
  if (licence.notes) box.append(node('p', { class: 'small', style: 'margin:8px 0 0' }, licence.notes));

  box.append(node('div', { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
    node('button', {
      class: 'danger',
      onclick: async () => {
        const reason = await ask({
          title: 'Delete this licence',
          body: 'It leaves the database and the key stops working. A copy is kept on this '
            + 'computer, under "Deleted licences", and appears in the download.',
          confirmLabel: 'Delete it',
        });
        if (reason === null) return;
        archive({
          deletedAt: new Date().toISOString(), reason,
          restaurantId: restaurant.restaurantId, restaurantName: restaurant.name,
          licenseId: licence.licenseId, key: licence.key, notes: licence.notes,
          status: licence.status, activatedAt: licence.activatedAt,
          deviceLabel: licence.deviceLabel,
        });
        const out = await rpc('delete_license', {
          p_license_id: licence.licenseId, p_reason: reason, p_actor: session.user.email,
        }).catch((e) => { toast(e.message); return null; });
        if (!out) return;
        toast('Deleted');
        await refresh();
      },
    }, 'Delete')));

  return box;
}

async function issueFor(restaurant, notes) {
  const key = generateLicenseKey();
  const out = await rpc('issue_license', {
    p_restaurant_id: restaurant.restaurantId, p_restaurant_name: null,
    p_contact_name: null, p_contact_phone: null, p_contact_email: null,
    p_country: null, p_notes: notes || null, p_license_type: 'PERPETUAL',
    p_key: key, p_key_hash: await sha256Hex(key), p_key_hint: key.slice(-5),
    p_actor: session.user.email,
  }).catch((e) => { toast(e.message); return null; });
  if (!out) return;
  toast('Issued ' + out.licenseId);
  await refresh();
}

async function refresh() {
  drawArchive();
  const list = el('list');
  list.replaceChildren();
  const data = await rpc('vendor_overview').catch((e) => { toast(e.message); return []; });
  window.__data = data;

  if (!data || data.length === 0) {
    list.append(node('div', { class: 'card empty' }, 'No restaurants yet.'));
    return;
  }

  for (const restaurant of data) {
    const summary = node('summary', {},
      node('strong', {}, restaurant.name),
      node('span', { class: 'mono small muted' }, restaurant.restaurantId),
      node('span', { style: 'flex:1' }),
      node('span', { class: 'small muted' }, restaurant.licenses.length + ' licence(s)'));

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

    /*
     * Another licence for the same restaurant — which is how a move to a new
     * computer is handled. The old one is not touched: the restaurant may still
     * be trading on it until the new machine is ready, and deciding when it
     * goes is the vendor's call, not a side effect of this button.
     */
    const notes = node('input', { placeholder: 'Notes for the new licence', maxlength: '2000' });
    body.append(node('div', { class: 'row', style: 'margin-top:6px' },
      notes,
      node('button', {
        style: 'flex:0 0 auto',
        onclick: () => issueFor(restaurant, notes.value.trim()),
      }, 'Issue another licence')));

    const box = node('details', { class: 'restaurant' }, summary, body);
    if (restaurant.licenses.length > 0) box.open = true;
    list.append(box);
  }
}

function drawArchive() {
  const all = archived();
  el('archive-count').textContent = all.length ? ' · ' + all.length : ' · none';
  const target = el('archive');
  target.replaceChildren();
  for (const entry of all.slice(0, 100)) {
    const box = node('div', { class: 'licence' });
    box.append(node('div', { class: 'small' },
      node('strong', { class: 'mono' }, entry.licenseId || '—'),
      ' · ' + (entry.restaurantName || entry.restaurantId || '')));
    box.append(node('div', { class: 'keyline' },
      node('code', {}, entry.key || '(not recorded)'),
      node('button', { onclick: () => copy(entry.key || '') }, 'Copy')));
    box.append(node('div', { class: 'small muted' },
      'deleted ' + when(entry.deletedAt) + (entry.reason ? ' · ' + entry.reason : '')));
    if (entry.notes) box.append(node('p', { class: 'small', style: 'margin:6px 0 0' }, entry.notes));
    target.append(box);
  }
}

/* ------------------------------------------------------------- the download */

/*
 * A spreadsheet, as CSV.
 *
 * CSV rather than a real .xlsx because Excel opens it directly, so does every
 * other spreadsheet, and it needs no library — and a vendor who wants their
 * customer list is not helped by waiting for a 400 KB dependency to load. The
 * byte-order mark is what makes Excel read the Arabic correctly instead of
 * showing mojibake.
 */
function toCsv(rows) {
  const escape = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    /*
     * A leading =, +, - or @ makes a spreadsheet treat the cell as a formula,
     * and one of these columns is not ours: the device label arrives from a
     * restaurant's own computer when it activates. A customer who named their
     * machine \`=cmd|'/c calc'!A1\` would be running it on the vendor's desktop
     * the moment they opened their own customer list. A leading apostrophe is
     * what tells every spreadsheet "this is text"; it is not shown in the cell.
     */
    if (/^[=+\\-@\\t\\r]/.test(text)) text = "'" + text;
    return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return '\\uFEFF' + rows.map((row) => row.map(escape).join(',')).join('\\r\\n');
}

el('export').addEventListener('click', () => {
  const data = window.__data || [];
  const rows = [[
    'Restaurant ID', 'Restaurant', 'Contact', 'Phone', 'Email', 'Country',
    'Licence ID', 'Key', 'Status', 'Notes', 'Activated', 'Device', 'Version',
    'Issued', 'Deleted', 'Delete reason',
  ]];

  for (const restaurant of data) {
    if (restaurant.licenses.length === 0) {
      rows.push([restaurant.restaurantId, restaurant.name, restaurant.contactName,
        restaurant.contactPhone, restaurant.contactEmail, restaurant.country,
        '', '', '', '', '', '', '', '', '', '']);
      continue;
    }
    for (const licence of restaurant.licenses) {
      rows.push([restaurant.restaurantId, restaurant.name, restaurant.contactName,
        restaurant.contactPhone, restaurant.contactEmail, restaurant.country,
        licence.licenseId, licence.key, licence.status, licence.notes,
        licence.activatedAt, licence.deviceLabel || licence.device, licence.appVersion,
        licence.createdAt, '', '']);
    }
  }

  // The deleted ones too: they are gone from the database and this file is the
  // only place both halves of the record appear together.
  for (const entry of archived()) {
    rows.push([entry.restaurantId, entry.restaurantName, '', '', '', '',
      entry.licenseId, entry.key, entry.status, entry.notes, entry.activatedAt,
      entry.deviceLabel, '', '', entry.deletedAt, entry.reason]);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const link = node('a', {
    href: URL.createObjectURL(blob),
    download: 'qserve-licences-' + stamp + '.csv',
  });
  document.body.append(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  toast('Downloaded ' + (rows.length - 1) + ' row(s)');
});

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
    p_key: key,
    p_key_hash: await sha256Hex(key),
    p_key_hint: key.slice(-5),
    p_actor: session.user.email,
  }).catch((e) => { toast(e.message); return null; });
  if (!out) return;
  event.target.reset();
  toast('Created ' + out.restaurantId);
  await refresh();
});

/* ------------------------------------------------------- telling it we are here

 * The desktop application serves this page and closes itself a minute after
 * the page stops answering, so that a licence console nobody has open is not a
 * process somebody finds in Task Manager and wonders about.
 *
 * Only on localhost, which is the only place there is anything listening.
 */
if (location.protocol === 'http:' && location.hostname === 'localhost') {
  const beat = () => { fetch('/alive', { method: 'POST' }).catch(() => {}); };
  beat();
  setInterval(beat, 10000);
}

/* ------------------------------------------------------------------- boot */

try {
  const record = helloRecord();
  if (record) {
    /*
     * Enrolled: there is no session lying about to restore, only something
     * encrypted that a face opens. The password form is underneath rather than
     * gone — a fingerprint reader that has stopped working is a bad day, not a
     * lockout.
     */
    el('hello-box').hidden = false;
    el('password-box').hidden = true;
    drawArchive();
  } else {
    const stored = localStorage.getItem(SESSION);
    if (stored) {
      session = JSON.parse(stored);
      // A stored token may have expired while the page was closed; one call
      // proves it either way, and failing lands on the sign-in form.
      await rpc('vendor_overview');
      await start();
    } else {
      drawArchive();
    }
  }
} catch (error) {
  session = null;
}
</script>
</body>
</html>`;
