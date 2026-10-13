<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'

type AdbPairingStatus = Parameters<Parameters<Window['api']['onAdbPairingStatus']>[0]>[0]

interface ConnectResult {
  success: boolean
  device?: string
  code?: string
  error?: string
  paired?: boolean
}

const emit = defineEmits<{
  close: []
  connected: [serial: string]
  adbMissing: []
}>()

const { t } = useI18n()
const activeTab = ref<'qr' | 'code'>('qr')

/* ---------------- 二维码配对 ---------------- */

const qrDataUrl = ref('')
const qrSessionId = ref<string | null>(null)
const qrStatus = ref<AdbPairingStatus | null>(null)
const qrStartError = ref('')
let removePairingListener: (() => void) | undefined

const errorText = (error?: string): string => {
  switch (error) {
    case 'CONNECT_FAILED':
      return t('app.connectFailedAuto')
    case 'INVALID_ADDRESS':
      return t('app.connectInvalidAddress')
    case 'INVALID_CODE':
      return t('app.connectInvalidCode')
    case 'INVALID_CONNECT_ADDRESS':
      return t('app.connectInvalidConnectAddress')
    default:
      return t('app.connectError') + (error || t('app.unknownErr'))
  }
}

const qrFailed = computed(
  () =>
    Boolean(qrStartError.value) ||
    qrStatus.value?.phase === 'failed' ||
    qrStatus.value?.phase === 'timeout'
)

const qrStatusText = computed(() => {
  if (qrStartError.value) return qrStartError.value
  const status = qrStatus.value
  switch (status?.phase) {
    case 'pairing':
      return t('app.connectPairing')
    case 'connecting':
      return t('app.connectConnecting')
    case 'connected':
      return t('app.connectConnected', { device: status.device ?? '' })
    case 'timeout':
      return t('app.connectQrTimeout')
    case 'failed':
      return errorText(status.error)
    default:
      return t('app.connectQrWaiting')
  }
})

const cancelQr = (): void => {
  if (qrSessionId.value) {
    void window.electron?.ipcRenderer.invoke('adb-qr-cancel', qrSessionId.value)
  }
  qrSessionId.value = null
}

const startQr = async (): Promise<void> => {
  cancelQr()
  qrStatus.value = null
  qrStartError.value = ''
  qrDataUrl.value = ''
  if (!window.electron?.ipcRenderer) return
  try {
    const result = await window.electron.ipcRenderer.invoke('adb-qr-start')
    if (!result?.success) {
      if (result?.code === 'ADB_NOT_FOUND') emit('adbMissing')
      else qrStartError.value = errorText(result?.error)
      return
    }
    qrSessionId.value = result.sessionId
    qrDataUrl.value = await QRCode.toDataURL(result.qrText, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 200
    })
  } catch (err) {
    qrStartError.value = errorText((err as Error).message)
  }
}

const handlePairingStatus = (status: AdbPairingStatus): void => {
  if (status.sessionId !== qrSessionId.value) return
  qrStatus.value = status
  if (status.phase === 'connected' && status.device) {
    qrSessionId.value = null
    emit('connected', status.device)
  } else if (status.phase === 'failed' && status.error === 'ADB_NOT_FOUND') {
    emit('adbMissing')
  } else if (status.phase === 'failed' || status.phase === 'timeout') {
    qrSessionId.value = null
  }
}

/* ---------------- 配对码配对 ---------------- */

const pairAddress = ref('')
const pairCode = ref('')
const connectAddress = ref('')
const codeBusy = ref(false)
const codeMessage = ref('')
const codeError = ref(false)

const handleConnectResult = (result: ConnectResult | undefined): void => {
  if (result?.success && result.device) {
    codeMessage.value = t('app.connectConnected', { device: result.device })
    codeError.value = false
    emit('connected', result.device)
    return
  }
  codeError.value = true
  if (result?.code === 'ADB_NOT_FOUND') {
    codeMessage.value = ''
    emit('adbMissing')
  } else if (result?.paired) {
    codeMessage.value = t('app.connectFailedAuto')
  } else {
    codeMessage.value = errorText(result?.error)
  }
}

const runCodeAction = async (channel: string, ...args: unknown[]): Promise<void> => {
  if (codeBusy.value || !window.electron?.ipcRenderer) return
  codeBusy.value = true
  codeError.value = false
  codeMessage.value =
    channel === 'adb-connect' ? t('app.connectConnecting') : t('app.connectPairing')
  try {
    handleConnectResult(await window.electron.ipcRenderer.invoke(channel, ...args))
  } catch (err) {
    handleConnectResult({ success: false, error: (err as Error).message })
  } finally {
    codeBusy.value = false
  }
}

const submitPair = (): void => {
  void runCodeAction(
    'adb-pair-code',
    pairAddress.value,
    pairCode.value,
    connectAddress.value.trim() || undefined
  )
}

const submitConnect = (): void => {
  if (!connectAddress.value.trim()) return
  void runCodeAction('adb-connect', connectAddress.value)
}

/* ---------------- 生命周期 ---------------- */

watch(activeTab, (tab) => {
  if (tab === 'qr') void startQr()
  else cancelQr()
})

onMounted(() => {
  removePairingListener = window.api?.onAdbPairingStatus(handlePairingStatus)
  void startQr()
})

onBeforeUnmount(() => {
  cancelQr()
  removePairingListener?.()
})
</script>

<template>
  <div class="rename-modal-overlay" @click.self="emit('close')">
    <section
      class="rename-modal adb-connect-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('app.connectTitle')"
    >
      <div class="rename-modal-header">
        <h3 class="rename-modal-title">{{ t('app.connectTitle') }}</h3>
        <p class="rename-modal-subtitle">{{ t('app.connectSub') }}</p>
      </div>

      <div class="adb-connect-tabs" role="tablist">
        <button
          class="adb-connect-tab"
          :class="{ active: activeTab === 'qr' }"
          role="tab"
          :aria-selected="activeTab === 'qr'"
          @click="activeTab = 'qr'"
        >
          {{ t('app.connectTabQr') }}
        </button>
        <button
          class="adb-connect-tab"
          :class="{ active: activeTab === 'code' }"
          role="tab"
          :aria-selected="activeTab === 'code'"
          @click="activeTab = 'code'"
        >
          {{ t('app.connectTabCode') }}
        </button>
      </div>

      <div v-if="activeTab === 'qr'" class="adb-connect-panel">
        <p class="settings-help">{{ t('app.connectQrHint') }}</p>
        <div class="adb-qr-box" :class="{ ready: qrDataUrl }">
          <img v-if="qrDataUrl" :src="qrDataUrl" :alt="t('app.connectTabQr')" />
        </div>
        <p class="adb-connect-status" :class="{ error: qrFailed }">{{ qrStatusText }}</p>
        <div v-if="qrFailed" class="adb-actions">
          <button class="rename-modal-btn cancel" @click="startQr">
            {{ t('app.connectQrRegenerate') }}
          </button>
        </div>
      </div>

      <div v-else class="adb-connect-panel">
        <p class="settings-help">{{ t('app.connectCodeHint') }}</p>
        <label class="adb-sublabel" for="adb-pair-address">{{ t('app.connectPairAddress') }}</label>
        <input
          id="adb-pair-address"
          v-model="pairAddress"
          class="rename-modal-input"
          type="text"
          placeholder="192.168.1.5:41234"
          :disabled="codeBusy"
          @keydown.enter="submitPair"
        />
        <label class="adb-sublabel" for="adb-pair-code">{{ t('app.connectPairCode') }}</label>
        <input
          id="adb-pair-code"
          v-model="pairCode"
          class="rename-modal-input"
          type="text"
          inputmode="numeric"
          maxlength="6"
          placeholder="123456"
          :disabled="codeBusy"
          @keydown.enter="submitPair"
        />
        <label class="adb-sublabel" for="adb-connect-address">
          {{ t('app.connectAddress') }}
        </label>
        <input
          id="adb-connect-address"
          v-model="connectAddress"
          class="rename-modal-input"
          type="text"
          placeholder="192.168.1.5:37123"
          :disabled="codeBusy"
        />
        <p class="settings-help">{{ t('app.connectAddressHint') }}</p>
        <p v-if="codeMessage" class="adb-connect-status" :class="{ error: codeError }">
          {{ codeMessage }}
        </p>
        <div class="adb-actions">
          <button class="rename-modal-btn confirm" :disabled="codeBusy" @click="submitPair">
            {{ t('app.connectPairButton') }}
          </button>
          <button
            class="rename-modal-btn cancel"
            :disabled="codeBusy || !connectAddress.trim()"
            @click="submitConnect"
          >
            {{ t('app.connectOnlyButton') }}
          </button>
        </div>
      </div>

      <div class="rename-modal-footer">
        <button class="rename-modal-btn cancel" @click="emit('close')">
          {{ t('app.close') }}
        </button>
      </div>
    </section>
  </div>
</template>
