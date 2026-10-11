/**
 * 本地会话占位（GY-I26）
 * ------------------------------------------------------------
 * 当前不实现任何登录流程，也不保存真实凭据，仅提供"是否游客"的判断，
 * 供界面层控制入口可见性。真实会话由 GY-I04 服务端签发后替换本文件。
 *
 * 安全边界（GY-I26 审查修正）：
 * 1. SESSION_ENABLED 为 false 时，isGuest() 恒为 true —— 界面对"未接入登录"的
 *    承诺不依赖任何缓存内容。旧占位字符串、{demo:true} 或历史上残留的键值
 *    都不得让界面进入登录态，否则会出现"社区/消息/我的"登录区被展示、
 *    录音按钮显示"录音中"等越界表现。
 * 2. SESSION_ENABLED 置为 true 仅限 GY-I04 服务端会话接口落地之后；
 *    届时 read() 必须校验真实会话结构（如服务端签发的 token 字段），
 *    不得以任意真值作为登录凭据。
 * 3. 本文件不调用任何登录或手机号授权接口，也不在本地判定权限；
 *    真实权限一律由 GY-I04 服务端负责。
 */

const KEY = 'gengyun_session'

/** GY-I04 未落地前保持 false；改动此项必须同步更新界面承诺与审查证据 */
const SESSION_ENABLED = false

function read() {
  if (!SESSION_ENABLED) return null
  try {
    const raw = wx.getStorageSync(KEY)
    // 仅接受对象形态的真实会话；空串、字符串、demo 占位一律视为无会话
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.__devPreview === true) return null
    if (!raw.token || typeof raw.token !== 'string') return null
    return raw
  } catch (err) {
    return null
  }
}

function isGuest() {
  // SESSION_ENABLED 关闭时无条件返回 true，不读存储，避免任何缓存值被当成登录态
  if (!SESSION_ENABLED) return true
  return !read()
}

module.exports = { read, isGuest, SESSION_ENABLED }
