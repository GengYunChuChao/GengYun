/**
 * GY-I13 统一**语音球**与等效播放控件（原生小程序组件）。
 *
 * 职责（只做呈现与事件转发，不含任何播放逻辑）：
 * - 语音球：一个**大号可点圆形控件**，主操作＝播放／暂停切换；`aria-role="button"` +
 *   `aria-label` 描述当前状态与动作，可被读屏识别，不依赖颜色单独传达信息；
 * - **等效按钮**：播放／暂停／停止／重播四个独立按钮，功能与语音球等价（语音球不是唯一入口）；
 * - **失败出口**：失败时渲染文案（标题 + 说明）**加一个主动播放按钮**；`listened` 为假时
 *   明确写「未记『已听取』」——本组件**不可能**因为失败而显示"已听取"；
 * - 布局：控件全部走**正常文档流**（本组件样式内**没有** position:fixed/absolute），
 *   因此不会遮挡页面上的提交按钮或风险信息（页面侧的顺序由 tests 断言）。
 *
 * 生命周期与资源释放**不在本组件**：由页面把 `utils/audio-playback.js` 的控制器接上来，
 * 并在 onHide/onUnload 统一 `release()`（本组件不持有播放器，也不注册监听）。
 */
Component({
  options: {
    // 与 state-view 同口径：共享 .btn/.notice/.pill/.gy-icon--* 等全局类，避免样式二套。
    styleIsolation: 'apply-shared'
  },

  properties: {
    /** 播放生命周期状态：idle|loading|playing|paused|stopped|failed（见 utils/audio-playback.js）。 */
    state: { type: String, value: 'idle' },
    /** 整份播报计划是否**自然播完**（只有自然播完才为真；停止/失败/中断/离页恒为假）。 */
    listened: { type: Boolean, value: false },
    /** 整块控件是否禁用（游客、安全检查未过、无内容时为真）。 */
    disabled: { type: Boolean, value: false },
    /** 主标签（例如「播报已核对内容」）。 */
    label: { type: String, value: '播报' },
    /** 一行说明（来源、分段数等；没有则留空）。 */
    hint: { type: String, value: '' },
    /** 失败标题（为空则视为无失败）。 */
    failureTitle: { type: String, value: '' },
    /** 失败说明。 */
    failureHint: { type: String, value: '' },
    /** 主动播放按钮文案（失败时必须有；为空时组件退化为固定文案，绝不留白）。 */
    failureAction: { type: String, value: '' }
  },

  data: {
    stateText: '待播报',
    ballAria: '播放播报',
    playing: false,
    paused: false,
    canStop: false,
    canReplay: false
  },

  observers: {
    'state, listened, label, failureTitle': function () { this.refresh() }
  },

  lifetimes: {
    attached: function () { this.refresh() }
  },

  methods: {
    refresh: function () {
      const state = this.data.state
      const stateText = {
        idle: '待播报',
        loading: '正在准备音频…',
        playing: '正在播报',
        paused: '已暂停',
        stopped: '播报已结束',
        failed: '播报失败'
      }[state] || '状态未知'
      const playing = state === 'playing' || state === 'loading'
      const paused = state === 'paused'
      const ballAria = playing ? '暂停播报' : (paused ? '继续播报' : '播放播报')
      this.setData({
        stateText: stateText,
        ballAria: ballAria + '（当前：' + stateText + '）',
        playing: playing,
        paused: paused,
        canStop: playing || paused,
        // 只有播过（有结尾/失败/被停止）才值得重播；从未开始时不给重播入口。
        canReplay: playing || paused || state === 'stopped' || state === 'failed'
      })
    },

    /** 语音球主操作：播放／继续 与 暂停 的二态切换（与下方按钮**完全等价**）。 */
    onToggle: function () {
      if (this.data.disabled) return
      if (this.data.playing) { this.triggerEvent('pause'); return }
      if (this.data.paused) { this.triggerEvent('play'); return }
      this.triggerEvent('play')
    },

    onPlay: function () {
      if (this.data.disabled) return
      this.triggerEvent('play')
    },

    onPause: function () {
      if (this.data.disabled) return
      this.triggerEvent('pause')
    },

    onStop: function () {
      if (this.data.disabled) return
      this.triggerEvent('stop')
    },

    onReplay: function () {
      if (this.data.disabled || !this.data.canReplay) return
      this.triggerEvent('replay')
    },

    /** 失败态的**主动播放按钮**：永远可点（除非整块禁用），事件与「播放」同一个出口。 */
    onManualPlay: function () {
      if (this.data.disabled) return
      this.triggerEvent('play', { manual: true })
    }
  }
});
