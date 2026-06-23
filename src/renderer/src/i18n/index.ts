import { createI18n } from 'vue-i18n'
import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

export const locales = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en-US', label: 'English' }
] as const

export type AppLocale = (typeof locales)[number]['code']

const localeStorageKey = 'color-picker.locale'

function getInitialLocale(): AppLocale {
  const savedLocale = localStorage.getItem(localeStorageKey)
  if (locales.some(({ code }) => code === savedLocale)) return savedLocale as AppLocale

  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  }
})

document.documentElement.lang = i18n.global.locale.value

export function setLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
  localStorage.setItem(localeStorageKey, locale)
  document.documentElement.lang = locale
}
