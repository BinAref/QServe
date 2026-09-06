/**
 * Theme packs (spec §33).
 *
 * A theme is a JSON file of design tokens in `themes/`. The server validates it
 * against the token contract, then serves it both as JSON (for terminals that
 * want the raw values) and as a ready-made CSS custom-property block. No colour
 * or radius is compiled into any front-end, so adding `elegant.json` is the
 * entire cost of adding an elegant theme.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  notFound, themeToCssText, validateThemePack,
  type ThemeIssue, type ThemePack, type ThemeSummary,
} from '@qserve/shared';
import type { PackRepository } from '../../core/repositories/packs.js';

export class ThemeService {
  /** Themes shipped by the vendor, read from disk. */
  private fileThemes = new Map<string, ThemePack>();
  /** The effective set: shipped themes plus the restaurant's own. */
  private themes = new Map<string, ThemePack>();
  private rejected = new Map<string, ThemeIssue[]>();
  private authored: PackRepository | null = null;

  constructor(
    private readonly themesDir: string,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  useAuthoredPacks(repository: PackRepository): void {
    this.authored = repository;
    this.mergeAuthored();
  }

  load(): void {
    this.fileThemes = new Map();
    this.rejected = new Map();

    let files: string[];
    try {
      files = readdirSync(this.themesDir).filter((name) => name.endsWith('.json'));
    } catch {
      this.onWarning(`no themes directory at ${this.themesDir}; using the built-in fallback`);
      return;
    }

    for (const file of files.sort()) {
      const path = join(this.themesDir, file);
      if (!statSync(path).isFile()) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        this.rejected.set(basename(file, '.json'), [{
          kind: 'SCHEMA', detail: `invalid JSON: ${String(error)}`,
        }]);
        continue;
      }

      const issues = validateThemePack(parsed);
      const theme = parsed as ThemePack;

      if (theme.id !== basename(file, '.json')) {
        issues.push({
          kind: 'SCHEMA',
          detail: `theme id "${theme.id}" does not match the file name "${file}"`,
        });
      }

      if (issues.length > 0) {
        this.rejected.set(basename(file, '.json'), issues);
        this.onWarning(`theme ${file} was rejected: ${issues[0]?.detail ?? 'invalid'}`);
        continue;
      }
      this.fileThemes.set(theme.id, theme);
    }

    this.mergeAuthored();
  }

  private mergeAuthored(): void {
    this.themes = new Map(this.fileThemes);
    if (!this.authored) return;

    for (const row of this.authored.listThemes()) {
      this.themes.set(row.id, {
        $schema: 'qserve.theme.v1',
        id: row.id,
        name: row.name,
        colorScheme: row.color_scheme,
        tokens: this.authored.themeTokens(row),
      });
    }
  }

  /** Call after the restaurant adds, edits or deletes one of its themes. */
  refreshAuthored(): void {
    this.mergeAuthored();
  }

  /** True when this theme came from a file rather than from the restaurant. */
  isShipped(id: string): boolean {
    return this.fileThemes.has(id);
  }

  get available(): string[] {
    return [...this.themes.keys()].sort();
  }

  has(id: string): boolean {
    return this.themes.has(id);
  }

  get(id: string): ThemePack {
    const theme = this.themes.get(id);
    if (!theme) throw notFound('theme', id);
    return theme;
  }

  summaries(activeId: string): ThemeSummary[] {
    return [...this.themes.values()].map((theme) => ({
      id: theme.id,
      name: theme.name,
      colorScheme: theme.colorScheme,
      active: theme.id === activeId,
    }));
  }

  /**
   * The CSS a terminal loads. Served with a long cache lifetime keyed by theme
   * id, because on a restaurant LAN every byte saved is a faster table turn.
   */
  css(id: string): string {
    return themeToCssText(this.get(id));
  }

  diagnostics(): { loaded: string[]; rejected: { theme: string; issues: ThemeIssue[] }[] } {
    return {
      loaded: this.available,
      rejected: [...this.rejected.entries()].map(([theme, issues]) => ({ theme, issues })),
    };
  }
}
