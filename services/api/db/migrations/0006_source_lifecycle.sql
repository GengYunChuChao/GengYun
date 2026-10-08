-- Refs #3/#27. Adds immutable operator/request/state evidence, not source review.
-- Existing events lack actor, CAS revision, restore linkage and idempotency payload.
CREATE SCHEMA catalog_ops;
REVOKE ALL ON SCHEMA catalog_ops FROM PUBLIC;
CREATE TABLE catalog_ops.operations (
  id uuid PRIMARY KEY REFERENCES public.catalog_source_update_events(id),
  action text NOT NULL CHECK (action IN ('withdraw','restore')),
  actor text NOT NULL,
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  source_id uuid NOT NULL REFERENCES public.sources(id),
  source_version_id uuid NOT NULL REFERENCES public.source_versions(id),
  restores_operation_id uuid UNIQUE REFERENCES catalog_ops.operations(id),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  executed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((action = 'restore') = (restores_operation_id IS NOT NULL))
);
REVOKE ALL ON ALL TABLES IN SCHEMA catalog_ops FROM PUBLIC;

CREATE FUNCTION catalog_ops.apply_source_operation(
  p_id uuid, p_action text, p_source uuid, p_version uuid,
  p_revision integer, p_validity text, p_reason text, p_restores uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET TimeZone = 'UTC' AS $$
DECLARE
  req jsonb;
  prior catalog_ops.operations%ROWTYPE;
  withdrawal catalog_ops.operations%ROWTYPE;
  withdrawal_event public.catalog_source_update_events%ROWTYPE;
  src public.sources%ROWTYPE;
  ver public.source_versions%ROWTYPE;
  before_data jsonb;
  after_data jsonb;
  next_validity public.source_validity;
BEGIN
  IF p_id IS NULL OR p_source IS NULL OR p_version IS NULL
     OR p_action IS NULL OR p_action NOT IN ('withdraw','restore')
     OR p_revision IS NULL OR p_revision < 1 OR p_revision >= 2147483647
     OR p_validity IS NULL OR p_validity NOT IN ('valid','unknown','expired','conflicting','withdrawn')
     OR p_reason IS NULL OR p_reason !~ '[^[:space:]]' OR length(p_reason) > 200
     OR (p_action = 'restore' AND p_restores IS NULL)
     OR (p_action = 'withdraw' AND p_restores IS NOT NULL)
  THEN RAISE EXCEPTION USING ERRCODE='G0001', MESSAGE='INVALID_REQUEST'; END IF;
  req := jsonb_build_object('action',p_action,'source_id',p_source,'source_version_id',p_version,
    'expected_revision',p_revision,'expected_validity',p_validity,'reason',p_reason,'restores_operation_id',p_restores);
  -- Serialize identical operation IDs before locking the target source.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text, 6006));
  SELECT * INTO prior FROM catalog_ops.operations WHERE id = p_id;
  IF FOUND THEN
    IF prior.request IS DISTINCT FROM req OR prior.actor <> session_user
    THEN RAISE EXCEPTION USING ERRCODE='G0005', MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
    -- Replay is a receipt of the historical operation, never another state write.
    RETURN jsonb_build_object('operation_id',p_id,'action',prior.action,'source_id',prior.source_id,
      'source_version_id',prior.source_version_id,'resulting_revision',prior.after_state->'revision',
      'resulting_validity',prior.after_state->'validity','replayed',true);
  END IF;
  SELECT * INTO src FROM public.sources WHERE id = p_source FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G0002', MESSAGE='NOT_FOUND'; END IF;
  SELECT * INTO ver FROM public.source_versions WHERE id = p_version AND source_id = p_source FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G0002', MESSAGE='NOT_FOUND'; END IF;
  IF src.revision <> p_revision OR ver.validity::text <> p_validity
     OR src.current_version_id IS DISTINCT FROM p_version
  THEN RAISE EXCEPTION USING ERRCODE='G0003', MESSAGE='REVISION_CONFLICT'; END IF;
  before_data := jsonb_build_object('revision',src.revision,'current_version_id',src.current_version_id,
    'validity',ver.validity,'review_status',ver.review_status,'reviewed_by',ver.reviewed_by,
    'reviewed_at',ver.reviewed_at,'source_kind',src.source_kind,'content_hash',ver.content_hash,
    'version_label',ver.version,'locator',ver.locator,'canonical_url',src.canonical_url,
    'valid_from',ver.valid_from,'valid_to',ver.valid_to);
  IF p_action = 'withdraw' THEN
    IF ver.validity = 'withdrawn' THEN RAISE EXCEPTION USING ERRCODE='G0003', MESSAGE='REVISION_CONFLICT'; END IF;
    next_validity := 'withdrawn';
  ELSE
    SELECT * INTO withdrawal FROM catalog_ops.operations WHERE id = p_restores;
    IF NOT FOUND OR withdrawal.action <> 'withdraw'
       OR withdrawal.source_id <> p_source OR withdrawal.source_version_id <> p_version
       OR withdrawal.before_state->>'validity' IS DISTINCT FROM 'valid'
       OR withdrawal.after_state IS DISTINCT FROM before_data
       OR ver.validity <> 'withdrawn' OR ver.review_status <> 'verified'
       OR ver.reviewed_by IS NULL OR ver.reviewed_at IS NULL
       OR ver.valid_from > clock_timestamp()
       OR (ver.valid_to IS NOT NULL AND ver.valid_to <= clock_timestamp())
       OR src.source_kind = 'simulation'
    THEN RAISE EXCEPTION USING ERRCODE='G0004', MESSAGE='SOURCE_CONFLICT'; END IF;
    SELECT * INTO withdrawal_event FROM public.catalog_source_update_events WHERE id=p_restores FOR UPDATE;
    IF NOT FOUND OR withdrawal_event.event IS DISTINCT FROM 'withdrawn'
       OR withdrawal_event.source_id IS DISTINCT FROM p_source OR withdrawal_event.source_version_id IS DISTINCT FROM p_version
       OR withdrawal_event.old_validity IS DISTINCT FROM 'valid' OR withdrawal_event.new_validity IS DISTINCT FROM 'withdrawn'
       OR withdrawal_event.reverted_at IS NOT NULL
    THEN RAISE EXCEPTION USING ERRCODE='G0004', MESSAGE='SOURCE_CONFLICT'; END IF;
    -- Exact withdraw linkage + unchanged snapshot + date/review checks. No promotion.
    next_validity := 'valid';
  END IF;
  UPDATE public.source_versions SET validity = next_validity WHERE id = p_version;
  UPDATE public.sources SET revision = revision + 1 WHERE id = p_source;
  after_data := before_data || jsonb_build_object('revision',src.revision+1,'validity',next_validity);
  INSERT INTO public.catalog_source_update_events
    (id,source_id,source_version_id,event,old_validity,new_validity,reason)
  VALUES (p_id,p_source,p_version,CASE WHEN p_action='withdraw' THEN 'withdrawn' ELSE 'rolled_back' END,
    ver.validity::text,next_validity::text,p_reason);
  INSERT INTO catalog_ops.operations(id,action,actor,request,source_id,source_version_id,
    restores_operation_id,before_state,after_state)
  VALUES(p_id,p_action,session_user,req,p_source,p_version,p_restores,before_data,after_data);
  IF p_action='restore' THEN
    UPDATE public.catalog_source_update_events SET reverted_at=clock_timestamp() WHERE id=p_restores;
  END IF;
  RETURN jsonb_build_object('operation_id',p_id,'action',p_action,'source_id',p_source,
    'source_version_id',p_version,'resulting_revision',src.revision+1,
    'resulting_validity',next_validity,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION catalog_ops.apply_source_operation(uuid,text,uuid,uuid,integer,text,text,uuid) FROM PUBLIC;
