-- =============================================================================
-- 006 - BM25 keyword search
-- =============================================================================
-- Under RLS, PostgreSQL cannot use the GIN index on chunks.tsv: the @@ operator
-- is not LEAKPROOF, so it may only be evaluated after the RLS filter. Because
-- the tables use FORCE ROW LEVEL SECURITY, that is true even for app_owner.
--
-- app.bm25_search() is therefore owned by app_search, a NOLOGIN role with
-- BYPASSRLS whose only table privilege is SELECT on app.chunks. Inside it,
-- isolation relies on the explicit filter `tenant_id = app.current_tenant_id()`
-- (no tenant set => NULL => no rows). It returns chunk ids and scores only;
-- titles and content are read afterwards through RLS by the caller.
--
-- Scoring is BM25 as in Lucene, with all statistics computed per tenant at
-- query time, so they are always exact and never influenced by other tenants:
--   score(D, Q) = sum over terms t of Q:
--     idf(t) * tf(t,D) * (k1 + 1) / (tf(t,D) + k1 * (1 - b + b * |D| / avgdl))
--   idf(t)    = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
--   k1 = 1.2, b = 0.75; |D| = chunks.token_count
-- A chunk matching ANY query term is a candidate (OR semantics); chunks that
-- match more terms, or rarer terms, score higher.
-- =============================================================================

GRANT USAGE ON SCHEMA app TO app_search;
GRANT SELECT ON app.chunks TO app_search;

CREATE FUNCTION app.bm25_search(p_query text, p_limit integer DEFAULT 10)
  RETURNS TABLE (chunk_id bigint, score double precision)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    WITH
    -- Query text -> OR of its lexemes, normalized exactly like chunks.tsv.
    -- plainto_tsquery ANDs the terms; its text form is safely quoted, so
    -- swapping the operators gives the OR query.
    query AS (
      SELECT replace(
               plainto_tsquery('app.vn_unaccent'::regconfig, normalize(p_query, NFC))::text,
               ' & ', ' | ')::tsquery AS tsq
    ),
    terms AS (
      SELECT DISTINCT lexeme AS term FROM unnest(app.search_tsv(p_query))
    ),
    -- N and average document length of the CURRENT tenant only.
    stats AS (
      SELECT count(*)::float8 AS n, avg(token_count)::float8 AS avgdl
        FROM app.chunks
       WHERE tenant_id = app.current_tenant_id()
    ),
    -- Uses the GIN index on tsv; the tenant filter is what isolates tenants here.
    candidates AS (
      SELECT c.id, c.token_count, c.tsv
        FROM app.chunks AS c, query
       WHERE c.tenant_id = app.current_tenant_id()
         AND c.tsv @@ query.tsq
    ),
    -- Frequency of each query term in each candidate.
    tf AS (
      SELECT cand.id, cand.token_count, t.lexeme AS term, cardinality(t.positions)::float8 AS tf
        FROM candidates AS cand, unnest(cand.tsv) AS t
       WHERE t.lexeme IN (SELECT term FROM terms)
    ),
    -- Every chunk containing a query term is a candidate, so df can be
    -- counted from the candidates.
    df AS (
      SELECT term, count(*)::float8 AS df FROM tf GROUP BY term
    )
    SELECT tf.id,
           sum(ln(1 + (s.n - df.df + 0.5) / (df.df + 0.5))
               * tf.tf * (1.2 + 1)
               / (tf.tf + 1.2 * (1 - 0.75 + 0.75 * tf.token_count / s.avgdl))) AS score
      FROM tf
      JOIN df USING (term)
     CROSS JOIN stats AS s
     GROUP BY tf.id
     ORDER BY score DESC, tf.id
     LIMIT least(greatest(p_limit, 1), 100)
  $$;

ALTER FUNCTION app.bm25_search(text, integer) OWNER TO app_search;

REVOKE EXECUTE ON FUNCTION app.bm25_search(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bm25_search(text, integer) TO app_user;
