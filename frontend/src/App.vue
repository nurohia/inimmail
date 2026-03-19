<script setup>
import axios from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE || 'http://127.0.0.1:38117', timeout: 15000 })
const ADMIN_PATH = (import.meta.env.VITE_ADMIN_PATH || '/admin').replace(/\/+$/, '') || '/admin'
const routePath = ref((window.location.pathname || '/').replace(/\/+$/, '') || '/')
const isAdminRoute = computed(() => routePath.value === ADMIN_PATH)

const redeemCode = ref('')
const sessionToken = ref(localStorage.getItem('tm_token') || '')
const emailAddress = ref(localStorage.getItem('tm_email') || '')
const expiresAt = ref(localStorage.getItem('tm_expires') || '')
const prefix = ref('')
const selectedDomain = ref('')
const domains = ref([])
const setupRequired = ref(false)
const setupCode = ref('')
const loadingRedeem = ref(false)
const loadingMessages = ref(false)
const endingMailbox = ref(false)
const userStatus = ref('')
const userError = ref('')
const messages = ref([])
const selectedMessageId = ref(null)
const deletingIds = ref([])
const pollCountdown = ref(60)
const detailCardRef = ref(null)

const adminUser = ref(localStorage.getItem('tm_admin_user') || 'admin')
const adminPass = ref(localStorage.getItem('tm_admin_pass') || 'admin1234')
const adminReady = ref(false)
const adminLoading = ref(false)
const adminError = ref('')
const adminStatus = ref('')
const activeTab = ref('overview')
const adminSettingsOpen = ref(false)
const adminNavOpen = ref(false)
const settingsTab = ref('account')
const settingsUser = ref('')
const settingsPass = ref('')
const settingsPurchaseLink = ref('')
const singleCode = ref('')
const singleHours = ref('')
const singleCount = ref('1')
const adminCodes = ref([])
const adminDomains = ref([])
const adminSessions = ref([])
const adminCodeQuery = ref('')
const adminCodeFilter = ref('all')
const adminSessionQuery = ref('')
const publicPurchaseLink = ref('')

let pollTimer = null
let popHandler = null

const authHeader = computed(() => adminUser.value && adminPass.value ? `Basic ${window.btoa(`${adminUser.value}:${adminPass.value}`)}` : '')
const hasMailbox = computed(() => Boolean(sessionToken.value && emailAddress.value))
const expiryLabel = computed(() => expiresAt.value ? formatTime(expiresAt.value) : '长期有效')
const stats = computed(() => ({
  codes: adminCodes.value.length,
  used: adminCodes.value.filter((item) => item.isUsed).length,
  enabled: adminDomains.value.filter((item) => item.isEnabled && item.isAvailable).length,
  sessions: adminSessions.value.length,
}))
const selectedMessage = computed(() => messages.value.find((item) => idOf(item) === String(selectedMessageId.value || '')) || messages.value[0] || null)
const renderedMessageHtml = computed(() => {
  const message = selectedMessage.value
  if (!message) return ''
  const html = String(message.bodyHtml || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
  const body = html || `<pre style="margin:0;white-space:pre-wrap;font:inherit;line-height:1.75">${escapeHtml(message.bodyText || previewOf(message))}</pre>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.4) transparent}body{margin:0;padding:18px;background:#fffdf9;color:#2c2824;font-family:"Segoe UI Variable Text","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.75}body::-webkit-scrollbar{width:4px;height:4px}body::-webkit-scrollbar-track{background:transparent}body::-webkit-scrollbar-thumb{background:rgba(148,163,184,.38);border-radius:999px}body::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.72)}body::-webkit-scrollbar-button{display:none;width:0;height:0}body::-webkit-scrollbar-corner{background:transparent}img,table{max-width:100%}a{color:#9a5338}</style></head><body>${body}</body></html>`
})
const filteredAdminCodes = computed(() => {
  const query = adminCodeQuery.value.trim().toLowerCase()
  return adminCodes.value.filter((item) => {
    const ok = adminCodeFilter.value === 'all'
      || (adminCodeFilter.value === 'unused' && !item.isUsed && !item.activeSession)
      || (adminCodeFilter.value === 'used' && item.isUsed && !item.activeSession)
      || (adminCodeFilter.value === 'active' && Boolean(item.activeSession))
    if (!ok) return false
    if (!query) return true
    return [item.code, item.activeSession?.emailAddress, item.activeSession?.sessionToken].filter(Boolean).join(' ').toLowerCase().includes(query)
  })
})
const filteredAdminSessions = computed(() => {
  const query = adminSessionQuery.value.trim().toLowerCase()
  if (!query) return adminSessions.value
  return adminSessions.value.filter((item) => [item.emailAddress, item.redeemCode, item.sessionToken, item.upstreamDeleteError].filter(Boolean).join(' ').toLowerCase().includes(query))
})
const cleanupUsedCount = computed(() => adminCodes.value.filter((item) => item.isUsed && !item.activeSession).length)

function idOf(message) { return String(message?.messageId ?? message?.id ?? message?.message_id ?? '') }
function subjectOf(message) { return message?.subject || '无主题邮件' }
function senderOf(message) { return message?.headerFrom || message?.source || '未知发件人' }
function previewOf(message) { return String(message?.preview || message?.bodyText || '').replace(/\s+/g, ' ').trim() || '这封邮件暂时没有可展示的预览内容。' }
function formatTime(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value || '未知时间') : d.toLocaleString('zh-CN') }
function formatDuration(value) { return Number(value) === -1 ? '长期有效' : `${value} 小时` }
function codeStateLabel(item) { return item.activeSession ? '使用中' : item.isUsed ? '已使用' : '未使用' }
function codeStateTone(item) { return item.activeSession ? 'warn' : item.isUsed ? 'muted' : 'ok' }
function sessionExpiryLabel(item) { return item.expiresAt ? `到期：${formatTime(item.expiresAt)}` : '长期有效' }
function escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function ensureSelectedMessage(preferred = selectedMessageId.value) { selectedMessageId.value = messages.value.length ? (messages.value.some((item) => idOf(item) === String(preferred)) ? String(preferred) : idOf(messages.value[0])) : null }
function showToast(message, type = 'info') { if (!message) return; ElMessage({ message, type, grouping: true, showClose: true, duration: type === 'error' ? 4200 : 2600, offset: 24 }) }
async function confirmAction(message, title = '请确认') { try { await ElMessageBox.confirm(message, title, { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消', closeOnClickModal: false, closeOnPressEscape: true }); return true } catch (_error) { return false } }
function stopPolling() { if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null } }
function startPolling() { stopPolling(); if (!sessionToken.value || isAdminRoute.value) return; pollCountdown.value = 60; pollTimer = window.setInterval(() => { if (pollCountdown.value <= 1) loadMessages(true); else pollCountdown.value -= 1 }, 1000) }
function saveAdmin() { localStorage.setItem('tm_admin_user', adminUser.value); localStorage.setItem('tm_admin_pass', adminPass.value) }
function saveMailbox(data) { sessionToken.value = data.sessionToken; emailAddress.value = data.emailAddress; expiresAt.value = data.expiresAt || ''; localStorage.setItem('tm_token', sessionToken.value); localStorage.setItem('tm_email', emailAddress.value); expiresAt.value ? localStorage.setItem('tm_expires', expiresAt.value) : localStorage.removeItem('tm_expires') }
function clearMailboxState({ keepCode = false, nextStatus = '', nextError = '' } = {}) {
  stopPolling(); sessionToken.value = ''; emailAddress.value = ''; expiresAt.value = ''; messages.value = []; selectedMessageId.value = null; deletingIds.value = []; setupRequired.value = false; userStatus.value = nextStatus; userError.value = nextError
  localStorage.removeItem('tm_token'); localStorage.removeItem('tm_email'); localStorage.removeItem('tm_expires')
  setupCode.value = ''; prefix.value = ''; selectedDomain.value = domains.value[0] || ''
  if (!keepCode) redeemCode.value = ''
}
function applyAdmin(data) { adminCodes.value = data?.codes || []; adminDomains.value = data?.domains || []; adminSessions.value = data?.sessions || []; settingsUser.value = data?.settings?.username || adminUser.value; settingsPurchaseLink.value = data?.settings?.purchaseLink || '' }
async function adminCall(method, path, body) { const { data } = await api.request({ method, url: `${ADMIN_PATH}${path}`, data: body, headers: { Authorization: authHeader.value } }); return data }
async function loadDomains() { const { data } = await api.get('/api/public-config'); domains.value = Array.isArray(data?.domains) ? data.domains : []; publicPurchaseLink.value = String(data?.purchaseLink || '').trim(); if (!domains.value.includes(selectedDomain.value)) selectedDomain.value = domains.value[0] || '' }
function resetRedeemSetup(clearCode = true) { setupRequired.value = false; setupCode.value = ''; prefix.value = ''; selectedDomain.value = domains.value[0] || ''; userStatus.value = ''; userError.value = ''; if (clearCode) redeemCode.value = '' }
function selectAdminTab(tab) { activeTab.value = tab; adminNavOpen.value = false; if (adminReady.value) refreshAdmin() }
function selectMessage(messageId) {
  selectedMessageId.value = messageId
  if (window.innerWidth <= 860) {
    nextTick(() => detailCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
}
async function loadMessages(silent = false) {
  if (!sessionToken.value) return
  loadingMessages.value = true
  try {
    const last = selectedMessageId.value
    const { data } = await api.get('/api/messages', { headers: { Authorization: `Bearer ${sessionToken.value}` } })
    messages.value = Array.isArray(data?.messages) ? data.messages : []
    ensureSelectedMessage(last)
    pollCountdown.value = 60
    if (!silent) { userStatus.value = messages.value.length ? `已同步 ${messages.value.length} 封邮件` : '邮箱里暂时还没有邮件'; userError.value = '' }
  } catch (error) {
    if (error.response?.status === 403) { clearMailboxState({ keepCode: true, nextError: error.response?.data?.message || '邮箱会话已失效' }); return }
    userError.value = error.response?.data?.message || '刷新邮件失败'
  } finally { loadingMessages.value = false }
}
async function redeemMailbox() {
  if (!redeemCode.value.trim()) { userError.value = '请输入兑换码'; return }
  const currentCode = redeemCode.value.trim()
  const requiresSetup = setupRequired.value && currentCode === setupCode.value
  if (requiresSetup && !prefix.value.trim()) { userError.value = '请输入邮箱前缀'; return }
  if (requiresSetup && !selectedDomain.value) { userError.value = '请选择域名'; return }
  loadingRedeem.value = true; userStatus.value = ''; userError.value = ''
  try {
    const { data } = await api.post('/api/redeem', { code: currentCode, prefix: prefix.value.trim(), domain: selectedDomain.value })
    saveMailbox(data); setupRequired.value = false; setupCode.value = ''; prefix.value = ''; userStatus.value = data.reused ? '已恢复之前绑定的邮箱' : '邮箱创建成功'; await loadMessages(true)
  } catch (error) {
    if (error.response?.data?.error === 'SETUP_REQUIRED') { await loadDomains(); setupRequired.value = true; setupCode.value = currentCode; userStatus.value = '首次使用请填写邮箱前缀并选择域名'; return }
    userError.value = error.response?.data?.message || '兑换失败'
  } finally { loadingRedeem.value = false }
}
async function clearInboxNow() { if (!sessionToken.value) return; try { await api.delete('/api/messages/clear', { headers: { Authorization: `Bearer ${sessionToken.value}` } }); messages.value = []; selectedMessageId.value = null; userStatus.value = '邮箱已清空'; userError.value = '' } catch (error) { userError.value = error.response?.data?.message || '清空失败' } }
function logoutMailboxView() { if (!sessionToken.value) return; clearMailboxState({ keepCode: true, nextStatus: '已退出当前邮箱查看，可重新输入兑换码恢复。' }) }
async function endMailboxNow() { if (!sessionToken.value) return; endingMailbox.value = true; try { await api.post('/api/session/end', {}, { headers: { Authorization: `Bearer ${sessionToken.value}` } }); clearMailboxState({ keepCode: false, nextStatus: '邮箱已提前结束，并已请求删除上游临时邮箱。' }) } catch (error) { userError.value = error.response?.data?.message || '结束失败' } finally { endingMailbox.value = false } }
async function deleteMessageNow(message) {
  const id = idOf(message); if (!sessionToken.value || !id) return
  deletingIds.value = [...new Set([...deletingIds.value, id])]
  try {
    const { data } = await api.delete(`/api/messages/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${sessionToken.value}` } })
    messages.value = messages.value.filter((item) => idOf(item) !== id); deletingIds.value = deletingIds.value.filter((item) => item !== id); ensureSelectedMessage(); userStatus.value = data?.mode === 'local' ? '上游不支持单封删除，已在当前邮箱中隐藏。' : '邮件已删除'; userError.value = ''
  } catch (error) { deletingIds.value = deletingIds.value.filter((item) => item !== id); userError.value = error.response?.data?.message || '删除失败' }
}
async function loginAdmin() { if (!adminUser.value.trim() || !adminPass.value.trim()) { adminError.value = '请输入后台账号和密码'; return } adminLoading.value = true; adminError.value = ''; try { applyAdmin(await adminCall('get', '/api/overview')); adminReady.value = true; saveAdmin(); adminStatus.value = '后台登录成功' } catch (error) { adminError.value = error.response?.data?.message || '后台登录失败' } finally { adminLoading.value = false } }
async function refreshAdmin() { if (!adminReady.value) return; adminLoading.value = true; adminError.value = ''; try { applyAdmin(await adminCall('get', '/api/overview')) } catch (error) { adminError.value = error.response?.data?.message || '刷新后台失败' } finally { adminLoading.value = false } }
async function syncDomainsAdmin() { adminLoading.value = true; adminError.value = ''; try { const data = await adminCall('post', '/api/domains/sync'); adminDomains.value = data?.domains || []; adminStatus.value = '域名同步完成' } catch (error) { adminError.value = error.response?.data?.message || '同步失败' } finally { adminLoading.value = false } }
async function toggleDomain(item) { adminLoading.value = true; adminError.value = ''; try { await adminCall('post', `/api/domains/${encodeURIComponent(item.domain)}/toggle`, { isEnabled: !item.isEnabled }); await refreshAdmin() } catch (error) { adminError.value = error.response?.data?.message || '切换域名失败' } finally { adminLoading.value = false } }
async function saveSettings() { adminLoading.value = true; adminError.value = ''; try { const password = settingsPass.value.trim(); const data = await adminCall('post', '/api/settings/admin-auth', { username: settingsUser.value.trim(), password }); adminUser.value = data.username; adminPass.value = password; saveAdmin(); adminSettingsOpen.value = false; settingsPass.value = ''; adminStatus.value = '后台账号设置已保存' } catch (error) { adminError.value = error.response?.data?.message || '保存设置失败' } finally { adminLoading.value = false } }
async function savePurchaseSettings() { adminLoading.value = true; adminError.value = ''; try { const data = await adminCall('post', '/api/settings/purchase-link', { purchaseLink: settingsPurchaseLink.value.trim() }); settingsPurchaseLink.value = data?.purchaseLink || ''; publicPurchaseLink.value = settingsPurchaseLink.value; adminSettingsOpen.value = false; adminStatus.value = settingsPurchaseLink.value ? '购买平台链接已保存' : '购买平台链接已清空' } catch (error) { adminError.value = error.response?.data?.message || '保存设置失败' } finally { adminLoading.value = false } }
async function createSingleCode() {
  const count = Number.parseInt(String(singleCount.value || '1'), 10)
  if (!Number.isInteger(count) || count < 1 || count > 200) { adminError.value = '生成份数必须是 1 到 200 的整数'; return }
  if (count > 1 && singleCode.value.trim()) { adminError.value = '批量生成时请留空自定义兑换码'; return }

  adminLoading.value = true
  adminError.value = ''
  try {
    const path = count > 1 ? '/api/redeem-codes/batch' : '/api/redeem-codes'
    const body = count > 1
      ? { count, durationHours: singleHours.value }
      : { code: singleCode.value.trim(), durationHours: singleHours.value }
    const data = await adminCall('post', path, body)
    singleCode.value = ''
    singleHours.value = ''
    singleCount.value = '1'
    await refreshAdmin()
    adminStatus.value = count > 1 ? `已批量创建 ${data?.codes?.length || count} 个兑换码` : '兑换码已创建'
  } catch (error) {
    adminError.value = error.response?.data?.message || '创建兑换码失败'
  } finally {
    adminLoading.value = false
  }
}
async function deleteRedeemCode(item) {
  const text = item.activeSession ? `删除兑换码 ${item.code} 会同时结束邮箱 ${item.activeSession.emailAddress}，确定继续吗？` : `确定删除兑换码 ${item.code} 吗？`
  if (!await confirmAction(text, '删除兑换码')) return
  adminLoading.value = true; adminError.value = ''
  try { await adminCall('delete', `/api/redeem-codes/${encodeURIComponent(item.code)}`); await refreshAdmin(); adminStatus.value = item.activeSession ? '兑换码已作废，对应邮箱也已结束' : '兑换码已删除' } catch (error) { adminError.value = error.response?.data?.message || '删除兑换码失败' } finally { adminLoading.value = false }
}
async function deleteCodesBatch(items, label) {
  const targets = items.filter(Boolean)
  if (!targets.length) { adminError.value = '没有可处理的兑换码'; return }
  const activeCount = targets.filter((item) => item.activeSession).length
  if (!await confirmAction(activeCount ? `${label}会删除 ${targets.length} 个兑换码，其中 ${activeCount} 个会同时结束对应邮箱，确定继续吗？` : `${label} ${targets.length} 个兑换码，确定继续吗？`, '批量处理')) return
  adminLoading.value = true; adminError.value = ''
  try { for (const item of targets) await adminCall('delete', `/api/redeem-codes/${encodeURIComponent(item.code)}`); await refreshAdmin(); adminStatus.value = `${label}完成，共处理 ${targets.length} 个兑换码` } catch (error) { adminError.value = error.response?.data?.message || '批量处理兑换码失败' } finally { adminLoading.value = false }
}
async function cleanupUsedCodes() { await deleteCodesBatch(adminCodes.value.filter((item) => item.isUsed && !item.activeSession), '清理已使用兑换码') }
async function deleteFilteredCodes() { await deleteCodesBatch(filteredAdminCodes.value, '删除筛选结果') }
async function endSessionFromAdmin(session) { if (!await confirmAction(`确定结束邮箱 ${session.emailAddress} 吗？`, '结束会话')) return; adminLoading.value = true; adminError.value = ''; try { await adminCall('post', `/api/sessions/${encodeURIComponent(session.sessionToken)}/end`); await refreshAdmin(); adminStatus.value = '邮箱会话已结束' } catch (error) { adminError.value = error.response?.data?.message || '结束邮箱失败' } finally { adminLoading.value = false } }
async function clearSessionInboxFromAdmin(session) { adminLoading.value = true; adminError.value = ''; try { await adminCall('post', `/api/sessions/${encodeURIComponent(session.sessionToken)}/clear-messages`); adminStatus.value = '会话邮箱已清空' } catch (error) { adminError.value = error.response?.data?.message || '清空会话邮件失败' } finally { adminLoading.value = false } }
async function confirmDeleteMessage(message) { if (!await confirmAction(`确定删除这封邮件吗？`, '删除邮件')) return; await deleteMessageNow(message) }
async function confirmClearInboxNow() { if (!await confirmAction('确定清空当前邮箱中的全部邮件吗？', '清空邮箱')) return; await clearInboxNow() }
async function confirmEndMailboxNow() { if (!await confirmAction('确定提前结束当前邮箱吗？这会请求删除上游临时邮箱。', '提前结束')) return; await endMailboxNow() }
async function confirmClearSessionInboxFromAdmin(session) { if (!await confirmAction(`确定清空邮箱 ${session.emailAddress} 的全部邮件吗？`, '清空会话邮箱')) return; await clearSessionInboxFromAdmin(session) }
function logoutAdmin() { adminReady.value = false; adminError.value = ''; adminStatus.value = ''; adminCodes.value = []; adminDomains.value = []; adminSessions.value = []; adminCodeQuery.value = ''; adminSessionQuery.value = ''; adminCodeFilter.value = 'all'; adminSettingsOpen.value = false; localStorage.removeItem('tm_admin_user'); localStorage.removeItem('tm_admin_pass') }
function syncDocumentTitle() { document.title = isAdminRoute.value ? 'INIM临时邮箱后台' : 'INIM临时邮箱' }
function scrollToSection(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
function openPurchaseLink() {
  if (!publicPurchaseLink.value) {
    showToast('暂未设置购买渠道', 'warning')
    return
  }
  window.open(publicPurchaseLink.value, '_blank', 'noopener,noreferrer')
}

watch(() => sessionToken.value, (value) => { stopPolling(); if (value && !isAdminRoute.value) { startPolling(); loadMessages(true) } }, { immediate: true })
watch(() => redeemCode.value, (value) => { if (setupRequired.value && value.trim() !== setupCode.value) resetRedeemSetup(false) })
watch(isAdminRoute, (value) => { syncDocumentTitle(); if (value) stopPolling(); else if (sessionToken.value) startPolling() }, { immediate: true })
watch(userError, (value) => { if (value) showToast(value, 'error') })
watch(adminError, (value) => { if (value) showToast(value, 'error') })
watch(userStatus, (value) => { if (value) showToast(value, 'success') })
watch(adminStatus, (value) => { if (value) showToast(value, 'success') })
onMounted(() => { syncDocumentTitle(); popHandler = () => { routePath.value = (window.location.pathname || '/').replace(/\/+$/, '') || '/' }; window.addEventListener('popstate', popHandler); if (!isAdminRoute.value) loadDomains().catch(() => {}) })
onBeforeUnmount(() => { stopPolling(); if (popHandler) window.removeEventListener('popstate', popHandler) })
</script>

<template>
  <div class="shell">
    <div v-if="isAdminRoute" class="page admin-page">
      <section v-if="!adminReady" class="center">
        <article class="card login-card">
          <div class="tag">ADMIN</div>
          <h1 class="title sm">INIM临时邮箱后台</h1>
          <p class="text">默认账号 `admin`，默认密码 `admin1234`。</p>
          <div class="stack top">
            <input v-model="adminUser" class="field" placeholder="后台账号" />
            <input v-model="adminPass" type="password" class="field" placeholder="后台密码" />
            <button class="btn primary" @click="loginAdmin">{{ adminLoading ? '登录中...' : '进入后台' }}</button>
          </div>
          <p v-if="adminError" class="notice error">{{ adminError }}</p>
        </article>
      </section>
      <section v-else class="admin-layout">
        <button class="btn soft admin-menu-btn" @click="adminNavOpen = true">菜单</button>
        <div v-if="adminNavOpen" class="drawer-backdrop" @click="adminNavOpen = false"></div>
        <aside class="card sidebar" :class="{ open: adminNavOpen }">
          <div>
            <div class="row sidebar-head">
              <div>
                <div class="tag">CONTROL</div>
                <h2 class="side-title">INIM 控制台</h2>
              </div>
              <button class="btn soft sidebar-close" @click="adminNavOpen = false">关闭</button>
            </div>
            <p class="text">统一管理兑换码、域名和邮箱会话。</p>
          </div>
          <div class="stack gap-sm">
            <button class="btn nav" :class="{ active: activeTab === 'overview' }" @click="selectAdminTab('overview')">概览</button>
            <button class="btn nav" :class="{ active: activeTab === 'codes' }" @click="selectAdminTab('codes')">兑换码管理</button>
            <button class="btn nav" :class="{ active: activeTab === 'domains' }" @click="selectAdminTab('domains')">域名管理</button>
            <button class="btn nav" :class="{ active: activeTab === 'sessions' }" @click="selectAdminTab('sessions')">邮箱会话</button>
          </div>
        </aside>
        <main class="stack gap-lg main">
          <section v-if="activeTab === 'overview'" class="grid2">
            <div class="stack gap-lg grid2-span">
              <section class="card hero">
                <div>
                  <div class="tag">WORKSPACE</div>
                  <h1 class="title md">后台管理区</h1>
                  <p class="text">在这里集中处理兑换码、域名同步和邮箱会话。</p>
                </div>
                <div class="actions">
                  <button class="btn soft" @click="adminSettingsOpen = true; settingsTab = 'account'">设置</button>
                  <button class="btn primary" @click="refreshAdmin">刷新概览</button>
                </div>
              </section>
              <section class="stats">
                <article class="card stat"><span>兑换码</span><strong>{{ stats.codes }}</strong></article>
                <article class="card stat"><span>已使用</span><strong>{{ stats.used }}</strong></article>
                <article class="card stat"><span>启用域名</span><strong>{{ stats.enabled }}</strong></article>
                <article class="card stat accent"><span>在线邮箱</span><strong>{{ stats.sessions }}</strong></article>
              </section>
              <p v-if="adminStatus" class="notice ok">{{ adminStatus }}</p>
              <p v-if="adminError" class="notice error">{{ adminError }}</p>
            </div>
            <article class="card">
              <h2>系统概览</h2>
              <p class="text">先同步上游域名，再决定对外开放哪些域名。</p>
              <div class="info-grid top">
                <div class="info"><span>活跃邮箱</span><strong>{{ stats.sessions }} 个</strong></div>
                <div class="info"><span>可用域名</span><strong>{{ stats.enabled }} 个</strong></div>
                <div class="info"><span>最新兑换码</span><strong>{{ adminCodes[0]?.code || '暂无' }}</strong></div>
              </div>
            </article>
            <article class="card">
              <h2>快捷操作</h2>
              <div class="stack top">
                <button class="btn primary" @click="syncDomainsAdmin">立即同步域名</button>
                <button class="btn soft" @click="selectAdminTab('codes')">去管理兑换码</button>
                <button class="btn soft" @click="selectAdminTab('sessions')">查看在线邮箱</button>
              </div>
            </article>
          </section>

          <section v-if="activeTab === 'codes'" class="card admin-tab-panel">
            <div class="row">
              <div>
                <h2>兑换码管理</h2>
                <p class="text">支持创建、删除、批量清理和按状态筛选。</p>
              </div>
              <div class="actions">
                <button class="btn soft" :disabled="!cleanupUsedCount" @click="cleanupUsedCodes">清理已使用 ({{ cleanupUsedCount }})</button>
                <button class="btn danger" :disabled="!filteredAdminCodes.length" @click="deleteFilteredCodes">删除筛选结果</button>
              </div>
            </div>
            <div class="grid2 top">
              <article class="subcard">
                <h3>创建兑换码</h3>
                <div class="stack top">
                  <input v-model="singleCode" class="field" placeholder="自定义兑换码，可留空自动生成" />
                  <div class="create-code-row">
                    <input v-model="singleHours" type="number" class="field" placeholder="有效时长(小时,留空永久)" />
                    <input v-model="singleCount" type="number" min="1" max="200" class="field" placeholder="生成多少份" />
                  </div>
                  <button class="btn primary" @click="createSingleCode">创建兑换码</button>
                </div>
              </article>
              <article class="subcard">
                <h3>筛选</h3>
                <div class="stack top">
                  <input v-model="adminCodeQuery" class="field" placeholder="搜索兑换码 / 邮箱 / 会话" />
                  <div class="chips">
                    <button class="btn chip" :class="{ active: adminCodeFilter === 'all' }" @click="adminCodeFilter = 'all'">全部</button>
                    <button class="btn chip" :class="{ active: adminCodeFilter === 'unused' }" @click="adminCodeFilter = 'unused'">未使用</button>
                    <button class="btn chip" :class="{ active: adminCodeFilter === 'used' }" @click="adminCodeFilter = 'used'">已使用</button>
                    <button class="btn chip" :class="{ active: adminCodeFilter === 'active' }" @click="adminCodeFilter = 'active'">使用中</button>
                  </div>
                </div>
              </article>
            </div>
            <div class="table-wrap top admin-scroll">
              <div class="table head code-table"><span>兑换码</span><span>时长</span><span>状态</span><span>绑定邮箱</span><span class="right">操作</span></div>
              <article v-for="item in filteredAdminCodes" :key="item.code" class="table code-table">
                <div class="cell-main"><strong>{{ item.code }}</strong><small>{{ item.usedAt ? `使用于 ${formatTime(item.usedAt)}` : `创建于 ${formatTime(item.createdAt)}` }}</small></div>
                <span>{{ formatDuration(item.durationHours) }}</span>
                <span><span class="pill" :class="codeStateTone(item)">{{ codeStateLabel(item) }}</span></span>
                <span class="break">{{ item.activeSession?.emailAddress || item.lastBoundEmail || '未绑定邮箱' }}</span>
                <div class="actions end"><button class="btn danger sm-btn" @click="deleteRedeemCode(item)">{{ item.activeSession ? '作废并结束' : '删除' }}</button></div>
              </article>
              <div v-if="!filteredAdminCodes.length" class="empty">当前筛选条件下没有兑换码。</div>
            </div>
          </section>
          <section v-if="activeTab === 'domains'" class="card admin-tab-panel">
            <div class="row">
              <div>
                <h2>域名管理</h2>
                <p class="text">同步上游域名后，可以逐个控制是否开放给用户。</p>
              </div>
              <div class="actions"><button class="btn primary" @click="syncDomainsAdmin">同步上游域名</button></div>
            </div>
            <div class="table-wrap top admin-scroll">
              <div class="table head domain-table"><span>域名</span><span>状态</span><span>来源</span><span class="right">操作</span></div>
              <article v-for="item in adminDomains" :key="item.domain" class="table domain-table">
                <div class="cell-main"><strong>{{ item.domain }}</strong><small>最近同步：{{ item.lastSeenAt ? formatTime(item.lastSeenAt) : '暂无记录' }}</small></div>
                <span><span class="pill" :class="item.isEnabled ? 'ok' : 'muted'">{{ item.isEnabled ? '已开启' : '已关闭' }}</span></span>
                <span>{{ item.source || 'manual' }}</span>
                <div class="actions end"><button class="btn sm-btn" :class="item.isEnabled ? 'soft' : 'primary'" @click="toggleDomain(item)">{{ item.isEnabled ? '关闭' : '开启' }}</button></div>
              </article>
              <div v-if="!adminDomains.length" class="empty">暂时还没有域名数据。</div>
            </div>
          </section>

          <section v-if="activeTab === 'sessions'" class="card admin-tab-panel">
            <div class="row">
              <div>
                <h2>邮箱会话</h2>
                <p class="text">这里可以直接结束会话，或者清空会话中的邮件。</p>
              </div>
              <input v-model="adminSessionQuery" class="field search" placeholder="搜索邮箱 / 兑换码 / 会话" />
            </div>
            <div class="session-grid top admin-scroll">
              <article v-for="item in filteredAdminSessions" :key="item.sessionToken" class="session-card">
                <strong class="break">{{ item.emailAddress }}</strong>
                <span>兑换码：{{ item.redeemCode }}</span>
                <span>{{ sessionExpiryLabel(item) }}</span>
                <span v-if="item.upstreamDeleteError" class="warn">上次删除异常：{{ item.upstreamDeleteError }}</span>
                <div class="actions top">
                  <button class="btn soft sm-btn" @click="confirmClearSessionInboxFromAdmin(item)">清空邮件</button>
                  <button class="btn danger sm-btn" @click="endSessionFromAdmin(item)">提前结束</button>
                </div>
              </article>
              <div v-if="!filteredAdminSessions.length" class="empty">当前没有匹配的邮箱会话。</div>
            </div>
          </section>
        </main>
      </section>
      <div v-if="adminSettingsOpen" class="modal">
        <section class="card settings-modal">
          <div class="row">
            <h2>设置</h2>
            <button class="btn soft" @click="adminSettingsOpen = false">关闭</button>
          </div>
          <div class="chips top">
            <button class="btn chip" :class="{ active: settingsTab === 'account' }" @click="settingsTab = 'account'">账号设置</button>
            <button class="btn chip" :class="{ active: settingsTab === 'purchase' }" @click="settingsTab = 'purchase'">购买平台</button>
          </div>
          <div v-if="settingsTab === 'account'" class="stack top">
            <input v-model="settingsUser" class="field" placeholder="新账号" />
            <input v-model="settingsPass" type="password" class="field" placeholder="新密码" />
            <button class="btn primary" @click="saveSettings">保存设置</button>
          </div>
          <div v-else class="stack top">
            <input v-model="settingsPurchaseLink" class="field" placeholder="发卡链接，留空表示未设置" />
            <p class="text">设置后，前台首页头部会显示购买入口并跳转到该链接。</p>
            <button class="btn primary" @click="savePurchaseSettings">保存设置</button>
          </div>
        </section>
      </div>
    </div>

    <div v-else class="page public-page" :class="{ 'mail-view': hasMailbox }">
      <template v-if="!hasMailbox">
        <header class="site-header">
          <button class="brand brand-button" @click="scrollToSection('home')">
            <span class="brand-mark">I</span>
            <span class="brand-text">INIM 临时邮箱</span>
          </button>
          <nav class="site-nav">
            <button class="nav-link" @click="scrollToSection('home')">首页</button>
            <button class="nav-link" @click="scrollToSection('redeem')">兑换</button>
            <button class="nav-link" @click="openPurchaseLink">购买</button>
          </nav>
        </header>
        <section id="home" class="hero-panel">
          <div class="hero-badge">安全、稳定、即开即用的临时邮箱服务</div>
          <h1 class="hero-title">INIM 临时邮箱</h1>
          <p class="hero-copy">输入兑换码即可创建或恢复邮箱，支持删除邮件和邮箱，安全可控。</p>
          <div class="hero-actions">
            <button class="btn primary hero-btn" @click="scrollToSection('redeem')">开始使用</button>
          </div>
        </section>
        <section class="feature-strip">
          <article class="card feature-card">
            <span class="feature-icon">01</span>
            <h3>恢复方便</h3>
            <p class="text">同一个兑换码可以恢复之前的邮箱，不需要重新生成。</p>
          </article>
          <article class="card feature-card">
            <span class="feature-icon">02</span>
            <h3>退出查看</h3>
            <p class="text">退出当前查看不会销毁邮箱，下次输入兑换码还能继续进入。</p>
          </article>
          <article class="card feature-card">
            <span class="feature-icon">03</span>
            <h3>邮件管理</h3>
            <p class="text">支持刷新、清空、单封删除，邮件详情默认直接展示渲染结果。</p>
          </article>
        </section>
      </template>
      <section v-if="!hasMailbox" id="redeem" class="single-panel top">
        <article class="card redeem-panel">
          <div class="tag">REDEEM</div>
          <h2>开始兑换</h2>
          <p class="text">输入兑换码即可创建或恢复邮箱，兑换成功后会自动进入邮箱查看页。</p>
          <div class="stack redeem-form top">
            <input v-model="redeemCode" class="field" placeholder="请输入兑换码" />
            <div v-if="setupRequired" class="setup-row">
              <input v-model="prefix" class="field" placeholder="邮箱前缀，例如 test001" />
              <select v-model="selectedDomain" class="field select-field">
                <option value="" disabled>选择域名</option>
                <option v-for="item in domains" :key="item" :value="item">{{ item }}</option>
              </select>
            </div>
            <button class="btn primary" @click="redeemMailbox">{{ loadingRedeem ? '处理中...' : setupRequired ? '创建邮箱' : '兑换 / 恢复邮箱' }}</button>
            <button v-if="setupRequired" class="btn soft" @click="resetRedeemSetup()">重新兑换</button>
          </div>
          <div class="compact-points top">
            <span>首次使用可补充前缀和域名</span>
            <span>退出查看不会销毁邮箱</span>
            <span>提前结束会请求清理上游邮箱</span>
          </div>
          <p v-if="userStatus" class="notice ok">{{ userStatus }}</p>
          <p v-if="userError" class="notice error">{{ userError }}</p>
        </article>
      </section>
      <section v-else id="inbox" class="stack gap-lg inbox-shell">
        <article class="card mailbox-hero">
          <div class="row">
            <div>
              <div class="tag">CURRENT MAILBOX</div>
              <div class="addr">{{ emailAddress }}</div>
              <p class="text">有效期：{{ expiryLabel }}</p>
            </div>
            <div class="actions">
              <button class="btn soft" @click="loadMessages()">{{ loadingMessages ? '刷新中...' : '立即刷新' }}</button>
              <button class="btn soft" @click="logoutMailboxView">退出查看</button>
              <button class="btn soft" @click="confirmClearInboxNow">清空邮箱</button>
              <button class="btn danger" :disabled="endingMailbox" @click="confirmEndMailboxNow">{{ endingMailbox ? '结束中...' : '提前结束' }}</button>
            </div>
          </div>
          <div class="timer">下次自动刷新：{{ pollCountdown }} 秒</div>
          <p v-if="userError" class="notice error">{{ userError }}</p>
        </article>
        <section class="mailbox">
          <article class="card list-card">
            <h2>邮件列表</h2>
            <p class="text">可删除单封邮件，或清空整个邮箱</p>
            <div class="mail-list top">
              <article v-for="message in messages" :key="idOf(message)" class="mail" :class="{ active: String(selectedMessageId) === idOf(message) }" @click="selectMessage(idOf(message))">
                <div class="row">
                  <div class="stack gap-xs mail-main">
                    <strong>{{ subjectOf(message) }}</strong>
                    <span>发件人：{{ senderOf(message) }}</span>
                    <span>时间：{{ formatTime(message.createdAt || message.created_at || message.headerDate) }}</span>
                  </div>
                  <button class="btn danger sm-btn" @click.stop="confirmDeleteMessage(message)">{{ deletingIds.includes(idOf(message)) ? '删除中...' : '删除' }}</button>
                </div>
                <p class="mail-preview">{{ previewOf(message) }}</p>
              </article>
              <div v-if="!messages.length" class="empty">这里还没有邮件。</div>
            </div>
          </article>
          <article ref="detailCardRef" class="card detail-card">
            <div v-if="selectedMessage" class="detail-shell">
              <h2>{{ subjectOf(selectedMessage) }}</h2>
              <div class="stack gap-xs top meta">
                <div>发件人：{{ senderOf(selectedMessage) }}</div>
                <div>收件地址：{{ selectedMessage.address || emailAddress }}</div>
                <div>时间：{{ formatTime(selectedMessage.createdAt || selectedMessage.created_at || selectedMessage.headerDate) }}</div>
              </div>
              <div class="viewer">
                <iframe class="frame" :srcdoc="renderedMessageHtml" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>
              </div>
            </div>
            <div v-else class="empty big">先从左边选一封邮件，这里就会显示详情。</div>
          </article>
        </section>
      </section>
    </div>
  </div>
</template>

<style>
:root{--bg:#fcfcf8;--surface:#ffffff;--surface-soft:rgba(255,255,255,.92);--border:rgba(15,23,42,.1);--line:rgba(15,23,42,.065);--text:#0f172a;--muted:#5b6475;--accent:#111827;--accent-soft:#eff6ff;--accent-line:rgba(37,99,235,.18);--shadow:0 18px 40px rgba(15,23,42,.06);--danger:#b42318;--danger-bg:#fff1f2;--ok:#0f766e;--ok-bg:#ecfdf5}
html,body,#app{margin:0;min-height:100%}
body{font-family:"Segoe UI Variable Text","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;background:var(--bg);color:var(--text)}
*{box-sizing:border-box}
button,input{font:inherit}
button{cursor:pointer}
h1,h2,h3,p{margin:0}
*{scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.42) transparent}
*::-webkit-scrollbar{width:4px;height:4px}
*::-webkit-scrollbar-track{background:transparent;border-radius:999px}
*::-webkit-scrollbar-thumb{background:rgba(148,163,184,.38);border-radius:999px;border:0}
*::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.72)}
*::-webkit-scrollbar-button{display:none;width:0;height:0}
*::-webkit-scrollbar-corner{background:transparent}
.shell{min-height:100vh;background:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px),radial-gradient(circle at 50% 12%,rgba(255,255,255,.98),rgba(252,252,248,.92) 48%,rgba(248,250,252,.92) 100%);background-size:36px 36px,36px 36px,auto}
.page{width:min(1180px,calc(100% - 40px));margin:0 auto;padding:18px 0 24px}
.public-page{padding-top:0}
.public-page.mail-view{padding-top:12px;padding-bottom:12px}
.admin-page{width:min(1280px,calc(100% - 32px));padding-top:14px;height:100vh;overflow:hidden}
.card,.subcard,.session-card,.info{border:1px solid var(--border);border-radius:20px;background:var(--surface-soft);box-shadow:var(--shadow)}
.card,.session-card{padding:18px}
.subcard,.info{padding:16px}
.center{min-height:calc(100vh - 54px);display:grid;place-items:center}
.login-card{width:min(520px,100%)}
.settings-modal{width:min(640px,100%)}
.tag{display:inline-flex;width:fit-content;padding:6px 10px;border-radius:999px;background:var(--accent-soft);border:1px solid var(--accent-line);color:#2563eb;font-size:11px;font-weight:800;letter-spacing:.14em}
.title{margin:12px 0 8px;font-family:"Bahnschrift","Segoe UI Variable Display","PingFang SC",sans-serif;line-height:1.02;letter-spacing:-.04em;font-size:clamp(30px,4vw,44px)}
.title.sm{font-size:clamp(24px,3vw,34px)}
.title.md{font-size:clamp(26px,3vw,34px)}
.text{color:var(--muted);line-height:1.7}
.stack{display:grid}
.gap-xs{gap:6px}
.gap-sm{gap:10px}
.gap-lg{gap:16px}
.top{margin-top:16px}
.stack.top{gap:12px}
.field{width:100%;min-width:0;padding:12px 14px;border:1px solid var(--border);border-radius:14px;background:#fff;outline:none;transition:border-color .18s ease,box-shadow .18s ease}
.field:focus{border-color:rgba(37,99,235,.42);box-shadow:0 0 0 4px rgba(37,99,235,.08)}
.select-field{appearance:none}
.btn{border:1px solid transparent;border-radius:14px;padding:11px 16px;background:#fff;color:var(--text);transition:transform .16s ease,background .16s ease,border-color .16s ease,box-shadow .16s ease}
.btn:hover:not(:disabled){transform:translateY(-1px)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:800;box-shadow:0 10px 22px rgba(15,23,42,.12)}
.soft,.nav,.chip{background:rgba(255,255,255,.96);border-color:var(--border);color:#1f2937}
.danger{background:var(--danger-bg);border-color:rgba(180,35,24,.12);color:var(--danger);font-weight:800}
.nav{width:100%;text-align:left;font-weight:700}
.nav.active,.chip.active{background:var(--accent-soft);border-color:rgba(37,99,235,.26);color:#1d4ed8}
.sm-btn{padding:8px 12px;border-radius:12px;font-size:13px}
.notice{margin:14px 0 0;border-radius:14px;padding:12px 14px;font-size:14px;line-height:1.6}
.notice.ok{background:var(--ok-bg);color:var(--ok)}
.notice.error{background:var(--danger-bg);color:var(--danger)}
.row,.actions,.hero{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
.actions{align-items:center}
.grid2{display:grid;gap:16px;grid-template-columns:repeat(2,minmax(0,1fr))}
.grid2-span{grid-column:1/-1}
.admin-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;align-items:start;height:calc(100vh - 36px)}
.main{min-width:0;min-height:0;overflow:hidden}
.admin-tab-panel{display:flex;flex-direction:column;min-width:0;overflow:hidden;height:min(920px,calc(100vh - 60px))}
.admin-tab-panel .admin-scroll{flex:1;min-height:0;max-height:none}
.sidebar{position:sticky;top:14px;display:grid;gap:16px;align-content:start;max-height:calc(100vh - 28px);overflow:auto;background:#fff}
.sidebar-head{align-items:center}
.side-title{margin:10px 0 6px;font-size:22px;line-height:1.2}
.split-top{padding-top:6px;border-top:1px solid var(--border)}
.admin-menu-btn,.sidebar-close{display:none}
.stats{display:grid;gap:12px;grid-template-columns:repeat(4,minmax(0,1fr))}
.stat{display:grid;gap:10px}
.stat span{color:#64748b;font-size:12px;font-weight:800;letter-spacing:.14em}
.stat strong{font-size:clamp(24px,3vw,32px);line-height:1}
.stat.accent{background:linear-gradient(135deg,#eff6ff 0%,#ffffff 100%)}
.info-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.info{display:grid;gap:8px;background:rgba(248,250,252,.92)}
.info span{color:#64748b;font-size:13px}
.info strong{font-size:15px;line-height:1.6;font-weight:700}
.chips{display:flex;gap:10px;flex-wrap:wrap}
.chip{padding:9px 12px;border-radius:999px}
.table-wrap{display:grid;gap:10px;overflow:auto;align-content:start;grid-auto-rows:max-content}
.admin-scroll{max-height:min(48vh,430px);overflow:auto;padding-right:4px}
.table{min-width:880px;display:grid;gap:12px;align-items:center}
.table.head{padding:0 4px;color:#64748b;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.table:not(.head){padding:14px 16px;border:1px solid var(--border);border-radius:16px;background:#fff}
.code-table{grid-template-columns:minmax(200px,1.45fr) 110px 110px minmax(180px,1fr) 120px}
.domain-table{grid-template-columns:minmax(220px,1.4fr) 120px 120px 110px}
.cell-main{display:grid;gap:4px;min-width:0}
.cell-main small{color:#64748b}
.break,.addr,.session-card strong{overflow-wrap:anywhere;word-break:break-word}
.right,.end{text-align:right;justify-content:flex-end}
.pill{display:inline-flex;align-items:center;justify-content:center;min-width:68px;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.04em}
.pill.ok{background:#ecfdf5;color:#047857}
.pill.warn{background:#fff7ed;color:#b45309}
.pill.muted{background:#f1f5f9;color:#64748b}
.search{max-width:320px}
.session-grid{display:grid;gap:12px;grid-template-columns:1fr;align-content:start;align-items:start}
.session-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 14px;align-items:start;align-self:start;color:#334155}
.session-card>:not(.actions){grid-column:1/2}
.session-card .actions{grid-column:2/3;grid-row:1/span 4;align-self:start;justify-content:flex-end;flex-direction:column;flex-wrap:nowrap;gap:10px}
.session-card .actions.top{margin-top:0}
.warn{color:#b45309}
.empty{display:grid;place-items:center;min-height:120px;padding:16px;color:#64748b;text-align:center;line-height:1.7}
.empty.big{min-height:320px}
.addr{margin-top:10px;font-family:"Bahnschrift","Segoe UI Variable Display","PingFang SC",sans-serif;font-size:clamp(22px,2.5vw,32px);font-weight:900;line-height:1.08}
.timer{margin-top:16px;border-radius:14px;padding:12px 14px;background:#f8fafc;color:#475569;font-size:14px;font-weight:700}
.inbox-shell{margin-top:0}
.mailbox{display:grid;gap:14px;grid-template-columns:minmax(320px,.84fr) minmax(0,1.16fr);align-items:stretch}
.mailbox > *{min-width:0}
.mailbox-hero{padding:14px 16px}
.list-card,.detail-card{display:flex;flex-direction:column;min-width:0;overflow:hidden;height:720px}
.mail-list{display:grid;gap:10px;flex:1;min-height:0;overflow:auto;padding-right:4px;align-content:start}
.mail{display:grid;gap:10px;min-height:136px;max-height:136px;padding:14px;border:1px solid var(--border);border-radius:16px;background:#fff;color:#334155;overflow:hidden;transition:border-color .18s ease,background .18s ease,box-shadow .18s ease}
.mail.active{border-color:rgba(37,99,235,.28);background:#f8fbff;box-shadow:0 10px 20px rgba(37,99,235,.06)}
.mail-main{min-width:0}
.mail-main strong,.mail-main span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mail p{margin:0;line-height:1.65}
.mail-preview{display:-webkit-box;overflow:hidden;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.meta{color:#475569}
.detail-shell{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.viewer{margin-top:12px;flex:1;min-height:0;height:auto;max-height:none;overflow:auto;border:1px solid var(--border);border-radius:18px;background:#fff}
.frame,.pre{display:block;width:100%;height:100%;min-height:260px;border:0;background:transparent}
.pre{margin:0;padding:18px;white-space:pre-wrap;word-break:break-word;line-height:1.75}
.modal{position:fixed;inset:0;z-index:40;display:grid;place-items:center;padding:20px;background:rgba(15,23,42,.14);backdrop-filter:blur(8px)}
.drawer-backdrop{display:none}
.site-header{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;align-items:center;gap:18px;padding:10px 0 10px;margin-bottom:12px;background:rgba(252,252,248,.9);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand-button{padding:0;border:0;background:none;box-shadow:none}
.brand{display:inline-flex;align-items:center;gap:12px;color:var(--text);font-weight:900}
.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--accent);color:#fff;font-family:"Bahnschrift","Segoe UI Variable Display",sans-serif;font-size:16px}
.brand-text{font-size:15px}
.site-nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nav-link{padding:8px 10px;border:0;background:none;color:#475569;font-weight:700}
.nav-link:hover{color:var(--text)}
.hero-panel{display:grid;justify-items:center;gap:12px;padding:26px 0 18px;text-align:center}
.hero-badge{display:inline-flex;align-items:center;justify-content:center;padding:8px 16px;border-radius:999px;border:1px solid var(--accent-line);background:var(--accent-soft);color:#2563eb;font-weight:700}
.hero-title{font-family:"Bahnschrift","Segoe UI Variable Display","PingFang SC",sans-serif;font-size:clamp(48px,8vw,74px);line-height:.96;letter-spacing:-.06em}
.hero-copy{max-width:720px;color:#475569;font-size:clamp(15px,1.8vw,17px);line-height:1.65}
.hero-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
.hero-btn{min-width:140px}
.feature-strip{display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:8px}
.feature-card{display:grid;gap:12px;align-content:start}
.feature-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:#f8fafc;border:1px solid var(--border);font-size:12px;font-weight:800;color:#334155}
.single-panel{display:grid;grid-template-columns:minmax(0,700px);justify-content:center}
.redeem-form{gap:14px}
.create-code-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.setup-row{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:12px}
.compact-points{display:grid;gap:8px;margin-top:16px;color:#64748b;font-size:13px}
.compact-points span{display:flex;align-items:center;gap:8px}
.compact-points span::before{content:"";width:6px;height:6px;border-radius:999px;background:#2563eb;flex:none}
.redeem-panel,.mailbox-hero{background:rgba(255,255,255,.95)}
@media (min-width:861px) and (max-height:940px){.page{padding-top:12px;padding-bottom:14px}.hero-panel{padding:12px 0 10px;gap:10px}.feature-strip{gap:12px}.feature-card{padding:14px}.single-panel.top{margin-top:10px}.redeem-panel{padding:16px}.compact-points{margin-top:10px}.mailbox-hero{padding:12px 14px}.timer{margin-top:10px;padding:10px 12px}.list-card,.detail-card{height:620px}.admin-tab-panel{height:min(780px,calc(100vh - 72px))}.mail{min-height:124px;max-height:124px}}
@media (max-width:1220px){.feature-strip,.mailbox,.grid2,.admin-layout{grid-template-columns:1fr}.sidebar{position:static;max-height:none}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.site-header{position:static}.admin-page{height:auto;overflow:visible}.admin-layout{height:auto}.main{overflow:hidden}.list-card,.detail-card{height:auto}.admin-tab-panel{height:min(840px,calc(100vh - 72px))}}
@media (max-width:860px){.page,.admin-page{width:min(100%,calc(100% - 20px));padding-top:12px;padding-bottom:18px}.public-page.mail-view{height:auto;overflow:visible;padding-top:10px;padding-bottom:14px}.card,.session-card{padding:16px}.stats{grid-template-columns:1fr}.hero-panel{padding:26px 0 16px}.hero-title{font-size:clamp(40px,16vw,58px)}.hero-copy{font-size:15px}.site-header{padding-top:10px}.site-nav{width:100%;justify-content:flex-start}.setup-row,.create-code-row{grid-template-columns:1fr}.feature-strip{grid-template-columns:1fr}.viewer,.frame,.pre,.empty.big{min-height:280px}.admin-layout{grid-template-columns:1fr}.admin-menu-btn{display:inline-flex;position:fixed;right:12px;left:auto;top:12px;z-index:46;height:40px;min-height:40px;padding:0 14px;border-radius:12px;align-items:center;justify-content:center;line-height:1;white-space:nowrap}.drawer-backdrop{display:block;position:fixed;inset:0;background:rgba(15,23,42,.22);z-index:44}.sidebar{position:fixed;top:10px;left:10px;bottom:10px;width:min(236px,68vw);padding:14px;z-index:45;transform:translateX(-120%);transition:transform .18s ease;border-radius:18px;background:#fff;box-shadow:0 24px 56px rgba(15,23,42,.2);overflow:auto}.sidebar.open{transform:translateX(0)}.sidebar-close{display:inline-flex;height:40px;min-height:40px;padding:0 12px;border-radius:12px;align-items:center;justify-content:center;line-height:1;white-space:nowrap}.side-title{font-size:18px}.list-card,.admin-scroll{max-height:none}.admin-tab-panel{height:calc(100dvh - 32px);min-height:calc(100svh - 32px);max-height:none}.detail-card{height:560px}.mail-list{max-height:360px}.mailbox{grid-template-columns:1fr}.viewer{height:360px}.mailbox-hero .actions{width:100%}.mailbox-hero .actions .btn{flex:1 1 calc(50% - 8px)}.table.head{display:none}.table-wrap{display:grid;align-content:start;overflow:auto}.table{min-width:0}.code-table,.domain-table{grid-template-columns:minmax(0,1fr) auto;gap:10px 12px}.code-table:not(.head)>:nth-child(1),.domain-table:not(.head)>:nth-child(1){grid-column:1/2}.code-table:not(.head)>:nth-child(2),.code-table:not(.head)>:nth-child(3),.code-table:not(.head)>:nth-child(4),.domain-table:not(.head)>:nth-child(2),.domain-table:not(.head)>:nth-child(3){grid-column:1/2}.code-table:not(.head)>:nth-child(5),.domain-table:not(.head)>:nth-child(4){grid-column:2/3;grid-row:1/span 4;align-self:start}.session-card .actions{gap:8px}}
</style>
