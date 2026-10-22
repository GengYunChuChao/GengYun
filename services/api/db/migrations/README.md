# 迁移目录说明（仅用于「有意缺号」的可核证依据）

本目录只放**正向迁移**（`NNNN_<name>.sql`）与 `rollback/NNNN_<name>.down.sql`。
机器可读的「保留号台账」在 `services/api/db/migration-reservations.json`；
`tools/verify-migrations-unique.mjs` 的 `[gap]` 判据要求缺号在**本目录的 `.md`** 里有一行依据：

- 0029 预留：`0029_media_object_cleanup.sql` 在 PR #419（`feat/gy-r28-media-object-cleanup`）分支上在途，
  尚未合入 `origin/main`；本目录因此缺 29 号。台账已登记（`owner: #419`），**#419 合入即删台账条目**，
  届时本行也一并删除。

## 为什么 0030 跳过了 0031+

`0030_community_author_ref.sql`（F13 行级作者注销引用）取的是 0028 之后的第一个空号（29 被 #419 占着），
不是「随便跳号」。后续迁移请从 0030 起连续编号。
