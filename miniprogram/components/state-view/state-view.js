/**
 * 统一状态视图（GY-I26 建立，B7 / #28 增补 failed-kind 与 denied）
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
 * B7 增补（不重命名既有状态，既有页面与证据口径不变）：
 *   denied     已登录但无权限（403 SCOPE_DENIED／CONSENT_REQUIRED／ACCOUNT_INACTIVE）。
 *              与 guest 分开：guest 是「还没登录」，denied 是「登录了也不给」，
 *              折叠成同一句会让用户反复登录仍不明白原因。
 *   mock       接受任务书口径的 `mock`，内部等价于既有 `stub`（同一形态、同一文案、同一标签）。
 *   error-code 可选：传契约错误码时，组件按 `utils/states.js` 的分类补一行「哪类问题」标签，
 *              并在码属于 403 系列时自动转成 denied 语气；页面自有文案仍然优先。
 *
 * 可访问性：每个状态都带图标与文字说明，不依赖颜色单独传达信息。
 */

const states = require('../../utils/states');

const PRESETS = {
  guest: {
    icon: '🔒',
    title: '请先登录',
    desc: '登录后才能查看这部分内容。登录仅用于保存您的记录，不会公开您的位置。',
    actionText: '去登录'
  },
  denied: {
    icon: '🔐',
    title: '没有权限查看',
    desc: '当前账号没有这项内容的查看权限。换用有权限的账号，或在「我的」里补齐用途授权后再试。',
    actionText: ''
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

/** 任务书口径的 `mock` 等价于既有 `stub`；不新增第二套样式与文案。 */
const STATUS_ALIAS = {
  mock: 'stub'
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
    busy: { type: Boolean, value: false },
    /**
     * 可选契约错误码（如 SCOPE_DENIED／PROVIDER_UNAVAILABLE）。
     * 只用来补「哪类问题」与「能否重试」，不覆盖页面给出的领域文案。
     */
    errorCode: { type: String, value: '' },
    /**
     * 无权限态是否保留页面给的操作按钮。
     * 默认 false：「重试」对 403 无效，留着只会让人白点。
     * 但「去授权」这类**针对性**动作是有意义的，识别页的 permission_denied 分支需显式打开。
     */
    allowDeniedAction: { type: Boolean, value: false }
  },

  data: {
    preset: PRESETS.empty,
    effectiveStatus: 'empty',
    resolvedTitle: '',
    resolvedDesc: '',
    resolvedAction: '',
    actionSuppressed: false,
    kindTag: '',
    retryable: false
  },

  observers: {
    'status, title, desc, actionText, errorCode, allowDeniedAction': function () {
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
      const normalized = STATUS_ALIAS[this.data.status] || this.data.status;
      const preset = PRESETS[normalized] || PRESETS.empty;
      const code = this.data.errorCode || '';
      const resolved = code ? states.resolve(code) : null;

      // 403 系列（SCOPE_DENIED／CONSENT_REQUIRED／ACCOUNT_INACTIVE）即使页面按 error 传入，
      // 也一律按 denied 呈现：这不是「操作没成功」，是「根本没有这项权限」。
      const effectiveStatus =
        resolved && resolved.status === states.STATUS.DENIED ? 'denied' : normalized;
      const effectivePreset = PRESETS[effectiveStatus] || preset;

      this.setData({
        preset: effectivePreset,
        effectiveStatus: effectiveStatus,
        resolvedTitle: this.data.title || effectivePreset.title,
        resolvedDesc: this.data.desc || effectivePreset.desc,
        resolvedAction:
          this.data.actionText !== '' ? this.data.actionText : effectivePreset.actionText,
        actionSuppressed: effectiveStatus === 'denied' && this.data.allowDeniedAction !== true,
        kindTag: resolved ? resolved.kindLabel : '',
        retryable: resolved ? resolved.retryable : false
      });
    },

    onAction() {
      this.triggerEvent('action', { status: this.data.status });
    }
  }
});
