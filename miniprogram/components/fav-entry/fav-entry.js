// GY-I16 识别结果页「收藏」入口（自包含组件，不依赖宿主页面的状态机）。
//
// 为什么做成组件而不是改 identify.js：识别页的候选渲染与状态机在
// miniprogram/pages/identify/identify.js 里，该文件正被 DRAFT PR #324 占用。本组件只接收一个
// `job-id` 属性，自己取作业详情、自己取目标资料版本、自己读写收藏；宿主页面只加一行标签，
// 因此与 #324 零冲突。
//
// 硬口径（与 services/api/src/routes/favorites.ts:46、favorites/service.ts:359 同源）：
// 1. 收藏目标只取契约闭集 `FavoriteTarget.type = species|herbicide|scheme` 中的 `species`：
//    识别候选本身就是 `species_id`。「本次识别结论」不在闭集里，本组件**不发明** target 类型。
// 2. `target_ref.revision` 必须是**目标资料**的 revision，只能现场从 `GET /knowledge/{id}` 取；
//    取不到就不给收藏入口。favorites-api.createFavorite 没有 If-Match，服务端不会替我们挡住
//    错版本，所以版本必须由本组件自己 fail-closed。
// 3. fail-closed：拿不到候选、或没有任何候选能取到可用 revision ⇒ 整块不渲染，不留任何
//    「无候选也能收藏」的按钮。
// 4. 取消收藏走 DELETE + If-Match；409 REVISION_CONFLICT / 428 / 403 一律如实透传成人话，
//    **不**把 409 吞成「已取消」。
// 5. 收藏行自身的 revision 与目标资料的 revision 是两个不同的版本号：前者只用于 If-Match
//    （deleteFavorite），后者只用于 target_ref（createFavorite）。
// 6. 只在**作业真的成功**（`job.state === 'succeeded'`）时装配（监工 1021-2358）。之前只观察
//    `jobId`／`enabled`：宿主创建任务时就把 queued 的 job.id 写进来了，之后同一个 id 变成
//    succeeded 时这两个值都没变，`_key` 短路 ⇒ 第一次读到的「queued + 空候选」被永久记住，
//    收藏入口在该出现的时候永远不出现。现在两条路一起收口：
//      a. 宿主把 `job.state` 传进 `job-state`，状态进入 `_key`：queued→succeeded 必然重新装配；
//      b. 读到的作业还没到终态时不记 `_key`（未完成不是结论），重复触发会重新取，而不是沿用空结果。
//    非 succeeded（queued/running/uncertain/failed/timed_out/cancelled）一律不装配：候选不可信时
//    收藏等于把不确定结论固化成目标，宁可不给入口。
'use strict'

const identifyApi = require('../../utils/identify-api')
const favoritesApi = require('../../utils/favorites-api')
const knowledgeApi = require('../../utils/knowledge-api')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TARGET_TYPE = 'species'
const MAX_ENTRIES = 3
const OWNED_LIMIT = 50
/** 唯一允许装配收藏入口的作业状态（与 identify-api 的 `isSuccessState` 同口径）。 */
const SUCCESS_STATE = 'succeeded'

/**
 * 把错误翻成人话：优先用收藏域自己的码表（它已经把 401/403 的分流委托给 auth.failureFor），
 * 码表没覆盖的走兜底文案。绝不把原始 code 直接甩给用户。
 */
function messageOf(error, api) {
  try {
    if (api && typeof api.messageFor === 'function') {
      const text = api.messageFor(error)
      if (typeof text === 'string' && text !== '') return text
    }
  } catch (_) {}
  return '操作未完成，请稍后重试。'
}

function keyOf(type, id) { return String(type) + ':' + String(id) }

Component({
  options: { styleIsolation: 'isolated' },

  properties: {
    // 识别作业 id（宿主页面已有的 job.id）。空串或非 UUID ⇒ 组件不发任何请求、不渲染。
    jobId: { type: String, value: '' },
    // 显式开关：宿主在游客态/无任务时可传 false 彻底关掉入口。
    enabled: { type: Boolean, value: true },
    // 宿主状态机里的作业状态（`job.state`）。非空且不是 succeeded ⇒ 直接不装配（fail-closed）。
    // 空串表示宿主未声明状态，此时退回「以服务端作业状态为准」（仍是 succeeded 才装配）。
    jobState: { type: String, value: '' }
  },

  data: {
    visible: false,      // 只在「有候选且至少一条能收藏」时为 true
    loading: false,
    busy: false,         // 单次只能点一个，避免并发两条互斥请求
    note: '',            // 成功类提示
    errorText: '',       // 失败类提示（与 note 互斥）
    items: []            // [{ speciesId, label, rank, revision, favorited, favoriteId, favoriteRevision, unavailableReason }]
  },

  observers: {
    'jobId, enabled, jobState': function (jobId, enabled, jobState) { return this.reload(jobId, enabled, jobState) }
  },

  lifetimes: {
    detached: function () { this._gen = (this._gen || 0) + 1 }
  },

  methods: {
    /**
     * 重新装配整个入口。返回 Promise 便于测试与宿主 await（宿主不会等它）。
     *
     * 一次装配由 `(enabled, jobId, jobState)` 三元组决定：三者都没变才短路。宿主把同一个作业从
     * queued 走到 succeeded 时 `jobState` 变了 ⇒ 必然重新取，不会被上次的空结果挡住。
     * 「作业还没完成」不算结论，所以读到非终态时不写 `_key`（见下文）。
     */
    reload: async function (jobId, enabled, jobState) {
      const on = enabled === undefined ? this.data.enabled !== false : enabled !== false
      const value = typeof jobId === 'string' ? jobId : ''
      const declared = typeof jobState === 'string' ? jobState
        : (typeof this.data.jobState === 'string' ? this.data.jobState : '')
      const key = (on ? '1' : '0') + '|' + value + '|' + declared
      if (this._key === key) return
      this._key = key
      const gen = (this._gen = (this._gen || 0) + 1)

      // 先清空可见状态：任何一次装配失败都不许残留上一次的收藏按钮。
      this.setData({ visible: false, loading: false, busy: false, note: '', errorText: '', items: [] })
      if (!on || !UUID.test(value)) return
      // fail-closed 第零道：宿主状态机说这个作业还没成功 ⇒ 直接不给入口，一次请求都不发。
      if (declared !== '' && declared !== SUCCESS_STATE) return

      this.setData({ loading: true })
      let candidates
      try {
        const job = await identifyApi.getJob(value)
        if (gen !== this._gen) return
        // 服务端状态才是事实来源：宿主声明 succeeded 但服务端仍是 queued/running 时，照样不给入口。
        if (!job || !job.job || job.job.state !== SUCCESS_STATE) {
          this._key = ''
          this.setData({ loading: false })
          return
        }
        candidates = (identifyApi.viewModelForJob(job.job).candidates || []).slice(0, MAX_ENTRIES)
      } catch (error) {
        if (gen !== this._gen) return
        this.setData({ loading: false, errorText: messageOf(error, identifyApi) })
        return
      }

      // fail-closed 第一道：没有候选就没有收藏入口，也不去猜一个目标。
      if (candidates.length === 0) { this.setData({ loading: false }); return }

      const owned = await this.readOwned()
      if (gen !== this._gen) return

      try {
        const items = await this.resolve(candidates, owned.map)
        if (gen !== this._gen) return
        // fail-closed 第二道：候选全都取不到可用 revision ⇒ 仍然不渲染。
        if (items.length === 0) { this.setData({ loading: false }); return }
        this.setData({
          loading: false,
          visible: true,
          items: items,
          note: owned.failed ? '已收藏状态未能核对，点击后会以服务端回执为准。' : ''
        })
      } catch (error) {
        if (gen !== this._gen) return
        this.setData({ loading: false, errorText: messageOf(error, favoritesApi) })
      }
    },

    /** 拉一页自己的收藏，建立 `species:<id>` → 收藏行 的映射。读失败不阻断写入（POST 幂等）。 */
    readOwned: async function () {
      try {
        const page = await favoritesApi.listFavorites(undefined, OWNED_LIMIT)
        const map = {}
        const rows = (page && page.items) || []
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i]
          if (!row || !row.target_ref) continue
          map[keyOf(row.target_ref.type, row.target_ref.id)] = row
        }
        return { map: map, failed: false }
      } catch (_) {
        return { map: {}, failed: true }
      }
    },

    /**
     * 逐个候选取目标资料版本。任何一个候选取不到（网络失败 / NOT_FOUND / 类型不是 species /
     * 版本非法）就**只丢这一个候选**，不影响其它候选；绝不裸写没有 revision 的收藏。
     */
    resolve: async function (candidates, owned) {
      const items = []
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        const speciesId = candidate && typeof candidate.species_id === 'string' ? candidate.species_id : ''
        if (!UUID.test(speciesId)) continue
        let revision = 0
        try {
          const detail = await knowledgeApi.detail(speciesId)
          const item = detail && detail.item
          // 只有 species 实体能当 FavoriteTarget；资料类型不符不猜（闭集见 routes/favorites.ts:46）。
          if (!item || item.type !== TARGET_TYPE || !Number.isSafeInteger(item.revision) || item.revision < 1) continue
          revision = item.revision
        } catch (_) {
          continue
        }
        const ownedRow = owned[keyOf(TARGET_TYPE, speciesId)] || null
        items.push({
          speciesId: speciesId,
          label: speciesId,
          rank: candidate && candidate.rank ? candidate.rank : 0,
          revision: revision,
          favorited: ownedRow !== null,
          favoriteId: ownedRow ? ownedRow.id : '',
          favoriteRevision: ownedRow ? ownedRow.revision : 0,
          unavailableReason: ownedRow && ownedRow.reference_state === 'unavailable' ? (ownedRow.unavailable_reason || '') : ''
        })
      }
      return items
    },

    /** 点一次：已收藏 → 取消；未收藏 → 收藏。两条路径都把服务端回执当真。 */
    onToggle: async function (event) {
      if (this.data.busy) return
      const index = Number(event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.index : NaN)
      const item = this.data.items[index]
      if (!item) return
      const gen = this._gen
      this.setData({ busy: true, note: '', errorText: '' })
      try {
        if (item.favorited) await this.remove(item, index, gen)
        else await this.add(item, index, gen)
      } catch (error) {
        if (gen !== this._gen) return
        this.setData({ busy: false })
        await this.onFailure(error, index, gen)
      }
    },

    add: async function (item, index, gen) {
      const result = await favoritesApi.createFavorite(TARGET_TYPE, item.speciesId, item.revision)
      if (gen !== this._gen) return
      const favorite = result.favorite
      this.patch(index, {
        favorited: true,
        favoriteId: favorite.id,
        favoriteRevision: favorite.revision,
        unavailableReason: favorite.reference_state === 'unavailable' ? (favorite.unavailable_reason || '') : ''
      })
      // 收藏不恢复推荐资格：目标下架时如实说明，而不是假装收藏成功就万事大吉。
      this.setData({
        busy: false,
        note: favorite.reference_state === 'available' ? '已收藏。' : '已收藏，但目标当前不可用（收藏不会恢复推荐资格）。'
      })
    },

    remove: async function (item, index, gen) {
      await favoritesApi.deleteFavorite(item.favoriteId, item.favoriteRevision)
      if (gen !== this._gen) return
      this.patch(index, { favorited: false, favoriteId: '', favoriteRevision: 0, unavailableReason: '' })
      this.setData({ busy: false, note: '已取消收藏。' })
    },

    /**
     * 失败分流。409/428/403 只报错、不改本地收藏状态（尤其**不**把 409 当成已取消）。
     * NOT_FOUND 说明服务端这边确实没有这行（或不属于本人）⇒ 本地状态归零，但错误照报。
     */
    onFailure: async function (error, index, gen) {
      const code = error && error.code
      if (code === 'REVISION_CONFLICT') {
        // 顺手把收藏行版本刷新一次，让下一次操作有正确 If-Match；本次仍以冲突告终。
        const owned = await this.readOwned()
        if (gen !== this._gen) return
        const item = this.data.items[index]
        const fresh = item ? owned.map[keyOf(TARGET_TYPE, item.speciesId)] : null
        if (fresh) this.patch(index, { favoriteId: fresh.id, favoriteRevision: fresh.revision })
        this.setData({ errorText: messageOf(error, favoritesApi) })
        return
      }
      if (code === 'NOT_FOUND') {
        this.patch(index, { favorited: false, favoriteId: '', favoriteRevision: 0, unavailableReason: '' })
        this.setData({ errorText: messageOf(error, favoritesApi) })
        return
      }
      this.setData({ errorText: messageOf(error, favoritesApi) })
    },

    /** 整体替换一条（数组不可变更新：宿主拿到的 items 引用每次都是新的）。 */
    patch: function (index, changes) {
      const items = this.data.items.slice()
      if (!items[index]) return
      items[index] = Object.assign({}, items[index], changes)
      this.setData({ items: items })
    }
  }
})
