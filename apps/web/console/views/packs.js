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

/**
 * The theme editor.
 *
 * It used to be a JSON textarea. That is a fine tool for whoever wrote the
 * token contract and a wall for the person who actually wants their menu to
 * be green: an owner should not have to learn what "surfaceAlt" is, or that a
 * missing comma means their restaurant has no theme.
 *
 * So the colours that matter are pickers, in the words a restaurant would use,
 * and the menu is drawn next to them as they change. Everything else in the
 * contract — spacing, motion, the component overrides — is inherited from the
 * theme this one started as and never shown, because nobody has ever wanted to
 * change the easing curve of a modal in order to open a restaurant.
 *
 * The full JSON is still there, behind a fold, for the case this is wrong.
 */

/** The handful worth putting in front of somebody, in the order they matter. */
const THEME_COLOURS = [
  ['primary', 'themes.colour_primary'],
  ['background', 'themes.colour_background'],
  ['surface', 'themes.colour_surface'],
  ['text', 'themes.colour_text'],
  ['textMuted', 'themes.colour_text_muted'],
  ['border', 'themes.colour_border'],
];

const ROUNDNESS = [
  ['sharp', 'themes.roundness_sharp', { sm: '0px', md: '0px', lg: '0px', pill: '999px' }],
  ['soft', 'themes.roundness_soft', { sm: '6px', md: '10px', lg: '16px', pill: '999px' }],
  ['round', 'themes.roundness_round', { sm: '10px', md: '18px', lg: '26px', pill: '999px' }],
];

/** A colour a picker can show: it only speaks #rrggbb. */
function asHex(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim()
    : fallback;
}

function openThemeEditor(container, theme) {
  const isNew = theme === null;
  let pack = null;

  const idInput = h('input', {
    name: 'id', required: true, maxlength: '32', pattern: '[a-z0-9\\-]{2,32}',
    value: theme?.id ?? '', readonly: !isNew && theme.authored, placeholder: 'sunset',
  });
  const nameInput = h('input', {
    name: 'name', required: true, maxlength: '60', value: theme?.name ?? '',
  });

  const scheme = h('select', { name: 'colorScheme' },
    h('option', { value: 'light' }, t('themes.scheme_light')),
    h('option', { value: 'dark' }, t('themes.scheme_dark')));

  const preview = h('div', { class: 'theme-preview' });
  const swatches = h('div', { class: 'theme-swatches' });
  const advanced = h('textarea', {
    name: 'theme', rows: '14', spellcheck: 'false', class: 'qs-mono qs-small',
  });

  /* --------------------------------------------------------- the preview */

  /*
   * The menu, drawn in the colours being chosen.
   *
   * Not a swatch grid: a swatch grid tells you what the colours are, and this
   * has to tell you what the menu will look like. Every choice lands here
   * immediately, because the question an owner is answering is "does this look
   * right", and that question has no answer until they can see it.
   */
  const drawPreview = () => {
    if (!pack) return;
    const c = pack.tokens.color;
    const r = pack.tokens.radius ?? {};
    preview.style.cssText = 'background:' + c.background + ';color:' + c.text
      + ';border-color:' + c.border + ';border-radius:' + (r.lg ?? '16px');

    mount(preview,
      h('div', {
        class: 'theme-preview-card',
        style: 'background:' + c.surface + ';border:1px solid ' + c.border
          + ';border-radius:' + (r.md ?? '10px'),
      },
        h('div', { class: 'theme-preview-title', style: 'color:' + c.text },
          t('themes.preview_dish')),
        h('div', { class: 'theme-preview-note', style: 'color:' + c.textMuted },
          t('themes.preview_note')),
        h('div', { class: 'theme-preview-row' },
          h('span', { style: 'color:' + c.primary + ';font-weight:650' }, '45.00'),
          h('button', {
            type: 'button',
            style: 'background:' + c.primary + ';color:' + (c.primaryContrast ?? '#fff')
              + ';border:0;border-radius:' + (r.sm ?? '6px') + ';padding:8px 14px;font:inherit',
          }, t('menu.add_to_order')))));
  };

  const drawSwatches = () => {
    if (!pack) return;
    mount(swatches, THEME_COLOURS.map(([key, labelKey]) => {
      const current = asHex(pack.tokens.color[key], '#000000');
      const picker = h('input', {
        type: 'color', value: current,
        onInput: (event) => {
          pack.tokens.color[key] = event.target.value;
          // Two tokens are the same decision wearing different names: an owner
          // choosing an accent has not also agreed to an unreadable focus ring.
          if (key === 'primary') {
            pack.tokens.color.focusRing = event.target.value;
            pack.tokens.color.lit = event.target.value;
          }
          advanced.value = pretty(pack);
          drawPreview();
        },
      });
      return h('label', { class: 'theme-swatch' },
        picker,
        h('span', {}, t(labelKey)));
    }));
  };

  const roundness = h('div', { class: 'theme-roundness' },
    ROUNDNESS.map(([value, labelKey, radii]) => h('button', {
      type: 'button', class: 'qs-btn qs-btn-sm',
      onClick: () => {
        if (!pack) return;
        pack.tokens.radius = { ...pack.tokens.radius, ...radii };
        advanced.value = pretty(pack);
        drawPreview();
      },
    }, t(labelKey))));

  /* ------------------------------------------------------------ loading */

  const loadPack = async (sourceId) => {
    const loaded = await guard(() => api.get('/api/themes-authoring/' + sourceId + '/pack'));
    if (!loaded) return;
    pack = loaded;
    pack.tokens = pack.tokens ?? {};
    pack.tokens.color = pack.tokens.color ?? {};
    scheme.value = pack.colorScheme === 'dark' ? 'dark' : 'light';
    advanced.value = pretty(pack);
    drawSwatches();
    drawPreview();
  };

  // Editing starts from this theme's own tokens; a new one starts from whichever
  // theme is in use, because that is the one the owner is looking at.
  void loadPack(theme?.id ?? 'light');

  scheme.addEventListener('change', () => {
    if (!pack) return;
    pack.colorScheme = scheme.value;
    advanced.value = pretty(pack);
  });

  // The fold: whoever wants the whole contract can have it, and typing in it
  // wins over the pickers, because somebody who opened this knows what they
  // are doing.
  advanced.addEventListener('input', () => {
    try {
      const parsed = JSON.parse(advanced.value);
      if (parsed && typeof parsed === 'object' && parsed.tokens?.color) {
        pack = parsed;
        drawSwatches();
        drawPreview();
      }
    } catch {
      // Half-typed JSON is not an error, it is somebody in the middle of a word.
    }
  });

  const dialog = modal({
    title: isNew ? t('themes.add') : t('themes.edit'),
    body: h('div', { class: 'theme-editor' },
      h('div', { class: 'qs-row' },
        h('label', { class: 'qs-field' }, h('span', {}, t('common.name')), nameInput),
        h('label', { class: 'qs-field' }, h('span', {}, t('themes.id')), idInput)),
      h('label', { class: 'qs-field' }, h('span', {}, t('themes.scheme')), scheme),

      h('div', {},
        h('div', { class: 'qs-section-title' }, t('themes.colours')),
        swatches,
        h('div', { class: 'qs-section-title' }, t('themes.roundness')),
        roundness),

      h('div', {},
        h('div', { class: 'qs-section-title' }, t('themes.preview')),
        preview),

      h('details', { class: 'qs-details' },
        h('summary', {}, t('themes.advanced')),
        advanced)),
    actions: [
      h('button', { class: 'qs-btn', value: 'cancel' }, t('common.cancel')),
      h('button', {
        class: 'qs-btn qs-btn-primary',
        onClick: async () => {
          let parsed;
          try {
            parsed = JSON.parse(advanced.value);
          } catch {
            toast(t('themes.invalid_json'), 'error');
            return;
          }
          parsed.id = idInput.value.trim();
          parsed.name = nameInput.value.trim();
          parsed.colorScheme = scheme.value;

          const saved = await guard(() => api.post('/api/themes-authoring', {
            id: parsed.id, name: parsed.name, theme: parsed,
          }));
          if (!saved) return;
          dialog.close();
          await renderThemes(container);
        },
      }, t('common.save')),
    ],
  });
}
