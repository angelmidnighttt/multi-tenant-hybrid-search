-- =============================================================================
-- 003 - Schema: tables, helper functions, indexes
-- =============================================================================
-- Model: shared tables, every data table has a tenant_id column, isolation is
-- enforced by RLS (see 004_rls.sql).
--
-- Mandatory conventions for every tenant-owned table:
--   * tenant_id is the first column of the PRIMARY KEY -> the table can later be
--     partitioned by tenant.
--   * Every UNIQUE constraint includes tenant_id -> duplicate-key errors never
--     reveal another tenant's data.
--   * Foreign keys use the (tenant_id, id) pair -> a row cannot reference another
--     tenant's row (foreign key checks BYPASS RLS, so only a composite key
--     prevents this).
-- =============================================================================

CREATE SCHEMA app AUTHORIZATION app_owner;
SET ROLE app_owner;

-- -----------------------------------------------------------------------------
-- Tenant context
-- -----------------------------------------------------------------------------
-- The application sets it in EVERY transaction (never with a session-level SET,
-- because connections are pooled):
--   BEGIN;
--   SELECT set_config('app.tenant_id', '<uuid>', true);   -- true = transaction-local
--   ...
--   COMMIT;
-- Not set, or the empty string left over from a previous transaction => NULL
-- => RLS returns 0 rows. A non-uuid value => cast error => the query fails.
-- Both cases "fail closed".
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- -----------------------------------------------------------------------------
-- Vietnamese full-text search
-- -----------------------------------------------------------------------------
-- Postgres has no Vietnamese dictionary: split on whitespace (simple) + strip
-- diacritics. Only tokens containing non-ASCII characters (word, hword,
-- hword_part) need to go through unaccent.
CREATE TEXT SEARCH CONFIGURATION app.vn_unaccent (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION app.vn_unaccent
  ALTER MAPPING FOR word, hword, hword_part WITH public.unaccent, pg_catalog.simple;

-- Text -> tsvector. Normalize to NFC first so NFD text (combining diacritics) is
-- not chopped up by the parser. Used both at index time and at query time.
-- NOTE: changing this function/configuration requires recomputing the tsv column
-- of existing rows.
CREATE FUNCTION app.search_tsv(text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT pg_catalog.to_tsvector('app.vn_unaccent'::regconfig, pg_catalog.normalize($1, 'NFC')) $$;

-- Total number of tokens (counting repeats) in a tsvector = document length |d|
-- in BM25.
CREATE FUNCTION app.tsv_length(tsvector) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT coalesce(sum(cardinality(positions)), 0)::int FROM pg_catalog.unnest($1) $$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------
CREATE TABLE app.tenants (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- documents: source documents
-- -----------------------------------------------------------------------------
CREATE TABLE app.documents (
  tenant_id   uuid        NOT NULL DEFAULT app.current_tenant_id()
                          REFERENCES app.tenants (id) ON DELETE CASCADE,
  id          bigint      GENERATED ALWAYS AS IDENTITY,
  external_id text,                                   -- id in the source system (optional)
  title       text        NOT NULL,
  source_uri  text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, external_id)
);

CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON app.documents
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- chunks: the unit of search. BM25 and vector search both rank chunks, so the
-- results of the two branches can be fused (RRF) on the same key.
-- -----------------------------------------------------------------------------
CREATE TABLE app.chunks (
  tenant_id       uuid        NOT NULL DEFAULT app.current_tenant_id(),
  id              bigint      GENERATED ALWAYS AS IDENTITY,
  document_id     bigint      NOT NULL,
  chunk_index     integer     NOT NULL CHECK (chunk_index >= 0),
  content         text        NOT NULL,               -- original text, for display
  search_text     text,                               -- word-segmented text for BM25; NULL => use content
  tsv             tsvector    GENERATED ALWAYS AS
                    (app.search_tsv(coalesce(search_text, content))) STORED,
  token_count     integer     GENERATED ALWAYS AS
                    (app.tsv_length(app.search_tsv(coalesce(search_text, content)))) STORED,
  embedding       vector(1024),                       -- 1024 = bge-m3; NULL until the worker fills it in
  embedding_model text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_id, chunk_index),       -- also serves as the index for the FK below
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES app.documents (tenant_id, id) ON DELETE CASCADE,
  CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);

-- GIN index for full-text search. Under RLS the planner CANNOT use this index
-- (the @@ operator is not leakproof), so BM25 queries will go through a
-- SECURITY DEFINER function in a later step.
CREATE INDEX chunks_tsv_gin ON app.chunks USING gin (tsv);

-- Table-wide HNSW index (cosine). Tenant filtering is a post-filter -> recall is
-- handled in the vector search step.
CREATE INDEX chunks_embedding_hnsw ON app.chunks USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- BM25 statistics computed separately for EACH tenant (IDF and average document
-- length are not influenced by other tenants' data). Refreshed in batches in the
-- BM25 step.
-- -----------------------------------------------------------------------------
CREATE TABLE app.bm25_tenant_stats (
  tenant_id    uuid        PRIMARY KEY DEFAULT app.current_tenant_id()
                           REFERENCES app.tenants (id) ON DELETE CASCADE,
  chunk_count  bigint      NOT NULL DEFAULT 0,        -- N
  total_tokens bigint      NOT NULL DEFAULT 0,        -- avgdl = total_tokens / chunk_count
  refreshed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.bm25_term_stats (
  tenant_id uuid    NOT NULL DEFAULT app.current_tenant_id()
                    REFERENCES app.tenants (id) ON DELETE CASCADE,
  term      text    NOT NULL,                         -- lexeme as produced by app.search_tsv
  doc_freq  integer NOT NULL CHECK (doc_freq > 0),    -- number of the tenant's chunks containing the term
  PRIMARY KEY (tenant_id, term)
);
