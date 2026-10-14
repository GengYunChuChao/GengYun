// 底部五 Tab（GY-I26 demo 对齐）
// ---------------------------------------------------------------------------
// demo 的移动端底部导航顺序为 首页 / 社区 / 识别 / 消息 / 我的（app.js 的 navs），
// 与 app.json 的 tabBar.list 一致；图标几何由 styles/icons.wxss 提供，
// 取自 docs/ui-demo/dist/app.js 的 `const paths`。
//
// styleIsolation: apply-shared —— 让 app.wxss（styles/*.wxss）里的 .gy-icon 等
// class 规则能作用到本组件；默认隔离下 app.wxss 的 class 对自定义组件无效。
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
  data: { selected: '', fontScale: 1, tabs: tabs },
  methods: {
    switchTab: function (event) {
      const path = event.currentTarget.dataset.path
      if (!tabs.some(tab => tab.pagePath === path)) return
      wx.switchTab({ url: '/' + path })
    }
  }
})
