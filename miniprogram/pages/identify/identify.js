const session = require('../../utils/session')

Page({
  data: {
    modes: [
      { key: 'weed', icon: '🌿', title: '拍草识别', desc: '拍照片识别田里的杂草', action: '拍照识别' },
      { key: 'ocr', icon: '🏷️', title: '标签识别', desc: '拍包装读出药名与成分', action: '拍照识标签' },
      { key: 'text', icon: '💬', title: '文字提问', desc: '打字提问，或用下方语音', action: '去提问' }
    ],
    guest: true,
    recording: false,
    hasRecording: false
  },

  onShow: function () {
    this.setData({ guest: session.isGuest() })
  },

  /** 三个入口均为占位：不调相机、不调接口，仅提示未接入 */
  onShoot: function () {
    if (this.data.guest) return
    wx.showToast({ title: '识别服务尚未接入', icon: 'none' })
  },

  onRecord: function () {
    if (this.data.guest) return
    this.setData({ recording: !this.data.recording })
  },

  onPlay: function () {
    if (!this.data.hasRecording) return
    wx.showToast({ title: '播放能力尚未接入', icon: 'none' })
  }
})
