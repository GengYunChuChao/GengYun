/**
 * 本地会话占位（GY-I26）
 * ------------------------------------------------------------
 * 当前不实现任何登录流程，也不保存真实凭据，仅提供"是否游客"的判断，
 * 供界面层控制入口可见性。真实会话由 GY-I04 服务端签发后替换本文件。
 */

const KEY = 'gengyun_session'

function read() {
  try {
    return wx.getStorageSync(KEY) || null
  } catch (err) {
    return null
  }
}

function isGuest() {
  return !read()
}

module.exports = { read, isGuest }
