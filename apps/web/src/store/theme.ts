import { create } from 'zustand';

type Theme = 'light' | 'dark';

function detect(): Theme {
  const stored = localStorage.getItem('ekh-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  localStorage.setItem('ekh-theme', t);
}

export const useThemeStore = create<{ theme: Theme; toggle: () => void }>((set, get) => {
  const initial = detect();
  apply(initial);
  return {
    theme: initial,
    toggle: () => {
      const next = get().theme === 'dark' ? 'light' : 'dark';
      apply(next);
      set({ theme: next });
    },
  };
});
