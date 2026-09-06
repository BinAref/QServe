/**
 * Theme / design-token format and validation (spec §33).
 *
 * No colour, radius or font size is hard-coded anywhere in the front-ends. A
 * theme is a JSON file of design tokens that the server serves and the client
 * projects onto CSS custom properties (`--qs-color-primary`, …). Adding a theme
 * is adding a file. See docs/EXTENDING.md.
 */

export const THEME_SCHEMA_ID = 'qserve.theme.v1';

export const THEME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Token values are strings; a value may reference another token as `{path}`. */
export type TokenTree = { [key: string]: string | TokenTree };

export interface ThemePack {
  readonly $schema: string;
  readonly id: string;
  readonly name: string;
  /** Hint for the OS colour scheme, so form controls and scrollbars match. */
  readonly colorScheme: 'light' | 'dark';
  readonly author?: string;
  readonly version?: string;
  readonly tokens: TokenTree;
}

/**
 * Tokens every theme must define. This list is the contract between theme
 * authors and the UI: the front-ends may use only these paths, and a theme that
 * defines them all is guaranteed to render every screen correctly.
 */
export const REQUIRED_TOKENS: readonly string[] = [
  'color.background', 'color.surface', 'color.surfaceAlt', 'color.overlay',
  'color.primary', 'color.primaryContrast',
  'color.secondary', 'color.secondaryContrast',
  'color.text', 'color.textMuted', 'color.textInverse',
  'color.border', 'color.borderStrong',
  'color.success', 'color.warning', 'color.error', 'color.info',
  'color.focusRing',

  'spacing.xs', 'spacing.sm', 'spacing.md', 'spacing.lg', 'spacing.xl', 'spacing.xxl',

  'radius.sm', 'radius.md', 'radius.lg', 'radius.pill',

  'typography.fontFamilyBase', 'typography.fontFamilyDisplay', 'typography.fontFamilyMono',
  'typography.sizeXs', 'typography.sizeSm', 'typography.sizeMd',
  'typography.sizeLg', 'typography.sizeXl', 'typography.sizeXxl',
  'typography.weightRegular', 'typography.weightMedium', 'typography.weightBold',
  'typography.lineHeightTight', 'typography.lineHeightNormal',

  'shadow.sm', 'shadow.md', 'shadow.lg',

  'component.button.radius', 'component.button.paddingX', 'component.button.paddingY',
  'component.card.radius', 'component.card.padding', 'component.card.shadow',
  'component.input.radius', 'component.input.borderColor', 'component.input.background',
  'component.nav.background', 'component.nav.text', 'component.nav.activeBackground',
];

export const ThemeIssueKind = {
  SCHEMA: 'SCHEMA',
  MISSING_TOKEN: 'MISSING_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  UNRESOLVED_REFERENCE: 'UNRESOLVED_REFERENCE',
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE',
} as const;
export type ThemeIssueKind = (typeof ThemeIssueKind)[keyof typeof ThemeIssueKind];

export interface ThemeIssue {
  readonly kind: ThemeIssueKind;
  readonly token?: string;
  readonly detail: string;
}

/** Flatten a nested token tree to `a.b.c` → value. */
export function flattenTokens(tree: TokenTree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flattenTokens(value, path));
  }
  return out;
}

const REFERENCE_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;

/**
 * Resolve `{color.primary}` references. Themes use these so a palette change
 * touches one line: `component.nav.background: "{color.surface}"`.
 */
export function resolveTokens(flat: Record<string, string>): {
  resolved: Record<string, string>;
  issues: ThemeIssue[];
} {
  const issues: ThemeIssue[] = [];
  const resolved: Record<string, string> = {};
  const resolving = new Set<string>();

  const resolveOne = (path: string): string => {
    const cached = resolved[path];
    if (cached !== undefined) return cached;

    const raw = flat[path];
    if (raw === undefined) return '';

    if (resolving.has(path)) {
      issues.push({
        kind: ThemeIssueKind.CIRCULAR_REFERENCE,
        token: path,
        detail: 'token references itself, directly or through a cycle',
      });
      return '';
    }
    resolving.add(path);

    const value = raw.replace(REFERENCE_PATTERN, (whole, ref: string) => {
      if (!(ref in flat)) {
        issues.push({
          kind: ThemeIssueKind.UNRESOLVED_REFERENCE,
          token: path,
          detail: `references unknown token "${ref}"`,
        });
        return whole;
      }
      return resolveOne(ref);
    });

    resolving.delete(path);
    resolved[path] = value;
    return value;
  };

  for (const path of Object.keys(flat)) resolveOne(path);
  return { resolved, issues };
}

export function validateThemePack(candidate: unknown): ThemeIssue[] {
  const issues: ThemeIssue[] = [];
  const err = (kind: ThemeIssueKind, detail: string, token?: string): void => {
    issues.push(token === undefined ? { kind, detail } : { kind, detail, token });
  };

  if (typeof candidate !== 'object' || candidate === null) {
    err(ThemeIssueKind.SCHEMA, 'theme pack must be a JSON object');
    return issues;
  }
  const theme = candidate as Partial<ThemePack>;

  if (theme.$schema !== THEME_SCHEMA_ID) {
    err(ThemeIssueKind.SCHEMA, `$schema must be "${THEME_SCHEMA_ID}"`);
  }
  if (typeof theme.id !== 'string' || !THEME_ID_PATTERN.test(theme.id)) {
    err(ThemeIssueKind.SCHEMA, `id must match ${THEME_ID_PATTERN}`);
  }
  if (typeof theme.name !== 'string' || theme.name.trim() === '') {
    err(ThemeIssueKind.SCHEMA, 'name is required');
  }
  if (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark') {
    err(ThemeIssueKind.SCHEMA, 'colorScheme must be "light" or "dark"');
  }
  if (typeof theme.tokens !== 'object' || theme.tokens === null) {
    err(ThemeIssueKind.SCHEMA, 'tokens must be an object');
    return issues;
  }

  const flat = flattenTokens(theme.tokens);
  for (const required of REQUIRED_TOKENS) {
    if (!(required in flat)) {
      err(ThemeIssueKind.MISSING_TOKEN, 'required token is not defined', required);
    }
  }
  for (const [path, value] of Object.entries(flat)) {
    if (typeof value !== 'string' || value.trim() === '') {
      err(ThemeIssueKind.INVALID_TOKEN, 'token value must be a non-empty string', path);
    }
  }

  issues.push(...resolveTokens(flat).issues);
  return issues;
}

/** `color.primaryContrast` → `--qs-color-primary-contrast`. */
export function tokenPathToCssVariable(path: string): string {
  const kebab = path
    .split('.')
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    .join('-');
  return `--qs-${kebab}`;
}

/** Full CSS custom-property block for a theme, ready to inject into :root. */
export function themeToCssVariables(theme: ThemePack): Record<string, string> {
  const { resolved } = resolveTokens(flattenTokens(theme.tokens));
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(resolved)) {
    out[tokenPathToCssVariable(path)] = value;
  }
  return out;
}

export function themeToCssText(theme: ThemePack, selector = ':root'): string {
  const vars = themeToCssVariables(theme);
  const body = Object.entries(vars)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `${selector} {\n  color-scheme: ${theme.colorScheme};\n${body}\n}\n`;
}
