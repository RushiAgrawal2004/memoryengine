create extension if not exists vector;

alter table memories add column if not exists embedding_vector vector;
alter table entities add column if not exists embedding_vector vector;
alter table edges add column if not exists embedding_vector vector;

create index if not exists memories_embedding_vector_hnsw_idx
  on memories using hnsw (embedding_vector vector_cosine_ops);

create index if not exists entities_embedding_vector_hnsw_idx
  on entities using hnsw (embedding_vector vector_cosine_ops);

create index if not exists edges_embedding_vector_hnsw_idx
  on edges using hnsw (embedding_vector vector_cosine_ops);
