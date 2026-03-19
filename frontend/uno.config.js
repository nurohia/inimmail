import { defineConfig, presetUno } from 'unocss'

export default defineConfig({
  presets: [presetUno()],
  shortcuts: {
    'panel-shell':
      'rounded-8 border border-white/55 bg-white/78 shadow-[0_24px_80px_rgba(15,23,42,0.12)] backdrop-blur',
    'field-shell':
      'w-full rounded-4 border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-800 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/12',
    'primary-btn':
      'inline-flex items-center justify-center rounded-4 bg-emerald-600 px-5 py-3 text-sm font-600 text-white shadow-[0_14px_40px_rgba(5,150,105,0.28)] transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-65',
    'ghost-btn':
      'inline-flex items-center justify-center rounded-4 border border-slate-200 bg-white/85 px-4 py-3 text-sm font-600 text-slate-700 transition hover:border-slate-300 hover:bg-slate-50',
  },
  theme: {
    fontFamily: {
      sans: 'Segoe UI, PingFang SC, Microsoft YaHei, sans-serif',
    },
  },
})
