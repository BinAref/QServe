/**
 * The locale and theme pack contracts (spec §32, §33).
 *
 * These are what make "add a language by adding a file" safe: if the validator
 * is wrong, a bad pack reaches a cashier screen mid-service.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCALE_SCHEMA_ID, LocaleIssueKind, findDuplicateKeys, hasBlockingIssues,
  interpolate, validateLocalePack, type LocalePack,
} from './i18n.js';
import {
  REQUIRED_TOKENS, THEME_SCHEMA_ID, ThemeIssueKind, flattenTokens, resolveTokens,
  themeToCssText, tokenPathToCssVariable, validateThemePack,
  type ThemePack, type TokenTree,
} from './theme.js';

const reference: LocalePack = {
  $schema: LOCALE_SCHEMA_ID,
  locale: 'en',
  name: 'English',
  englishName: 'English',
  direction: 'ltr',
  fallback: null,
  strings: { 'app.name': 'QServe', 'orders.order_number': 'Order #{number}' },
};

const kinds = (issues: readonly { kind: string }[]): string[] => issues.map((i) => i.kind);

test('a well-formed reference pack validates clean', () => {
  assert.deepEqual(validateLocalePack(reference), []);
});

test('an invalid key is rejected', () => {
  const issues = validateLocalePack({
    ...reference, locale: 'tr', fallback: 'en',
    strings: { 'orders.status.NEW': 'Yeni' },
  }, { reference });
  assert.ok(kinds(issues).includes(LocaleIssueKind.INVALID_KEY));
});

test('a key the reference does not define is rejected', () => {
  const issues = validateLocalePack({
    ...reference, locale: 'tr', fallback: 'en',
    strings: { ...reference.strings, 'app.invented': 'x' },
  }, { reference });
  assert.ok(kinds(issues).includes(LocaleIssueKind.UNSUPPORTED_KEY));
});

test('a missing key is a warning, or an error under strict coverage', () => {
  const partial = { ...reference, locale: 'tr', fallback: 'en', strings: { 'app.name': 'QServe' } };

  const lenient = validateLocalePack(partial, { reference });
  assert.equal(hasBlockingIssues(lenient), false, 'a partial translation still ships');
  assert.ok(kinds(lenient).includes(LocaleIssueKind.MISSING_KEY));

  const strict = validateLocalePack(partial, { reference, strictCoverage: true });
  assert.ok(hasBlockingIssues(strict), 'CI can demand full coverage');
});

test('a placeholder dropped in translation is caught', () => {
  // The failure this prevents: "Order #" with no number, on every ticket.
  const issues = validateLocalePack({
    ...reference, locale: 'tr', fallback: 'en',
    strings: { ...reference.strings, 'orders.order_number': 'Sipariş' },
  }, { reference });
  assert.ok(kinds(issues).includes(LocaleIssueKind.PLACEHOLDER_MISMATCH));
});

test('duplicate keys are found in the source, which JSON.parse hides', () => {
  const raw = `{"strings":{"app.name":"One","app.name":"Two"}}`;
  assert.deepEqual(findDuplicateKeys(raw), ['app.name']);

  const issues = validateLocalePack(JSON.parse(raw) as unknown, { rawSource: raw });
  assert.ok(kinds(issues).includes(LocaleIssueKind.DUPLICATE_KEY));
});

test('a pack with the wrong schema tag or direction is refused', () => {
  assert.ok(hasBlockingIssues(validateLocalePack({ ...reference, $schema: 'nope' })));
  assert.ok(hasBlockingIssues(validateLocalePack({ ...reference, direction: 'sideways' })));
  assert.ok(hasBlockingIssues(validateLocalePack('not an object')));
});

test('interpolation replaces known placeholders and leaves unknown ones', () => {
  assert.equal(interpolate('Order #{number}', { number: 42 }), 'Order #42');
  assert.equal(interpolate('Order #{number}', {}), 'Order #{number}');
});

/* ---------------------------------------------------------------- themes */

/**
 * Build a complete theme from the required-token list itself, so this test
 * cannot drift from the contract it is checking.
 */
function completeTheme(overrides: Record<string, string> = {}): ThemePack {
  const tokens: TokenTree = {};
  for (const path of REQUIRED_TOKENS) {
    const parts = path.split('.');
    let node = tokens;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object') node[part] = {};
      node = node[part] as TokenTree;
    }
    node[parts.at(-1)!] = overrides[path] ?? '#000000';
  }
  return {
    $schema: THEME_SCHEMA_ID,
    id: 'test',
    name: 'Test',
    colorScheme: 'light',
    tokens,
  };
}

test('a theme defining every required token validates clean', () => {
  assert.deepEqual(validateThemePack(completeTheme()), []);
});

test('a missing required token is reported by name', () => {
  const partial = completeTheme();
  delete (partial.tokens['color'] as TokenTree)['primary'];

  const issues = validateThemePack(partial);
  assert.ok(issues.some((i) => i.kind === ThemeIssueKind.MISSING_TOKEN && i.token === 'color.primary'));
});

test('token references resolve, and a dangling one is reported', () => {
  const { resolved, issues } = resolveTokens({
    'color.primary': '#1f6feb',
    'component.nav.background': '{color.primary}',
    'component.card.shadow': '{shadow.missing}',
  });
  assert.equal(resolved['component.nav.background'], '#1f6feb');
  assert.ok(issues.some((i) => i.kind === ThemeIssueKind.UNRESOLVED_REFERENCE));
});

test('a circular token reference is caught rather than hanging', () => {
  const { issues } = resolveTokens({ 'a.b': '{a.c}', 'a.c': '{a.b}' });
  assert.ok(issues.some((i) => i.kind === ThemeIssueKind.CIRCULAR_REFERENCE));
});

test('token paths become predictable CSS variables', () => {
  assert.equal(tokenPathToCssVariable('color.primaryContrast'), '--qs-color-primary-contrast');
  assert.equal(tokenPathToCssVariable('component.button.paddingX'), '--qs-component-button-padding-x');

  const css = themeToCssText(completeTheme({ 'color.primary': '#1f6feb' }));
  assert.match(css, /--qs-color-primary: #1f6feb;/);
  assert.match(css, /color-scheme: light;/);
});

test('flattening a token tree preserves full paths', () => {
  assert.deepEqual(
    flattenTokens({ color: { primary: '#fff', deep: { one: '2px' } } }),
    { 'color.primary': '#fff', 'color.deep.one': '2px' },
  );
});
