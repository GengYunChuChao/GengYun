-- Refs #3/#27. Dedicated local database only; no adoption of existing pgcrypto.
CREATE SCHEMA staging_intake;
REVOKE ALL ON SCHEMA staging_intake FROM PUBLIC;
-- SHA1 verifies the existing UUIDv5 contract; SHA256 binds raw rows and receipts.
CREATE EXTENSION pgcrypto WITH SCHEMA staging_intake;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA staging_intake FROM PUBLIC;
CREATE TABLE staging_intake.batches (
  batch_id uuid PRIMARY KEY,
  actor text NOT NULL,
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_version text NOT NULL CHECK (mapping_version='herbicide-summary-v1'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  generation integer NOT NULL CHECK (generation > 0),
  import_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('imported','reverted')),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 10000)
);
CREATE TABLE staging_intake.operations (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES staging_intake.batches(batch_id),
  action text NOT NULL CHECK (action IN ('import','rollback')),
  actor text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  executed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ALL TABLES IN SCHEMA staging_intake FROM PUBLIC;

-- Same separators/order as Python json.dumps(sort_keys=True, ensure_ascii=False).
-- Intake cell values are strings/null, so no cross-runtime numeric conversion.
CREATE FUNCTION staging_intake.python_json(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE result text;
BEGIN
  IF jsonb_typeof(p)='object' THEN
    SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||': '||staging_intake.python_json(value),', ' ORDER BY key COLLATE "C"),'')||'}'
      INTO result FROM jsonb_each(p);
  ELSIF jsonb_typeof(p)='array' THEN
    SELECT '['||coalesce(string_agg(staging_intake.python_json(value),', ' ORDER BY ord),'')||']'
      INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS a(value,ord);
  ELSE result:=p::text;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION staging_intake.python_json(jsonb) FROM PUBLIC;

CREATE FUNCTION staging_intake.apply_import(p_id uuid,p_payload jsonb,p_previous_import uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE
  payload jsonb; bid uuid; expected_uuid text; uuid_hex text; file_hash text;
  ph text; rh text; r jsonb; n integer; owner_row staging_intake.batches%ROWTYPE;
  prior staging_intake.operations%ROWTYPE; gen integer; receipt jsonb;
BEGIN
  IF p_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR (p_payload - ARRAY['batch_id','sha256','filename','mapping_version','extracted_at','quality','rows'])<>'{}'::jsonb
    OR NOT p_payload ?& ARRAY['batch_id','sha256','filename','mapping_version','quality','rows']
    OR octet_length(convert_to(p_payload::text,'UTF8'))>8000000
    OR jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payload->'quality') IS DISTINCT FROM 'object'
    OR p_payload->>'mapping_version' IS DISTINCT FROM 'herbicide-summary-v1'
    OR coalesce(p_payload->>'filename','')='' OR length(p_payload->>'filename')>255
    OR coalesce(p_payload->>'sha256','') !~ '^[0-9a-f]{64}$'
    OR coalesce(p_payload->>'batch_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION USING ERRCODE='G0001',MESSAGE='INVALID_INTAKE'; END IF;
  bid:=(p_payload->>'batch_id')::uuid; file_hash:=p_payload->>'sha256';
  uuid_hex:=encode(staging_intake.digest(decode('6ba7b8119dad11d180b400c04fd430c8','hex')||
    convert_to(file_hash||':herbicide-summary-v1','UTF8'),'sha1'),'hex');
  expected_uuid:=substr(uuid_hex,1,8)||'-'||substr(uuid_hex,9,4)||'-5'||substr(uuid_hex,14,3)||'-'||
    substr('89ab',((get_byte(decode(uuid_hex,'hex'),8)&63)>>4)+1,1)||substr(uuid_hex,18,3)||'-'||substr(uuid_hex,21,12);
  IF bid::text<>expected_uuid THEN RAISE EXCEPTION USING ERRCODE='G0001',MESSAGE='BATCH_HASH_MISMATCH'; END IF;
  n:=jsonb_array_length(p_payload->'rows');
  IF n NOT BETWEEN 1 AND 10000 OR jsonb_typeof(p_payload->'quality'->'sheets') IS DISTINCT FROM 'array'
    OR p_payload->'quality'->'macro_present' IS DISTINCT FROM 'false'::jsonb
    OR p_payload->'quality'->'external_links_present' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION USING ERRCODE='G0001',MESSAGE='INVALID_INTAKE'; END IF;
  -- Check every row and its actual raw content before touching any tables.
  FOR r IN SELECT value FROM jsonb_array_elements(p_payload->'rows') LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR coalesce(r->>'sheet','')='' OR length(r->>'sheet')>255
      OR (r-ARRAY['sheet','excel_row','row_hash','raw','mapped','state','issues'])<>'{}'::jsonb
      OR NOT r ?& ARRAY['sheet','excel_row','row_hash','raw','mapped','state','issues']
      OR jsonb_typeof(r->'excel_row') IS DISTINCT FROM 'number' OR coalesce(r->>'excel_row','') !~ '^[1-9][0-9]{0,6}$'
      OR (r->>'excel_row')::integer>1048576
      OR jsonb_typeof(r->'raw') IS DISTINCT FROM 'object' OR jsonb_typeof(r->'raw'->'cells') IS DISTINCT FROM 'object'
      OR jsonb_typeof(r->'mapped') IS DISTINCT FROM 'object' OR jsonb_typeof(r->'issues') IS DISTINCT FROM 'array'
      OR coalesce(r->>'state','') NOT IN ('context','unreviewed','quarantined')
      OR (r->>'state'='context' AND (r->'mapped'<>'{}'::jsonb OR r->'issues'<>'[]'::jsonb))
      OR (r->>'state'<>'context' AND (r->'mapped'->>'validity' IS DISTINCT FROM 'unknown'
        OR r->'mapped'->>'review_status' IS DISTINCT FROM 'unverified' OR r->'mapped'->'card_ready' IS DISTINCT FROM 'false'::jsonb))
      OR (r->>'state'='quarantined' AND jsonb_array_length(r->'issues')=0)
      OR ((r->>'sheet'='除草剂汇总表' AND (r->>'excel_row')::integer>1) IS DISTINCT FROM (r->>'state'<>'context'))
      OR (r->>'state'<>'context' AND EXISTS(SELECT 1 FROM unnest(ARRAY['registration_number','dosage_form','concentration_text','unit_text','label_text','source_url']) k
        WHERE r->'mapped'->k IS DISTINCT FROM 'null'::jsonb))
      OR r->>'row_hash' IS DISTINCT FROM encode(staging_intake.digest(
        convert_to(staging_intake.python_json(r->'raw'),'UTF8'),'sha256'),'hex')
    THEN RAISE EXCEPTION USING ERRCODE='G0001',MESSAGE='INVALID_INTAKE_ROW'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (value->>'sheet',value->>'excel_row')) FROM jsonb_array_elements(p_payload->'rows'))<>n
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'quality'->'sheets') s
      WHERE jsonb_typeof(s->'name') IS DISTINCT FROM 'string' OR coalesce(s->>'name','')='' OR length(s->>'name')>255
      OR jsonb_typeof(s->'nonempty_rows') IS DISTINCT FROM 'number'
      OR coalesce(s->>'nonempty_rows','') !~ '^(0|[1-9][0-9]{0,4})$'
      OR (s->>'nonempty_rows')::integer<>(SELECT count(*) FROM jsonb_array_elements(p_payload->'rows') x WHERE x->>'sheet'=s->>'name'))
    OR (SELECT count(*) FROM jsonb_array_elements(p_payload->'quality'->'sheets'))
      <>(SELECT count(DISTINCT value->>'name') FROM jsonb_array_elements(p_payload->'quality'->'sheets'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'rows') x WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_payload->'quality'->'sheets') s WHERE s->>'name'=x->>'sheet'))
    OR p_payload->'rows' IS DISTINCT FROM (SELECT jsonb_agg(x ORDER BY s.ord,(x->>'excel_row')::integer)
      FROM jsonb_array_elements(p_payload->'rows') x JOIN jsonb_array_elements(p_payload->'quality'->'sheets') WITH ORDINALITY s(value,ord) ON s.value->>'name'=x->>'sheet')
    OR p_payload->'quality'->'data_rows' IS DISTINCT FROM to_jsonb((SELECT count(*)::integer FROM jsonb_array_elements(p_payload->'rows') x WHERE x->>'state'<>'context'))
  THEN RAISE EXCEPTION USING ERRCODE='G0001',MESSAGE='INCOMPLETE_OR_DUPLICATE_INTAKE'; END IF;
  payload:=p_payload-'extracted_at';
  ph:=encode(staging_intake.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex');
  rh:=encode(staging_intake.digest(convert_to(jsonb_build_object('action','import','payload_hash',ph,'previous_import_id',p_previous_import)::text,'UTF8'),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text,7007));
  SELECT * INTO prior FROM staging_intake.operations WHERE id=p_id;
  IF FOUND THEN
    IF prior.actor<>session_user OR prior.request_hash<>rh THEN RAISE EXCEPTION USING ERRCODE='G0005',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(bid::text,7008));
  SELECT * INTO owner_row FROM staging_intake.batches WHERE batch_id=bid FOR UPDATE;
  IF FOUND THEN
    IF owner_row.actor<>session_user OR owner_row.payload_hash<>ph OR owner_row.state<>'reverted'
      OR p_previous_import IS DISTINCT FROM owner_row.import_id
    THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='BATCH_CONFLICT'; END IF;
    gen:=owner_row.generation+1;
  ELSE
    IF p_previous_import IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='BATCH_CONFLICT'; END IF;
    gen:=1;
  END IF;
  -- Never adopt manual/legacy batches, or rows left by a conflicting operation.
  IF EXISTS(SELECT 1 FROM knowledge_staging.workbook_batches WHERE id=bid OR (file_sha256=file_hash AND mapping_version='herbicide-summary-v1'))
  THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='UNMANAGED_OR_EXISTING_BATCH'; END IF;
  INSERT INTO knowledge_staging.workbook_batches(id,file_sha256,filename,mapping_version,quality)
    VALUES(bid,file_hash,payload->>'filename','herbicide-summary-v1',payload->'quality');
  INSERT INTO knowledge_staging.workbook_rows(batch_id,sheet_name,excel_row,row_hash,raw,mapped,state,issues)
    SELECT bid,x->>'sheet',(x->>'excel_row')::integer,x->>'row_hash',x->'raw',x->'mapped',x->>'state',x->'issues'
    FROM jsonb_array_elements(payload->'rows') x;
  INSERT INTO staging_intake.batches(batch_id,actor,file_sha256,mapping_version,payload_hash,generation,import_id,state,row_count)
    VALUES(bid,session_user,file_hash,'herbicide-summary-v1',ph,gen,p_id,'imported',n)
    ON CONFLICT(batch_id) DO UPDATE SET generation=gen,import_id=p_id,state='imported';
  receipt:=jsonb_build_object('operation_id',p_id,'action','import','batch_id',bid,'generation',gen,
    'payload_hash',ph,'row_count',n,'state','imported','import_id',p_id,'replayed',false);
  INSERT INTO staging_intake.operations(id,batch_id,action,actor,request_hash,receipt)
    VALUES(p_id,bid,'import',session_user,rh,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION staging_intake.apply_import(uuid,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION staging_intake.rollback_import(p_id uuid,p_batch uuid,p_import uuid,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $$
DECLARE prior staging_intake.operations%ROWTYPE; owned staging_intake.batches%ROWTYPE;
  rh text; current_payload jsonb; actual_hash text; receipt jsonb;
BEGIN
  IF p_id IS NULL OR p_batch IS NULL OR p_import IS NULL OR coalesce(p_hash,'') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION USING ERRCODE='G0001',MESSAGE='INVALID_REQUEST'; END IF;
  rh:=encode(staging_intake.digest(convert_to(jsonb_build_object('action','rollback','batch_id',p_batch,'import_id',p_import,'payload_hash',p_hash)::text,'UTF8'),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text,7007));
  SELECT * INTO prior FROM staging_intake.operations WHERE id=p_id;
  IF FOUND THEN
    IF prior.actor<>session_user OR prior.request_hash<>rh THEN RAISE EXCEPTION USING ERRCODE='G0005',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
    RETURN prior.receipt||jsonb_build_object('replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_batch::text,7008));
  SELECT * INTO owned FROM staging_intake.batches WHERE batch_id=p_batch FOR UPDATE;
  IF NOT FOUND OR owned.actor<>session_user OR owned.payload_hash<>p_hash
    OR owned.import_id<>p_import OR owned.state<>'imported'
  THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='BATCH_CONFLICT'; END IF;
  -- Lock the exact batch and its rows before comparing the original canonical payload.
  PERFORM 1 FROM knowledge_staging.workbook_batches WHERE id=p_batch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='BATCH_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM knowledge_staging.workbook_batches WHERE id=p_batch AND source_version_id IS NOT NULL)
  THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='BATCH_LINK_CHANGED'; END IF;
  PERFORM 1 FROM knowledge_staging.workbook_rows WHERE batch_id=p_batch FOR UPDATE;
  SELECT jsonb_build_object('batch_id',b.id,'sha256',trim(b.file_sha256),'filename',b.filename,
    'mapping_version',b.mapping_version,'quality',b.quality,'rows',
    (SELECT jsonb_agg(jsonb_build_object('sheet',r.sheet_name,'excel_row',r.excel_row,'row_hash',trim(r.row_hash),
      'raw',r.raw,'mapped',r.mapped,'state',r.state,'issues',r.issues) ORDER BY s.ord,r.excel_row)
     FROM knowledge_staging.workbook_rows r
     JOIN jsonb_array_elements(b.quality->'sheets') WITH ORDINALITY s(value,ord) ON s.value->>'name'=r.sheet_name
     WHERE r.batch_id=b.id)) INTO current_payload FROM knowledge_staging.workbook_batches b WHERE id=p_batch;
  actual_hash:=encode(staging_intake.digest(convert_to(current_payload::text,'UTF8'),'sha256'),'hex');
  IF actual_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION USING ERRCODE='G0004',MESSAGE='BATCH_CONTENT_CHANGED'; END IF;
  DELETE FROM knowledge_staging.workbook_batches WHERE id=p_batch;
  UPDATE staging_intake.batches SET state='reverted' WHERE batch_id=p_batch;
  receipt:=jsonb_build_object('operation_id',p_id,'action','rollback','batch_id',p_batch,'generation',owned.generation,
    'payload_hash',p_hash,'row_count',owned.row_count,'state','reverted','import_id',p_import,'replayed',false);
  INSERT INTO staging_intake.operations(id,batch_id,action,actor,request_hash,receipt)
    VALUES(p_id,p_batch,'rollback',session_user,rh,receipt);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION staging_intake.rollback_import(uuid,uuid,uuid,text) FROM PUBLIC;
