import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationSql = readFileSync(resolve(root, 'services/api/db/migrations/0001_initial_schema.sql'), 'utf8');

/**
 * 约束负例：使用内存 PostgreSQL 引擎（PGlite 0.5.8，基于 PostgreSQL 18.x 内核）。
 * 注意：这只证明 SQL 约束语义，不构成目标 PostgreSQL 17.11 的真实迁移验收。
 */
test('0001 在内存 PostgreSQL 引擎（PGlite 0.5.8）可整体执行', async () => {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.close();
});

test('post_versions linked_target 三列同空或同有：revision=NULL 被拒绝', async () => {
  const db = new PGlite();
  await db.exec(migrationSql);

  await db.query(
    `INSERT INTO public_authors (display_name, avatar_media_id, avatar_media_revision, avatar_audit_state)
     VALUES ('测试作者', NULL, NULL, NULL)`,
  );
  const author = await db.query('SELECT id FROM public_authors LIMIT 1');
  const authorId = author.rows[0].id;

  await db.query(
    `INSERT INTO posts (author_ref, current_revision, visibility) VALUES ($1, 1, 'private')`,
    [authorId],
  );
  const post = await db.query('SELECT id FROM posts LIMIT 1');
  const postId = post.rows[0].id;

  // 正例：三列全空，可插入。
  await db.query(`INSERT INTO post_versions (post_id, revision, title, body) VALUES ($1, 1, '标题', '正文')`, [postId]);

  // 负例：type/id 非空但 revision 为 NULL，必须被 CHECK 拒绝。
  const targetId = '00000000-0000-0000-0000-000000000001';
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO post_versions
           (post_id, revision, title, body, linked_target_type, linked_target_id, linked_target_revision)
         VALUES ($1, 2, '标题2', '正文2', 'species', $2, NULL)`,
        [postId, targetId],
      ),
    (error) => {
      const message = String(error && error.message);
      return /post_versions_link_triple|violates check constraint|check constraint/i.test(message);
    },
  );

  await db.close();
});
