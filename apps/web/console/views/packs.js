/**
 * Languages and themes the restaurant adds for itself (spec §32, §33).
 *
 * The workflow is three steps an owner can do alone, with no account, no API
 * key and no integration:
 *
 *     1. copy the JSON     2. translate it anywhere     3. paste it back
 *
 * What makes it a *whole* language rather than a translated frame is what is in
 * the file: every interface string, and every word the owner ever typed — the
 * categories, the dishes, the descriptions, the options and their choices, the
 * add-ons, the station and role names. Translate the file and the menu on a
 * diner's phone changes with it.
 *
 * Themes work the same way, with design tokens instead of sentences.
 */

import { api, guard, t, toast } from '../../shared/boot.js';
import { h, mount, modal, confirmDialog } from '../../shared/dom.js';
import { loadLocales } from '../../shared/i18n.js';
import { pageHeader, reroute } from '../app.js';

/**
 * Redraw everything after a pack changes.
 *
 * A language that has just been added has to reach the pickers in the topbar
 * too, not only this page — otherwise the owner saves a language and cannot
 * select it — so the locale list is reloaded and the whole shell re-rendered.
 */
async function refreshAll() {
  await loadLocales().catch(() => {});
  await reroute();
}

/* ------------------------------------------------------------- clipboard */

/**
 * Copying is the first step of the whole workflow, so it must not fail
 * silently. The textarea fallback exists because the clipboard API needs a
 * secure context, and a console reached over plain http on the LAN is not one.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', {
      style: { position: 'fixed', inset: '0', opacity: '0' },
    });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }
  toast(t('languages.copied'), 'success');
}

/** Offer the same JSON as a file, for an owner who would rather email it. */
function downloadJson(fileName, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = h('a', { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const pretty = (value) => JSON.stringify(value, null, 2);

/* ------------------------------------------------------------- languages */

export async function renderLanguages(container) {
  const [{ languages }, status] = await Promise.all([
    api.get('/api/languages'),
    api.get('/api/system'),
  ]);
  const enabled = new Set((status.locales ?? []).filter((l) => l.enabled).map((l) => l.locale));

  /**
   * One language, one line: what it is called, what it is, and how far along.
   *
   * The four pills this used to carry (default, shown, direction, built-in)
   * said in colour what a muted sentence says in words, four times per row.
   * Only being the default earns a mark, because only one row can have it.
   */
  const row = (language) => {
    const { coverage } = language;
    const facts = [
      language.englishName,
      language.locale,
      t(language.shipped ? 'languages.shipped' : 'languages.authored'),
      enabled.has(language.locale) ? null : t('common.hidden'),
    ].filter(Boolean);

    return h('div', { class: 'qs-row-item' },
      h('div', {},
        h('div', { class: 'qs-row-label' },
          language.name,
          language.isDefault
            ? h('span', { class: 'qs-badge qs-badge-success' }, t('languages.default'))
            : null),
        h('p', { class: 'qs-row-hint' }, facts.join(' · ')),

        h('div', { class: 'coverage' },
          h('div', { class: 'coverage-bar' },
            h('span', { style: { inlineSize: `${coverage.percent}%` } })),
          h('span', { class: 'qs-xs qs-muted' },
            `${t('languages.coverage')} ${coverage.percent}%`,
            ` · ${t('languages.ui_section')} ${coverage.uiTranslated}/${coverage.uiTotal}`,
            ` · ${t('languages.content_section')} ${coverage.contentTranslated}/${coverage.contentTotal}`))),

      h('div', { class: 'qs-row-control' },
        h('button', {
          class: 'qs-btn qs-btn-sm',
          onClick: () => openLanguageEditor(container, language, languages),
        }, t('common.edit')),

        h('button', {
          class: 'qs-btn qs-btn-sm qs-btn-ghost',
          onClick: async () => {
            const bundle = await guard(() =>
              api.get(`/api/languages/${language.locale}/bundle?mode=current`));
            if (bundle) await copyText(pretty(bundle));
          },
        }, t('languages.copy')),

        language.authored
          ? h('button', {
              class: 'qs-btn qs-btn-sm qs-btn-ghost',
              title: t('languages.delete'),
              onClick: async () => {
                const ok = await confirmDialog({
                  title: t('languages.delete'),
                  message: t('languages.delete_confirm'),
                  confirmLabel: t('common.delete'),
                  cancelLabel: t('common.cancel'),
                });
                if (!ok) return;
                const done = await guard(() => api.del(`/api/languages/${language.locale}`));
                if (!done) return;
                await refreshAll();
              },
            }, t('common.delete'))
          : null));
  };

  mount(container,
    pageHeader(t('languages.title'),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        onClick: () => openLanguageEditor(container, null, languages),
      }, t('languages.add'))),

    h('section', { class: 'qs-panel' },
      h('div', { class: 'qs-panel-head' },
        h('p', {}, t('languages.subtitle'))),
      h('div', { class: 'qs-card qs-narrow' },
        h('div', { class: 'qs-rows' }, languages.map(row)))));
}

/**
 * Add or edit one language.
 *
 * The three steps are laid out in order down the dialog, because the order is
 * the instruction: an owner who reads top to bottom has done it correctly.
 */
function openLanguageEditor(container, language, languages) {
  const isNew = language === null;
  const sources = languages.filter((entry) => entry.coverage.uiTranslated > 0);

  const codeInput = h('input', {
    name: 'locale', required: true, maxlength: '35',
    pattern: '[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*',
    value: language?.locale ?? '',
    readonly: !isNew,
    placeholder: 'fr',
  });
  const nameInput = h('input', {
    name: 'name', required: true, maxlength: '60', value: language?.name ?? '',
    placeholder: 'Français',
  });
  const englishInput = h('input', {
    name: 'englishName', maxlength: '60', value: language?.englishName ?? '',
    placeholder: 'French',
  });
  const directionSelect = h('select', { name: 'direction' },
    h('option', { value: 'ltr', selected: (language?.direction ?? 'ltr') === 'ltr' },
      t('languages.direction_ltr')),
    h('option', { value: 'rtl', selected: language?.direction === 'rtl' },
      t('languages.direction_rtl')));

  const sourceSelect = h('select', { name: 'sourceLocale' },
    sources.map((entry) =>
      h('option', { value: entry.locale, selected: entry.isDefault }, entry.name)));

  const paste = h('textarea', {
    name: 'bundle', rows: '14', spellcheck: 'false',
    class: 'qs-mono qs-small',
    placeholder: '{ "$schema": "qserve.translation.bundle.v1", … }',
  });

  const enableCheck = h('input', { type: 'checkbox', name: 'enable', checked: true });

  /** Fetch the JSON for the chosen starting point and hand it to the owner. */
  const fetchBundle = async (mode, { download = false } = {}) => {
    const locale = codeInput.value.trim() || language?.locale;
    if (!locale) {
      toast(t('languages.code_help'), 'error');
      return;
    }
    const params = new URLSearchParams({
      mode,
      sourceLocale: sourceSelect.value,
      name: nameInput.value.trim(),
      englishName: englishInput.value.trim(),
      direction: directionSelect.value,
    });
    const bundle = await guard(() =>
      api.get(`/api/languages/${encodeURIComponent(locale)}/bundle?${params}`));
    if (!bundle) return;

    const text = pretty(bundle);
    if (download) downloadJson(`${locale}.qserve-translation.json`, text);
    else await copyText(text);
    // Seeing the file is half the reassurance; the owner pastes over it.
    paste.value = text;
  };

  const save = async () => {
    if (paste.value.trim() === '') {
      toast(t('languages.paste'), 'error');
      return false;
    }
    try {
      JSON.parse(paste.value);
    } catch {
      // A stray comma or a half-copied file: say so here rather than sending
      // three megabytes to the server to be told the same thing.
      toast(t('languages.invalid_json'), 'error');
      return false;
    }
    const result = await guard(() => api.post('/api/languages', {
      bundle: paste.value,
      locale: codeInput.value.trim(),
      name: nameInput.value.trim(),
      englishName: englishInput.value.trim(),
      direction: directionSelect.value,
      enable: enableCheck.checked,
    }));
    if (!result) return false;

    toast(t('languages.saved', { ui: result.ui, content: result.content.applied }), 'success');
    if (result.content.skippedUnknown.length > 0) {
      toast(t('languages.skipped', { count: result.content.skippedUnknown.length }), 'info');
    }
    await refreshAll();
    return true;
  };

  const step = (number, titleKey, ...body) =>
    h('section', { class: 'pack-step' },
      h('h3', {}, t(titleKey)),
      ...body);

  let saved = false;
  const dialog = modal({
    title: isNew ? t('languages.add') : `${t('common.edit')} — ${language.name}`,
    body: h('div', { class: 'pack-editor' },
      h('div', { class: 'qs-grid qs-grid-2' },
        h('label', { class: 'qs-field' },
          h('span', {}, t('languages.code')), codeInput,
          h('small', { class: 'qs-muted' }, t('languages.code_help'))),
        h('label', { class: 'qs-field' },
          h('span', {}, t('languages.direction')), directionSelect),
        h('label', { class: 'qs-field' },
          h('span', {}, t('languages.name')), nameInput),
        h('label', { class: 'qs-field' },
          h('span', {}, t('languages.english_name')), englishInput)),

      step(1, 'languages.step_one',
        h('p', { class: 'qs-muted qs-small' }, t('languages.content_explain')),
        h('div', { class: 'qs-row', style: { flexWrap: 'wrap' } },
          h('button', {
            type: 'button', class: 'qs-btn qs-btn-sm',
            onClick: () => fetchBundle('template'),
          }, t('languages.copy_blank')),
          h('label', { class: 'qs-row qs-small' },
            h('span', { class: 'qs-muted' }, t('languages.source')), sourceSelect),
          h('button', {
            type: 'button', class: 'qs-btn qs-btn-sm',
            onClick: () => fetchBundle('source'),
          }, t('languages.copy_source')),
          isNew ? null : h('button', {
            type: 'button', class: 'qs-btn qs-btn-sm',
            onClick: () => fetchBundle('current'),
          }, t('languages.copy_current')),
          h('button', {
            type: 'button', class: 'qs-btn qs-btn-sm qs-btn-ghost',
            onClick: () => fetchBundle('source', { download: true }),
          }, t('languages.download')))),

      step(2, 'languages.step_two',
        h('p', { class: 'qs-muted qs-small' }, t('languages.subtitle'))),

      step(3, 'languages.step_three',
        paste,
        h('label', { class: 'qs-check' }, enableCheck, h('span', {}, t('languages.enable'))))),

    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          // The dialog would close on its own; hold it open until the paste is
          // accepted, so a validation message is not lost behind it.
          event.preventDefault();
          saved = await save();
          if (saved) dialog.close('save');
        },
      }, t('common.save')),
    ],
  });
}

/* ---------------------------------------------------------------- themes */

export async function renderThemes(container) {
  const { themes } = await api.get('/api/themes-authoring');

  /** One theme, one line. Only the one in use is marked. */
  const row = (theme) => h('div', { class: 'qs-row-item' },
    h('div', {},
      h('div', { class: 'qs-row-label' },
        theme.name,
        theme.active ? h('span', { class: 'qs-badge qs-badge-success' }, t('themes.active')) : null),
      h('p', { class: 'qs-row-hint' },
        [
          theme.id,
          t(theme.colorScheme === 'dark' ? 'themes.scheme_dark' : 'themes.scheme_light'),
          t(theme.shipped ? 'languages.shipped' : 'languages.authored'),
        ].join(' · '))),

    h('div', { class: 'qs-row-control' },
      h('button', {
        class: 'qs-btn qs-btn-sm',
        onClick: () => openThemeEditor(container, theme),
      }, t('common.edit')),

      h('button', {
        class: 'qs-btn qs-btn-sm qs-btn-ghost',
        onClick: async () => {
          const pack = await guard(() => api.get(`/api/themes-authoring/${theme.id}/pack`));
          if (pack) await copyText(pretty(pack));
        },
      }, t('common.copy')),

      theme.authored
        ? h('button', {
            class: 'qs-btn qs-btn-sm qs-btn-ghost',
            title: t('themes.delete'),
            onClick: async () => {
              const ok = await confirmDialog({
                title: t('themes.delete'),
                message: t('themes.delete_confirm'),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
              });
              if (!ok) return;
              const done = await guard(() => api.del(`/api/themes-authoring/${theme.id}`));
              if (done === undefined) return;
              await refreshAll();
            },
          }, t('common.delete'))
        : null));

  mount(container,
    pageHeader(t('themes.title'),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        onClick: () => openThemeEditor(container, null),
      }, t('themes.add'))),

    h('section', { class: 'qs-panel' },
      h('div', { class: 'qs-panel-head' },
        h('p', {}, t('themes.subtitle'))),
      h('div', { class: 'qs-card qs-narrow' },
        h('div', { class: 'qs-rows' }, themes.map(row)))));
}

function openThemeEditor(container, theme) {
  const isNew = theme === null;

  const idInput = h('input', {
    name: 'id', required: true, maxlength: '32', pattern: '[a-z0-9\\-]{2,32}',
    value: theme?.id ?? '', readonly: !isNew && theme.authored, placeholder: 'sunset',
  });
  const nameInput = h('input', {
    name: 'name', required: true, maxlength: '60', value: theme?.name ?? '',
  });
  const paste = h('textarea', {
    name: 'theme', rows: '16', spellcheck: 'false', class: 'qs-mono qs-small',
    placeholder: '{ "$schema": "qserve.theme.v1", … }',
  });

  const loadPack = async (sourceId) => {
    const pack = await guard(() => api.get(`/api/themes-authoring/${sourceId}/pack`));
    if (!pack) return;
    paste.value = pretty(pack);
    await copyText(paste.value);
  };

  // Editing an existing theme starts from its own tokens; a new one starts from
  // whichever theme is in use, because that is the one the owner is looking at.
  void loadPack(theme?.id ?? 'light');

  const dialog = modal({
    title: isNew ? t('themes.add') : `${t('common.edit')} — ${theme.name}`,
    body: h('div', { class: 'pack-editor' },
      h('div', { class: 'qs-grid qs-grid-2' },
        h('label', { class: 'qs-field' },
          h('span', {}, t('themes.id')), idInput,
          h('small', { class: 'qs-muted' }, t('themes.id_help'))),
        h('label', { class: 'qs-field' },
          h('span', {}, t('themes.name')), nameInput)),

      h('p', { class: 'qs-muted qs-small' }, t('themes.tokens_explain')),
      h('label', { class: 'qs-field' },
        h('span', {}, t('themes.paste')), paste)),

    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        value: 'save',
        onClick: async (event) => {
          event.preventDefault();
          try {
            JSON.parse(paste.value);
          } catch {
            toast(t('languages.invalid_json'), 'error');
            return;
          }
          const result = await guard(() => api.post('/api/themes-authoring', {
            theme: paste.value,
            id: idInput.value.trim(),
            name: nameInput.value.trim(),
          }));
          if (!result) return;
          toast(t('themes.saved'), 'success');
          dialog.close('save');
          await refreshAll();
        },
      }, t('common.save')),
    ],
  });
}
