-- =============================================================================
-- 001 - Extensions (run as superuser)
-- =============================================================================
--   vector   : vector type + HNSW index (pgvector)
--   unaccent : strips Vietnamese diacritics so "hoc sinh" matches "học sinh"
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;
