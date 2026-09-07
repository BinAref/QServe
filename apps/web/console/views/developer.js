/**
 * Developer mode: authoring the packs the product ships with (spec §30).
 *
 * The same three steps a restaurant owner follows, one level lower. An owner
 * adds a language to their restaurant and it lives in their database; the
 * developer adds a language to QServe and it becomes a file in `locales/` —
 * shipped with the product, and the language every restaurant then translates
 * their own menu from.
 *
 * The difference that matters is strictness. A restaurant may paste a partial
 * translation and let the rest fall back; a shipped pack may not, because a key
 * missing here is a key missing in every restaurant.
 *
 * Three jobs, so three tabs: the languages that ship, the themes that ship, and
 * who the restaurant pays. Each one shows what is installed as a list, and puts
 * the authoring form — five fields and a page of JSON — behind "add", because
 * this screen is opened to check what shipped far more often than to write a
 * new pack.
 */

import { api, guard, t, toast } from '../../shared/boot.js';
import { h, mount, confirmDialog, entered } from '../../shared/dom.js';
import { loadLocales } from '../../shared/i18n.js';
import { pageHeader, reroute } from '../app.js';

const pretty = (value) => JSON.stringify(value, null, 2);

const DEVELOPER_SECTIONS = [
  { id: 'locales', label: 'developer.shipped_languages' },
  { id: 'themes', label: 'developer.shipped_themes' },
  { id: 'vendor', label: 'developer.vendor_tab' },
];

// Survives a repaint, so saving a theme does not throw the developer back to
// the languages tab.
let developerSection = 'locales';

export async function renderDeveloper(container) {
  const [overview, vendor] = await Promise.all([
    api.get('/api/dev/packs'),
    api.get('/api/dev/vendor'),
  ]);

  const body = h('div', {});
  const paint = () => {
    entered(body);
    if (developerSection === 'vendor') {
      mount(body, vendorEditor(container, vendor));
      return;
    }
    const isLocale = developerSection === 'locales';
    mount(body, packEditor(container, {
      kind: isLocale ? 'locale' : 'theme',
      title: t(isLocale ? 'developer.shipped_languages' : 'developer.shipped_themes'),
      folder: isLocale ? overview.localesDir : overview.themesDir,
      reference: isLocale ? overview.referenceKeys : null,
      files: isLocale ? overview.files.locales : overview.files.themes,
      loaded: isLocale
        ? overview.locales.loaded.map((entry) => entry.locale)
        : overview.themes.loaded,
      rejected: isLocale
        ? overview.locales.rejected.map((entry) => ({ name: `${entry.locale}.json`, issues: entry.issues }))
        : overview.themes.rejected.map((entry) => ({ name: `${entry.theme}.json`, issues: entry.issues })),
    }));
  };

  mount(container,
    pageHeader(t('developer.title')),

    h('div', { class: 'qs-tabs', role: 'tablist' },
      DEVELOPER_SECTIONS.map((section) => h('button', {
        class: 'qs-tab',
        role: 'tab',
        'aria-selected': String(section.id === developerSection),
        onClick: (event) => {
          developerSection = section.id;
          for (const tab of event.target.parentElement.children) {
            tab.setAttribute('aria-selected', String(tab === event.target));
          }
          paint();
        },
      }, t(section.label)))),

    body);

  paint();
}

/** A file on disk that did not load, and the reason. Silence here would hurt. */
function rejectedPanel(rejected) {
  if (rejected.length === 0) return null;

  return h('details', { class: 'qs-details' },
    h('summary', {},
      h('span', {}, t('developer.rejected')),
      h('span', { class: 'qs-summary' }, String(rejected.length))),
    rejected.map((entry) =>
      h('div', {},
        h('strong', { class: 'qs-mono qs-small' }, entry.name),
        h('ul', { class: 'qs-xs qs-muted' },
          entry.issues.slice(0, 8).map((issue) =>
            h('li', {}, `${issue.kind} ${issue.key ?? issue.token ?? ''} — ${issue.detail}`))))));
}

/**
 * One editor, used for both kinds. The two differ only in their endpoints and
 * in what identifies a pack, so writing it twice would only invite drift.
 */
function packEditor(container, { kind, title, folder, reference, files, loaded, rejected }) {
  const isLocale = kind === 'locale';
  const base = isLocale ? '/api/dev/locales' : '/api/dev/themes';

  const idInput = h('input', {
    maxlength: '35',
    placeholder: isLocale ? 'fr' : 'sunset',
    pattern: isLocale ? '[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*' : '[a-z0-9\\-]{2,32}',
  });
  const fromSelect = h('select', {},
    loaded.map((entry) => h('option', { value: entry }, entry)));
  const nameInput = h('input', { maxlength: '60', placeholder: isLocale ? 'Français' : 'Sunset' });
  const englishInput = isLocale
    ? h('input', { maxlength: '60', placeholder: 'French' })
    : null;
  const directionSelect = isLocale
    ? h('select', {},
        h('option', { value: 'ltr' }, t('languages.direction_ltr')),
        h('option', { value: 'rtl' }, t('languages.direction_rtl')))
    : null;

  const paste = h('textarea', { rows: '14', spellcheck: 'false', class: 'qs-mono qs-small' });
  const report = h('div', { class: 'qs-small' });

  const identifier = () => idInput.value.trim();

  const fetchTemplate = async (blank) => {
    const id = identifier();
    if (!id) {
      toast(isLocale ? t('languages.code_help') : t('themes.id_help'), 'error');
      return;
    }
    const params = new URLSearchParams();
    if (!blank) params.set('from', fromSelect.value);
    if (isLocale) {
      params.set('name', nameInput.value.trim());
      params.set('englishName', englishInput.value.trim());
      params.set('direction', directionSelect.value);
    }
    const pack = await guard(() =>
      api.get(`${base}/${encodeURIComponent(id)}/template?${params}`));
    if (!pack) return;
    if (!isLocale) pack.name = nameInput.value.trim() || pack.name;
    paste.value = pretty(pack);
    mount(report);
  };

  const check = async () => {
    const result = await guard(() => api.post(`${base}/check`, { pack: paste.value }));
    if (!result) return null;

    const errors = result.errors ?? 0;
    const warnings = result.warnings ?? 0;
    mount(report,
      errors === 0 && warnings === 0
        ? h('p', { class: 'qs-badge qs-badge-success' }, t('developer.no_issues'))
        : h('p', { class: errors > 0 ? 'qs-badge qs-badge-error' : 'qs-badge qs-badge-warning' },
            t('developer.issues', { errors, warnings })),
      h('ul', { class: 'qs-xs qs-muted' },
        result.issues.slice(0, 25).map((issue) =>
          h('li', {}, `${issue.kind} ${issue.key ?? issue.token ?? ''} — ${issue.detail}`))));
    return result;
  };

  const install = async () => {
    const result = await guard(() => api.post(base, { pack: paste.value }));
    if (!result) return;
    toast(t('developer.installed', { file: result.file }), 'success');
    await loadLocales().catch(() => {});
    await reroute();
  };

  const remove = async (file) => {
    const id = file.replace(/\.json$/, '');
    const ok = await confirmDialog({
      title: t('developer.remove'),
      message: t('developer.remove_confirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    const done = await guard(() => api.del(`${base}/${encodeURIComponent(id)}`));
    if (done === undefined) return;
    await loadLocales().catch(() => {});
    await reroute();
  };

  /** One field of the new pack, on the same line as its label. */
  const field = (label, control) => h('div', { class: 'qs-row-item' },
    h('div', {}, h('div', { class: 'qs-row-label' }, label)),
    h('div', { class: 'qs-row-control' }, control));

  // The tab above already names this section; a heading repeating it would be
  // the same three words twice, eight pixels apart.
  return h('section', { class: 'qs-panel', 'aria-label': title },
    h('div', { class: 'qs-panel-head' },
      h('p', {}, t('developer.strict_note')),
      h('p', { class: 'qs-mono qs-xs qs-muted' },
        folder,
        reference === null ? '' : ` · ${t('developer.reference')} ${reference}`)),

    h('div', { class: 'qs-card qs-narrow' },
      // What shipped, one per line: the file, and the one thing you can do to
      // it. A grid of pills with an × in each was a row of small targets.
      h('div', { class: 'qs-rows' },
        files.map((file) =>
          h('div', { class: 'qs-row-item' },
            h('div', {}, h('div', { class: 'qs-row-label qs-mono qs-small' }, file)),
            h('div', { class: 'qs-row-control' },
              h('button', {
                class: 'qs-btn qs-btn-ghost qs-btn-sm',
                title: t('developer.remove'),
                onClick: () => void remove(file),
              }, t('common.delete')))))),

      rejectedPanel(rejected),

      h('details', { class: 'qs-details' },
        h('summary', {}, isLocale ? t('languages.add') : t('themes.add')),
        h('div', { class: 'qs-form' },
          h('div', { class: 'qs-rows' },
            field(isLocale ? t('languages.code') : t('themes.id'), idInput),
            field(isLocale ? t('languages.name') : t('themes.name'), nameInput),
            englishInput ? field(t('languages.english_name'), englishInput) : null,
            directionSelect ? field(t('languages.direction'), directionSelect) : null,
            field(isLocale ? t('languages.source') : t('themes.scheme'),
              h('div', { class: 'qs-row' },
                fromSelect,
                h('button', { class: 'qs-btn qs-btn-sm', onClick: () => fetchTemplate(false) },
                  t('common.copy'))))),

          isLocale
            ? h('p', { class: 'qs-row-hint' },
                h('button', {
                  class: 'qs-btn qs-btn-ghost qs-btn-sm',
                  onClick: () => fetchTemplate(true),
                }, t('languages.copy_blank')))
            : null,

          h('label', { class: 'qs-field' },
            h('span', {}, isLocale ? t('languages.paste') : t('themes.paste')), paste),

          report,

          h('div', { class: 'qs-row' },
            h('button', { class: 'qs-btn', onClick: check }, t('developer.check')),
            h('button', {
              class: 'qs-btn qs-btn-primary',
              onClick: async () => {
                // Check first so a refusal is explained in the report rather
                // than arriving as one line in a toast.
                const result = await check();
                if (result && (result.errors ?? 0) > 0) return;
                await install();
              },
            }, t('developer.install')))))));
}

/* ------------------------------------------------------------ vendor info */

/**
 * The vendor's own name, prices and contact channels, written into the build.
 *
 * This is the answer to the first question a restaurant asks — *who do I pay,
 * and how much* — and it has to survive having no internet, because a
 * restaurant that has just unzipped QServe has never spoken to anything. What
 * the licence server later hands over replaces it; until then this is what the
 * licence screen shows.
 */
function vendorEditor(container, vendor) {
  const paste = h('textarea', {
    rows: '16', spellcheck: 'false', class: 'qs-mono qs-xs',
  }, pretty(vendor.info ?? vendor.template));

  const save = async () => {
    const saved = await guard(() => api.put('/api/dev/vendor', { vendor: paste.value }));
    if (!saved) return;
    toast(t('common.saved'), 'success');
    await renderDeveloper(container);
  };

  return h('section', { class: 'qs-panel', 'aria-label': t('developer.vendor') },
    h('div', { class: 'qs-panel-head' },
      h('h2', {}, t('developer.vendor')),
      h('p', {}, t('developer.vendor_intro'))),

    h('div', { class: 'qs-card qs-form' },
      h('p', { class: 'qs-mono qs-xs qs-muted' },
        vendor.file,
        vendor.info ? '' : ` · ${t('developer.vendor_none')}`),

      h('label', { class: 'qs-field' },
        h('span', {}, t('developer.vendor_paste')), paste),

      h('div', { class: 'qs-row' },
        h('button', { class: 'qs-btn qs-btn-primary', onClick: save }, t('common.save')),
        h('button', {
          class: 'qs-btn qs-btn-ghost qs-btn-sm',
          onClick: () => { paste.value = pretty(vendor.template); },
        }, t('developer.vendor_copy')))));
}
