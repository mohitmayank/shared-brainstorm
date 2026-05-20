const DISPLAY_NAME_KEY = 'sb.display_name';
const LAST_SEQ_KEY = 'sb.last_seq';
const THEME_KEY = 'sb.theme';

export type Theme = 'light' | 'dark';

export function getTheme(): Theme | null {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
}

export function getName(): string | null {
  return localStorage.getItem(DISPLAY_NAME_KEY);
}

export function setName(name: string): void {
  localStorage.setItem(DISPLAY_NAME_KEY, name);
}


export function getLastSeq(): number {
  const v = sessionStorage.getItem(LAST_SEQ_KEY);
  if (v === null) return -1;
  const n = parseInt(v, 10);
  return isNaN(n) ? -1 : n;
}

export function setLastSeq(seq: number): void {
  sessionStorage.setItem(LAST_SEQ_KEY, String(seq));
}
