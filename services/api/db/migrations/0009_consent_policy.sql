-- GY-I27 operator-reviewed grant authority. No production policy or recipient seeds.
-- Independent of media; depends only on 0001,0003. Published content is immutable.
BEGIN;
CREATE TABLE consent_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose consent_purpose NOT NULL,
  policy_version varchar(80) NOT NULL CHECK (length(policy_version)>0),
  source_kind varchar(20) NOT NULL CHECK (source_kind IN ('verified','synthetic')),
  source_ref varchar(2000) NOT NULL CHECK (length(source_ref)>0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  review_evidence_ref varchar(2000) NOT NULL CHECK (length(review_evidence_ref)>0),
  recipient_bindings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(recipient_bindings)='object'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  reviewed_by uuid REFERENCES admin_accounts(id),
  reviewed_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(purpose,policy_version),
  CHECK (valid_until>valid_from),
  CHECK ((reviewed_by IS NULL)=(reviewed_at IS NULL)),
  CHECK (NOT enabled OR reviewed_at IS NOT NULL)
);
CREATE UNIQUE INDEX consent_policies_enabled_purpose ON consent_policies(purpose) WHERE enabled;
CREATE FUNCTION consent_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.reviewed_at IS NOT NULL THEN
      RAISE EXCEPTION 'reviewed policy history cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.reviewed_at IS NOT NULL AND
     (to_jsonb(NEW)-'enabled'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'enabled'-'updated_at') THEN
    RAISE EXCEPTION 'reviewed policy content is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_policy_immutable BEFORE UPDATE OR DELETE ON consent_policies
  FOR EACH ROW EXECUTE FUNCTION consent_policy_immutable();
COMMIT;
