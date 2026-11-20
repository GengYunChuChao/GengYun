CREATE TABLE app.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'user',
  display_name text NOT NULL DEFAULT '田间探索者',
  crop text NOT NULL DEFAULT '水稻',
  auto_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES app.accounts (id),
  kind text NOT NULL,
  item_key text NOT NULL,
  title text NOT NULL,
  subtitle text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, item_key)
);
CREATE INDEX favorites_account_created_idx ON app.favorites (account_id, created_at);

CREATE TABLE app.history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES app.accounts (id),
  client_id uuid NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  subtitle text NOT NULL DEFAULT '',
  corrections integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_id)
);
CREATE INDEX history_account_created_idx ON app.history (account_id, created_at);

CREATE TABLE app.message_reads (
  account_id uuid NOT NULL REFERENCES app.accounts (id),
  message_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, message_id)
);

CREATE TABLE app.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES app.accounts (id),
  author_name text NOT NULL,
  crop text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  report_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX posts_status_created_idx ON app.posts (status, created_at);
CREATE INDEX posts_author_created_idx ON app.posts (author_id, created_at);

CREATE TABLE app.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES app.posts (id),
  author_id uuid NOT NULL REFERENCES app.accounts (id),
  author_name text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'published',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_created_idx ON app.comments (post_id, created_at);

CREATE TABLE app.likes (
  post_id uuid NOT NULL REFERENCES app.posts (id),
  account_id uuid NOT NULL REFERENCES app.accounts (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, account_id)
);

CREATE TABLE app.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES app.posts (id),
  reporter_id uuid NOT NULL REFERENCES app.accounts (id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_id)
);
CREATE INDEX reports_post_idx ON app.reports (post_id);

CREATE TABLE app.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES app.accounts (id),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  target text NOT NULL DEFAULT '/community',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_account_created_idx ON app.notifications (account_id, created_at);

CREATE TABLE app.recognition_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES app.accounts (id),
  object_path text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'uploaded',
  note text NOT NULL DEFAULT '',
  corrected_summary text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recognition_jobs_account_created_idx ON app.recognition_jobs (account_id, created_at);
CREATE INDEX recognition_jobs_status_created_idx ON app.recognition_jobs (status, created_at);