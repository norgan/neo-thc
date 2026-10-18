export type Theme = 'dark' | 'light';
const storageKey = 'neo.theme';

function readTheme(): Theme {
  try { return localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f1014' : '#f3f3f7');
}

export function saveTheme(theme: Theme): boolean {
  try { localStorage.setItem(storageKey, theme); return true; }
  catch { return false; }
}

export const initialTheme = readTheme();
applyTheme(initialTheme);
