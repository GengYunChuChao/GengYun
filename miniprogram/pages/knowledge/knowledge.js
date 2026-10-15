const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const api = require('../../utils/knowledge-api')
const profileApi = require('../../utils/profile-api')
// These pickers are a labelled bundled directory, never a result fallback.
const cropDoc = require('../../data/crops')
const speciesDoc = require('../../data/species')
const regionDoc = require('../../data/regions')
// 地区层级口径（GY-I05 / GY-I07）：**资料只登记到省级**（packages/reference/zhejiang.mjs 的
// ZHEJIANG_PROVINCE_CODE = '330000'），而档案保存的地区必然是**市/县级码**
// （pages/profile/profile.js 保存的是所选市或县）。因此：
//   · 档案地区属于浙江省 ⇒ 查询按 330000 发，并在页面**明示**「当前资料只登记到省级」；
//   · 档案地区不在浙江省／核不出层级 ⇒ **不得**强行按 330000 查询，给出如实的未收录提示。
// 绝不把省级证据包装成"本地适用"。
const PROVINCE_CODE = '330000'
const ZHEJIANG = /^33[0-9]{4}$/
const PROVINCE_NOTE = '当前资料只登记到省级，已按浙江省查询。'
const EMPTY_PROFILE_NOTE = '我的档案还没有作物和地区，本次没有预置筛选。'
const UNREADABLE_NOTE = '未能读取我的档案，本次没有按档案预置筛选；可在下面手选条件查询。'
// 触发本提示的是 profileApi 的**通用**失败码 INVALID_RESPONSE（utils/profile-api.js#validProfile：
// 缺 revision、region_catalog_version 非法、形状不符、地区码非浙江…任一都会命中），本页**无法**从该
// 失败码反推具体原因。因此文案只陈述"没能核对档案里的地区信息（原因未定）"，**不得**断言"档案地区
// 不在覆盖范围内"，也不得引导用户去改一个**可能本来就正确**的档案地区（反例：330102 省内 + revision=0）。
const OUT_OF_COVERAGE = '未能核对我的档案里的地区信息（原因未定），本次没有按档案条件查询，也没有用省级资料代替。'
  + '当前资料仅覆盖浙江省，只登记到省级（' + PROVINCE_CODE + '）；可点「清空条件继续查询」用手选条件查询，'
  + '或回「我的」确认档案里的作物与地区都已保存完整。'
// 地区层级标注（GY-I07／差距侦察 3-A）：资料只登记到省级——种子清单全部条目的 `region_codes` 都是
// `ZHEJIANG_PROVINCE_CODE`（packages/reference/zhejiang.mjs:54 定义 '330000'、:322 逐条只写省级码），
// 而地区下拉含 11 个市与各县区。因此在选择器旁**如实标注**层级：既不假装市／县能查到本地资料，
// 也不与 #168 的档案提示（PROVINCE_NOTE／OUT_OF_COVERAGE）冲突——两者是同一口径"只到省级"。
const REGION_TIER_NOTE = '地区筛选仅浙江省级（' + PROVINCE_CODE + '）：当前资料只登记到省级，选市／县级地区在当前资料下查不到条目；「全部地区」不受此限。'
// 条件维度未采集（GY-I07／差距侦察 3-B）：服务端可见性过滤要求 growth_stage／planting_method／
// use_scene **全为空**才可能命中（services/api/src/knowledge/service.ts:64 注释 "Current schema has no
// stage/method/scene evidence"、:66 的 `&& !filter.growth_stage && !filter.planting_method && !filter.use_scene`）。
// ⇒ 这三个条件任一非空时，HTTP 200 + `items: []` 是**必然**结果，原因是**当前资料未采集该维度**，
// 而不是"没有符合条件的资料"。页面必须点名原因并给出只清空这三个条件的出口，绝不用泛化空态让用户
// 以为"资料里真的没有这一条"；服务端行为**不变**（仍然返回空）。
const CONDITION_FIELDS = [['growth_stage', '生育期'], ['planting_method', '种植方式'], ['use_scene', '使用场景']]
const CONDITION_LIST = CONDITION_FIELDS.map(f => f[1]).join('／')
const UNCOLLECTED_HEAD = '当前资料未采集'
const UNCOLLECTED_NOTE = '：资料里没有' + CONDITION_LIST + '这几个维度的取值，填了就查不到条目。'
  + '可点「清空该条件继续查询」只清空' + CONDITION_LIST + '后重查，其余条件（作物／杂草／地区／关键词）保持不变。'
Page({
  data: { fontScale: 1, gatePassed: false, busy: false, status: '', modeNote: api.modeNote(), items: [], nextCursor: null,
    // GY-I26：状态语气字段，供 state-view 统一渲染 loading／empty／error；idle 表示尚未发起查询。
    // GY-I07：另有 uncollected = 条件维度未采集（不是泛化空态，见 uncollectedNote）。
    stateKind: 'idle',
    // 档案预置（GY-I05/07）：profileState = idle 未读／applied 已按档案预置／none 档案为空／
    // unread 读不到档案／out-of-coverage 档案响应核不出（通用 INVALID_RESPONSE；不按 330000 代查）。
    profileState: 'idle', profileNote: '',
    q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '', advanced: false,
    crops: [{ name: '全部作物', id: '' }].concat(cropDoc.crops), species: [{ name: '全部杂草', id: '' }].concat(speciesDoc.species),
    regions: [{ name: '全部地区', code: '' }].concat(regionDoc.regions),
    regionNote: REGION_TIER_NOTE,
    directoryNote: '筛选目录为随包目录：' + cropDoc.catalog_version + ' / ' + speciesDoc.catalog_version + ' / ' + regionDoc.catalog_version },
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () { fontScale.applyFontScale(this); this.checkGate() },
  onHide: function () { pageGate.cancel(this); this._applied = null; this._preset = null; this.setData({ q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '', profileState: 'idle', profileNote: '' }) },
  onUnload: function () { this.onHide() },
  clear: function () {
    this._displayBinding = null
    this._readOperation = (this._readOperation || 0) + 1
    // 任何一次用户操作都作废在途的档案预置：迟到的档案结果不得覆盖手选条件。
    this._prepareOperation = (this._prepareOperation || 0) + 1
    this.setData({ busy: false, items: [], nextCursor: null, modeNote: api.modeNote(), status: '', stateKind: 'idle' })
  },
  checkGate: function () {
    pageGate.start(this, ok => { this.clear(); this.setData({ gatePassed: ok }); if (ok) this.prepare() })
  },
  /**
   * 登录门通过后**只读一次**「我的档案」（不轮询、不落本地存储）：把档案的作物/地区预置成页面筛选，
   * 再发起**首次查询**（查询串因此带上预置条件）。读不到档案就如实说明"本次未按档案预置"，
   * 绝不用别的条件顶替，也绝不把省级资料说成档案地区的适用性。
   */
  prepare: function () {
    const self = this
    const op = this._prepareOperation = (this._prepareOperation || 0) + 1
    const live = function () { return self._gateActive === true && self._prepareOperation === op }
    if (!auth.isLoggedIn()) { this.setData({ gatePassed: false }); this.checkGate(); return }
    profileApi.read().then(function (p) { if (live()) self.applyProfile(p) }, function (e) {
      if (!live()) return
      const code = e && e.code
      if (code === 'SESSION_REQUIRED' || code === 'SESSION_CHANGED') { self.setData({ gatePassed: false }); self.checkGate(); return }
      // 档案响应对不上冻结契约：当前契约把 region_code 钉在 ^33[0-9]{4}$（浙江省）且作物/地区
      // 必须同时设置 —— 但 INVALID_RESPONSE 是 validProfile 的**通用**失败码（缺 revision、
      // region_catalog_version 非法、形状不符…都命中），所以这里**不能**断定"地区不在浙江省内"。
      // 只做不查询、不拿省级资料顶替，并让文案如实说"没能核对档案里的地区信息（原因未定）"。
      if (code === 'INVALID_RESPONSE') { self.outOfCoverage(); return }
      self._preset = null
      self.setData({ profileState: 'unread', profileNote: UNREADABLE_NOTE })
      self.read()
    })
  },
  /**
   * 档案响应核不出（通用 INVALID_RESPONSE）：**不发起查询**，给出如实的未核对提示。
   * 地区口径见文件头：不得把省级证据包装成档案地区的本地适用性；也不得断言失败原因
   * （INVALID_RESPONSE 无法区分"地区不在省内"与"响应形状/版本不符"）。
   */
  outOfCoverage: function () {
    this._preset = null
    this.setData({ profileState: 'out-of-coverage', profileNote: '', status: OUT_OF_COVERAGE, stateKind: 'out-of-coverage' })
  },
  /**
   * 把档案预置成页面筛选（`cropIndex`／`regionIndex`，首位"全部"语义不变）。
   * 省内档案地区一律预置成**省级** `330000` 并在提示里明示层级——页面下拉显示的查询口径
   * 与实际发出的 `region_code` 始终一致，不出现"显示上城区、实查 330000"的错位。
   */
  applyProfile: function (p) {
    const d = this.data
    if (p.crop_id === null && p.region_code === null) {
      // 空档案：不预置任何筛选，与"没有档案"时的既有行为一致。
      this._preset = null
      this.setData({ profileState: 'none', profileNote: EMPTY_PROFILE_NOTE })
      this.read()
      return
    }
    // 纵深防御的**冗余**复核：契约校验（utils/profile-api.js#validProfile）已把 region_code 钉在
    // ^33[0-9]{4}$，所以省外／核不出层级的档案在本页**实际**由 prepare() 的 INVALID_RESPONSE 分支
    // 拦下（那条路才是有覆盖的路径）。这一行只保证将来若校验放宽，也绝不把非浙江地区并进省级查询。
    if (p.region_code !== null && !ZHEJIANG.test(p.region_code)) { this.outOfCoverage(); return }
    const cropIndex = d.crops.findIndex(function (c) { return c.id === p.crop_id })
    const cropName = cropIndex === -1 ? '档案作物不在当前随包目录' : d.crops[cropIndex].name
    const region = d.regions.find(function (r) { return r.code === p.region_code })
    const regionName = region ? region.name : '地区码 ' + p.region_code
    const provinceIndex = d.regions.findIndex(function (r) { return r.code === PROVINCE_CODE })
    const preset = { cropIndex: cropIndex === -1 ? 0 : cropIndex, regionIndex: provinceIndex < 1 ? 0 : provinceIndex,
      note: '来自我的档案：' + cropName + ' · ' + regionName + '；' + (provinceIndex < 1 ? '随包地区目录里没有省级项，本次没有预置地区筛选。' : PROVINCE_NOTE) }
    this._preset = preset
    this.setData({ cropIndex: preset.cropIndex, regionIndex: preset.regionIndex, profileState: 'applied', profileNote: preset.note })
    this.read()
  },
  /** 手选改了作物/地区后，"来自我的档案"这行不再描述当前条件 ⇒ 如实撤下（改回预置再显示）。 */
  syncProfileNote: function () {
    if (this.data.profileState !== 'applied' || !this._preset) return
    const same = this.data.cropIndex === this._preset.cropIndex && this.data.regionIndex === this._preset.regionIndex
    const note = same ? this._preset.note : ''
    if (note !== this.data.profileNote) this.setData({ profileNote: note })
  },
  input: function (e) {
    const field = e.currentTarget.dataset.field
    if (['q', 'growth_stage', 'planting_method', 'use_scene'].indexOf(field) === -1) return
    this.clear(); api.clearSelection(); this.setData({ [field]: e.detail.value })
  },
  pick: function (e) {
    const field = e.currentTarget.dataset.field, index = Number(e.detail.value)
    const entries = { cropIndex: this.data.crops, speciesIndex: this.data.species, regionIndex: this.data.regions }[field]
    if (!entries || !Number.isInteger(index) || index < 0 || index >= entries.length) return
    this.clear(); api.clearSelection(); this.setData({ [field]: index })
    if (field === 'cropIndex' || field === 'regionIndex') this.syncProfileNote()
  },
  toggle: function () { this.setData({ advanced: !this.data.advanced }) },
  conditions: function () {
    const d = this.data, q = { limit: 20 }
    const values = { q: d.q.trim(), crop_id: d.crops[d.cropIndex].id, species_id: d.species[d.speciesIndex].id, region_code: d.regions[d.regionIndex].code,
      growth_stage: d.growth_stage.trim(), planting_method: d.planting_method.trim(), use_scene: d.use_scene.trim() }
    Object.keys(values).forEach(k => { if (values[k]) q[k] = values[k] }); return api.filters(q, true)
  },
  /**
   * 本次查询里被"未采集"的维度名（生育期／种植方式／使用场景）。入参可以是页面 `data`（手选值）或
   * 已发出的查询串（`_applied`／`q`，`conditions()` 只为非空值建键）——非空即视为用户填了该条件。
   * 返回空数组 ⇒ 三个条件都没填，走既有泛化空态（不得把"真的没有"说成"未采集"）。
   */
  uncollectedConditions: function (source) {
    const s = source || this.data
    return CONDITION_FIELDS.filter(f => String(s[f[0]] || '').trim() !== '').map(f => f[1])
  },
  /** 未采集维度的**明确**文案：逐维度点名「当前资料未采集X条件」，并给出只清空这三个条件的出口。 */
  uncollectedNote: function (names) {
    return names.map(n => UNCOLLECTED_HEAD + n + '条件').join('；') + UNCOLLECTED_NOTE
  },
  search: function () { if (this.data.gatePassed) this.read(); else this.checkGate() },
  reset: function () { this.setData({ q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '' }); this.syncProfileNote(); this.search() },
  /**
   * 未采集条件的出口：只清空生育期／种植方式／使用场景（作物／杂草／地区／关键词保持不变）后重查。
   * 与 `reset`（清空全部条件）区分：用户只是想绕开"资料没采集"的维度，不必丢掉已选的作物与地区。
   * 展开「更多条件」让用户看得见这三个输入框确实已被清空。
   */
  clearUncollected: function () {
    this.clear(); api.clearSelection()
    this.setData({ growth_stage: '', planting_method: '', use_scene: '', advanced: true })
    this.search()
  },
  next: function () { if (!this.data.busy && this.data.nextCursor) this.read(this.data.nextCursor) },
  read: async function (cursor) {
    this.clear(); api.clearSelection()
    if (!this.data.gatePassed || !auth.isLoggedIn()) { this.setData({ gatePassed: false }); this.checkGate(); return }
    const b = api.binding(), operation = this._readOperation
    const current = () => this._gateActive === true && this._readOperation === operation && api.current(b)
    let q
    try {
      q = cursor ? Object.assign({}, this._applied, { cursor }) : this.conditions()
      if (!cursor) this._cursors = []
      if (cursor && this._cursors.indexOf(cursor) !== -1) throw { code: 'INVALID_RESPONSE' }
      this._applied = Object.assign({}, q); delete this._applied.cursor
      this.setData({ busy: true, status: '正在核对当前资料…', stateKind: 'loading' })
      const r = await api.list(q)
      if (!current()) return
      if (r.nextCursor && (this._cursors.indexOf(r.nextCursor) !== -1 || this._cursors.length >= 100)) throw { code: 'INVALID_RESPONSE' }
      if (cursor) this._cursors.push(cursor)
      this._displayBinding = b
      // 空结果要分清两种原因：条件维度非空 ⇒ **资料未采集该维度**（服务端必然返回空，给出明确原因与
      // 清空出口）；三个条件都为空 ⇒ 才是既有泛化空态"没有符合条件的资料"。
      const uncollected = this.uncollectedConditions(this._applied)
      this.setData({ busy: false, nextCursor: r.nextCursor, modeNote: api.modeNote(r.mode),
        items: r.items.map(item => ({ id: item.id, item, labels: api.labels(item), conditionNote: item.conditions ? '适用条件需逐项核对，不能据此推定用量可用。' : '条件资料不足，不能据此确定适用性或用量。' })),
        stateKind: r.items.length ? 'ready' : (uncollected.length ? 'uncollected' : 'empty'),
        status: r.items.length ? '已读取当前页资料；详情会重新核对来源。' : (uncollected.length ? this.uncollectedNote(uncollected) : '没有符合条件的资料，请调整条件继续查询。') })
    } catch (e) {
      if (!current()) { if (this._gateActive === true && this._readOperation === operation) { this.clear(); this.setData({ gatePassed: false, status: api.message(e) }) }; return }
      this.setData({ busy: false, items: [], nextCursor: null, status: api.message(e), stateKind: 'error' })
    }
  },
  open: function (e) {
    if (!this.data.gatePassed || !api.current(this._displayBinding) || this.data.busy) { this.clear(); this.setData({ gatePassed: false }); return }
    const id = e.currentTarget.dataset.id, entry = this.data.items.find(x => x.item.id === id)
    if (!entry) return
    api.remember(entry.item, this._applied || {})
    wx.navigateTo({ url: '/pages/knowledgedetail/knowledgedetail?id=' + encodeURIComponent(id) })
  }
})
