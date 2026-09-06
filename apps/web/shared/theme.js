/**
 * Theme loading (spec §33).
 *
 * The server hands back a theme as a CSS custom-property block; this injects it
 * into a single <style> element. Every stylesheet in the product is written
 * against those variables, so switching themes is one network request and one
 * DOM write — and adding a theme needs no front-end change at all.
 */

const STYLE_ID = 'qs-theme';
const STORAGE_KEY = 'qserve.theme';

let currentId = null;

export const currentTheme = () => currentId;

export async function applyTheme(themeId) {
  if (!themeId || themeId === currentId) return currentId;

  const response = await fetch(`/api/themes/${encodeURIComponent(themeId)}/css`, {
    credentials: 'same-origin',
  });
  if (!response.ok) return currentId;

  const css = await response.text();
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    // First in <head> so the app's own stylesheet can still override a token.
    document.head.prepend(style);
  }
  style.textContent = css;

  currentId = themeId;
  document.documentElement.dataset.theme = themeId;
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // A viewer who blocks storage still gets the theme, just not remembered.
  }
  return currentId;
}

export function rememberedTheme(fallback = 'light') {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}
