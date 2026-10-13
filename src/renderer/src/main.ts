import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import { i18n } from './i18n'

// 按平台加根类名，用于 Windows / Linux 的滚动条等差异样式
const platform = window.electron?.process?.platform
if (platform) document.documentElement.classList.add(`platform-${platform}`)

createApp(App).use(i18n).mount('#app')
