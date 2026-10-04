/**
 * 应用入口（GY-I26）
 * ------------------------------------------------------------
 * 当前不接入任何业务服务：登录态固定为游客，识别、OCR、语音与社区
 * 均为未接入状态。真实登录会话由 GY-I04 服务端签发后接入。
 */

const session = require('./utils/session')

App({
  globalData: {
    /** 当前会话；null 表示游客 */
    session: null
  },

  onLaunch() {
    this.globalData.session = session.read()
  }
})
