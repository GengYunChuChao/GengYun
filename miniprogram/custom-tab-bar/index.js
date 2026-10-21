// 底部五 Tab（GY-I26 demo 对齐）
// ---------------------------------------------------------------------------
// demo 的移动端底部导航顺序为 首页 / 社区 / 识别 / 消息 / 我的（app.js 的 navs），
// 与 app.json 的 tabBar.list 一致；图标几何由 styles/icons.wxss 提供，
// 取自 docs/ui-demo/dist/app.js 的 `const paths`。
//
// styleIsolation: apply-shared —— 让 app.wxss（styles/*.wxss）里的 .gy-icon 等
// class 规则能作用到本组件；默认隔离下 app.wxss 的 class 对自定义组件无效。
//
// 未读角标（GY-I17 #17）：**只读展示**契约 operation `getUnreadCount` 的派生未读数，
// 显示在「消息」Tab 上，不改变 tabBar 配置语义（app.json 的 tabBar.list/text/图标不变）。
//   - 未登录 ⇒ 一次请求都不发（会话缺失时 messages-api 直接拒绝），也不显示数字；
//   - 取不到（网络/服务未接线/权限）⇒ **不显示任何数字**：既不显示 0，也不保留过期值；
//   - >99 显示 `99+`（口径见 utils/messages-api.js 的 unreadText）。
const auth = require('../utils/auth')
const messagesApi = require('../utils/messages-api')

const tabs = [
  { pagePath: 'pages/home/home', text: '首页', icon: 'home' },
  { pagePath: 'pages/community/community', text: '社区', icon: 'users' },
  { pagePath: 'pages/identify/identify', text: '识别', icon: 'scan', center: true },
  { pagePath: 'pages/messages/messages', text: '消息', icon: 'bell' },
  { pagePath: 'pages/profile/profile', text: '我的', icon: 'person' }
]

Component({
  options: {
    styleIsolation: 'apply-shared'
  },
  data: { selected: '', fontScale: 1, tabs: tabs, unreadText: '' },
  pageLifetimes: {
    // 每次页面可见都重新读取（未读数是派生量，本地不维护计数器）。
    show: function () { this.refreshUnread() }
  },
  lifetimes: {
    attached: function () { this.refreshUnread() }
  },
  methods: {
    /**
     * 未读角标刷新（派生量，每次现读）。
     *
     * 世代号：`attached`／`pageLifetimes.show`／消息页标记已读后的刷新会同时在飞，
     * 响应次序不由请求次序决定。不设世代号时，先发后到的**旧**读数会覆盖新读数
     * （角标停在 3，而实际已经全部已读）。只采纳**最后一次发出**的请求结果。
     */
    refreshUnread: function () {
      const self = this
      const epoch = (this._unreadEpoch = (this._unreadEpoch || 0) + 1)
      if (!auth.isLoggedIn()) { this.setData({ unreadText: '' }); return }
      messagesApi.getUnreadCount().then(function (result) {
        if (epoch !== self._unreadEpoch) return
        self.setData({ unreadText: messagesApi.unreadText(result.count) })
      }).catch(function () {
        if (epoch !== self._unreadEpoch) return
        self.setData({ unreadText: '' })
      })
    },
    switchTab: function (event) {
      const path = event.currentTarget.dataset.path
      if (!tabs.some(tab => tab.pagePath === path)) return
      wx.switchTab({ url: '/' + path })
    }
  }
})
