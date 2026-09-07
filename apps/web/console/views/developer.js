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
 */

import { api, guard, t, toast } from '../../shared/boot.js';
import { h, mount, confirmDialog } from '../../shared/dom.js';
import { loadLocales } from '../../shared/i18n.js';
import { pageHeader, reroute } from '../app.js';

const pretty = (value) => JSON.stringify(value, null, 2);

export async function renderDeveloper(container) {
  const [overview, vendor] = await Promise.all([
    api.get('/api/dev/packs'),
    api.get('/api/dev/vendor'),
  ]);

  mount(container,
    pageHeader(t('developer.title')),
    h('p', { class: 'qs-muted' }, t('developer.subtitle')),

    h('div', { class: 'qs-card' },
      h('div', { class: 'qs-grid qs-grid-2' },
        h('div', {},
          h('div', { class: 'qs-section-title' }, t('developer.locales_dir')),
          h('p', { class: 'qs-mono qs-xs' }, overview.localesDir),
          h('p', { class: 'qs-xs qs-muted' },
            `${t('developer.reference')}: ${overview.referenceKeys}`)),
        h('div', {},
          h('div', { class: 'qs-section-title' }, t('developer.themes_dir')),
          h('p', { class: 'qs-mono qs-xs' }, overview.themesDir))),
      h('p', { class: 'qs-xs qs-muted' }, t('developer.strict_note'))),

    rejectedPanel(overview),
    packEditor(container, {
      kind: 'locale',
      title: t('developer.shipped_languages'),
      files: overview.files.locales,
      loaded: overview.locales.loaded.map((entry) => entry.locale),
    }),
    packEditor(container, {
      kind: 'theme',
      title: t('developer.shipped_themes'),
      files: overview.files.themes,
      loaded: overview.themes.loaded,
    }),
    vendorEditor(container, vendor));
}

/** A file on disk that did not load, and the reason. Silence here would hurt. */
function rejectedPanel(overview) {
  const rejected = [
    ...overview.locales.rejected.map((entry) => ({ name: `${entry.locale}.json`, issues: entry.issues })),
    ...overview.themes.rejected.map((entry) => ({ name: `${entry.theme}.json`, issues: entry.issues })),
  ];
  if (rejected.length === 0) return null;

  return h('div', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
    h('h3', {}, t('developer.rejected')),
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
function packEditor(container, { kind, title, files, loaded }) {
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

  return h('div', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
    h('h2', {}, title),

    h('div', { class: 'qs-row', style: { flexWrap: 'wrap' } },
      files.map((file) =>
        h('span', { class: 'qs-badge qs-mono' },
          file,
          h('button', {
            class: 'qs-icon-btn',
            title: t('developer.remove'),
            onClick: async () => {
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
            },
          }, '×')))),

    h('div', { class: 'qs-grid qs-grid-2', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
      h('label', { class: 'qs-field' },
        h('span', {}, isLocale ? t('languages.code') : t('themes.id')), idInput),
      h('label', { class: 'qs-field' },
        h('span', {}, isLocale ? t('languages.name') : t('themes.name')), nameInput),
      englishInput
        ? h('label', { class: 'qs-field' },
            h('span', {}, t('languages.english_name')), englishInput)
        : null,
      directionSelect
        ? h('label', { class: 'qs-field' },
            h('span', {}, t('languages.direction')), directionSelect)
        : null),

    h('div', { class: 'qs-row', style: { flexWrap: 'wrap' } },
      isLocale
        ? h('button', { class: 'qs-btn qs-btn-sm', onClick: () => fetchTemplate(true) },
            t('languages.copy_blank'))
        : null,
      h('label', { class: 'qs-row qs-small' },
        h('span', { class: 'qs-muted' },
          isLocale ? t('languages.source') : t('themes.scheme')),
        fromSelect),
      h('button', { class: 'qs-btn qs-btn-sm', onClick: () => fetchTemplate(false) },
        isLocale ? t('languages.copy_source') : t('themes.copy'))),

    h('label', { class: 'qs-field', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
      h('span', {}, isLocale ? t('languages.paste') : t('themes.paste')), paste),

    report,

    h('div', { class: 'qs-row' },
      h('button', { class: 'qs-btn', onClick: check }, t('developer.check')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        onClick: async () => {
          // Check first so a refusal is explained in the report rather than
          // arriving as one line in a toast.
          const result = await check();
          if (result && (result.errors ?? 0) > 0) return;
          await install();
        },
      }, t('developer.install'))));
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

  return h('div', { class: 'qs-card', style: { marginBlockStart: 'var(--qs-spacing-lg)' } },
    h('h2', {}, t('developer.vendor')),
    h('p', { class: 'qs-muted qs-small' }, t('developer.vendor_intro')),
    h('p', { class: 'qs-mono qs-xs' }, vendor.file),
    vendor.info
      ? null
      : h('p', { class: 'qs-badge qs-badge-text' }, t('developer.vendor_none')),

    h('div', { class: 'qs-row' },
      h('button', {
        class: 'qs-btn qs-btn-sm',
        onClick: () => { paste.value = pretty(vendor.template); },
      }, t('developer.vendor_copy'))),

    h('label', { class: 'qs-field', style: { marginBlockStart: 'var(--qs-spacing-md)' } },
      h('span', {}, t('themes.paste')), paste),

    h('div', { class: 'qs-row' },
      h('button', { class: 'qs-btn qs-btn-primary', onClick: save }, t('common.save'))));
}
