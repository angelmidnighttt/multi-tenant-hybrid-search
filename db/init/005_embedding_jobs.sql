-- =============================================================================
-- 005 - Embedding job queue
-- =============================================================================
-- POST /documents enqueues one job per document; the worker (npm run worker)
-- claims jobs, embeds the document's chunks and finishes the job.
--
-- This is the ONLY tenant-related table without RLS. Instead, no role has any
-- privilege on it: it is reachable solely through the SECURITY DEFINER
-- functions below. Only claim_embedding_jobs() crosses tenants, and it returns
-- identifiers only (tenant_id, document_id), never content. Every other
-- function acts on the current tenant (app.tenant_id) only.
-- =============================================================================
SET ROLE app_owner;

CREATE TABLE app.embedding_jobs (
  tenant_id    uuid        NOT NULL,
  document_id  bigint      NOT NULL,
  -- Bumped every time the document is re-ingested. finish/fail only act on
  -- the generation they claimed, so a re-ingest during processing is never lost.
  generation   integer     NOT NULL DEFAULT 1,
  attempts     integer     NOT NULL DEFAULT 0,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,                     -- lease held by a worker
  last_error   text,
  failed_at    timestamptz,                     -- set after the last attempt fails
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES app.documents (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX embedding_jobs_ready ON app.embedding_jobs (run_after) WHERE failed_at IS NULL;

-- Called by the API inside a tenant transaction. The tenant comes from
-- app.tenant_id, and the composite foreign key only accepts the current
-- tenant's own documents.
CREATE FUNCTION app.enqueue_embedding_job(p_document_id bigint) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    INSERT INTO app.embedding_jobs (tenant_id, document_id)
    VALUES (app.current_tenant_id(), p_document_id)
    ON CONFLICT (tenant_id, document_id) DO UPDATE
      SET generation   = app.embedding_jobs.generation + 1,
          attempts     = 0,
          run_after    = now(),
          locked_until = NULL,
          last_error   = NULL,
          failed_at    = NULL
  $$;

-- Called by the worker WITHOUT a tenant. Leases up to p_limit ready jobs
-- across all tenants. SKIP LOCKED lets several workers run side by side.
-- A job gets at most 5 attempts (a crashed worker also uses one up).
CREATE FUNCTION app.claim_embedding_jobs(p_limit integer, p_lease interval)
  RETURNS TABLE (tenant_id uuid, document_id bigint, generation integer)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    UPDATE app.embedding_jobs AS j
       SET locked_until = now() + p_lease,
           attempts     = j.attempts + 1
      FROM (SELECT q.tenant_id, q.document_id
              FROM app.embedding_jobs AS q
             WHERE q.failed_at IS NULL
               AND q.attempts < 5
               AND q.run_after <= now()
               AND (q.locked_until IS NULL OR q.locked_until < now())
             ORDER BY q.run_after
             LIMIT p_limit
             FOR UPDATE SKIP LOCKED) AS ready
     WHERE j.tenant_id = ready.tenant_id AND j.document_id = ready.document_id
    RETURNING j.tenant_id, j.document_id, j.generation
  $$;

-- Called by the worker inside the job's tenant transaction, after it has
-- written the embeddings. Returns false when the document was re-ingested
-- meanwhile (the job stays queued for the new chunks).
CREATE FUNCTION app.finish_embedding_job(p_document_id bigint, p_generation integer) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    WITH finished AS (
      DELETE FROM app.embedding_jobs
       WHERE tenant_id = app.current_tenant_id()
         AND document_id = p_document_id
         AND generation = p_generation
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM finished)
  $$;

-- Called by the worker inside the job's tenant transaction when processing
-- fails. Retries back off exponentially: 30s, 1m, 2m, 4m; the 5th failure is final.
CREATE FUNCTION app.fail_embedding_job(p_document_id bigint, p_generation integer, p_error text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    UPDATE app.embedding_jobs
       SET last_error   = left(p_error, 1000),
           locked_until = NULL,
           run_after    = now() + make_interval(secs => 30 * power(2, attempts - 1)),
           failed_at    = CASE WHEN attempts >= 5 THEN now() END
     WHERE tenant_id = app.current_tenant_id()
       AND document_id = p_document_id
       AND generation = p_generation
  $$;

-- -----------------------------------------------------------------------------
-- Privileges: functions are executable by PUBLIC by default, so revoke first.
-- The worker uses app_user as well (one role keeps the setup simple).
-- -----------------------------------------------------------------------------
REVOKE ALL ON app.embedding_jobs FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  app.enqueue_embedding_job(bigint),
  app.claim_embedding_jobs(integer, interval),
  app.finish_embedding_job(bigint, integer),
  app.fail_embedding_job(bigint, integer, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.enqueue_embedding_job(bigint),
  app.claim_embedding_jobs(integer, interval),
  app.finish_embedding_job(bigint, integer),
  app.fail_embedding_job(bigint, integer, text)
TO app_user;
