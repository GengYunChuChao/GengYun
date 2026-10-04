/**
 * 统一状态视图（GY-I26）
 * ------------------------------------------------------------
 * 覆盖任务书要求的八种状态：
 *   guest      未登录（游客仅首页，其余入口需登录）
 *   empty      空结果（查无资料）
 *   loading    处理中
 *   error      失败
 *   cancelled  已取消
 *   invalid    已删除／已失效
 *   stub       替身数据（开发模式，必须显式标注）
 *   ready      正常内容（不渲染本组件）
 *
 * 可访问性：每个状态都带图标与文字说明，不依赖颜色单独传达信息。
 */

const PRESETS = {
  guest: {
    icon: '🔒',
    title: '请先登录',
    desc: '登录后才能查看这部分内容。登录仅用于保存您的记录，不会公开您的位置。',
    actionText: '去登录'
  },
  empty: {
    icon: '📭',
    title: '没有找到相关资料',
    desc: '换个名称或条件再试一次，也可以先看看其他内容。',
    actionText: ''
  },
  loading: {
    icon: '⏳',
    title: '正在处理',
    desc: '请稍候，不要退出页面。',
    actionText: ''
  },
  error: {
    icon: '⚠️',
    title: '操作没有成功',
    desc: '可能是网络不稳定或服务暂时不可用，稍后再试一次。',
    actionText: ''
  },
  cancelled: {
    icon: '🚫',
    title: '已取消',
    desc: '本次操作已取消，没有产生任何数据。',
    actionText: ''
  },
  invalid: {
    icon: '⛔',
    title: '内容已失效',
    desc: '该内容可能已下架或来源已过期，平台不会继续展示它。',
    actionText: ''
  },
  stub: {
    icon: '🧪',
    title: '示例数据',
    desc: '当前为开发模式下的替身数据，不是真实识别结果，不能作为用药依据。',
    actionText: ''
  },
  ready: {
    icon: '',
    title: '',
    desc: '',
    actionText: ''
  }
};

Component({
  options: {
    styleIsolation: 'apply-shared'
  },

  properties: {
    /** 状态类型，见 PRESETS 注释 */
    status: {
      type: String,
      value: 'empty'
    },
    /** 覆盖默认标题 */
    title: { type: String, value: '' },
    /** 覆盖默认说明 */
    desc: { type: String, value: '' },
    /** 主操作按钮文案，为空则不显示 */
    actionText: { type: String, value: '' },
    /** 是否处于加载中（用于按钮禁用） */
    busy: { type: Boolean, value: false }
  },

  data: {
    preset: PRESETS.empty,
    resolvedTitle: '',
    resolvedDesc: '',
    resolvedAction: ''
  },

  observers: {
    'status, title, desc, actionText': function () {
      this.refresh();
    }
  },

  lifetimes: {
    attached() {
      this.refresh();
    }
  },

  methods: {
    refresh() {
      const preset = PRESETS[this.data.status] || PRESETS.empty;
      this.setData({
        preset: preset,
        resolvedTitle: this.data.title || preset.title,
        resolvedDesc: this.data.desc || preset.desc,
        resolvedAction: this.data.actionText !== '' ? this.data.actionText : preset.actionText
      });
    },

    onAction() {
      this.triggerEvent('action', { status: this.data.status });
    }
  }
});
