const tabs = [{"pagePath": "pages/home/home", "text": "首页"}, {"pagePath": "pages/community/community", "text": "社区"}, {"pagePath": "pages/identify/identify", "text": "识别"}, {"pagePath": "pages/messages/messages", "text": "消息"}, {"pagePath": "pages/profile/profile", "text": "我的"}]
Component({
  data: { selected: '', fontScale: 1, tabs: tabs },
  methods: {
    switchTab: function (event) {
      const path = event.currentTarget.dataset.path
      if (!tabs.some(tab => tab.pagePath === path)) return
      wx.switchTab({ url: '/' + path })
    }
  }
})
