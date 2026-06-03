do $$
begin
  create extension if not exists vector;
exception
  when others then
    raise notice 'pgvector extension is not available on this PostgreSQL server (%); JSON embedding fallback remains active.', sqlerrm;
end
$$;

do $$
begin
  if exists(select 1 from pg_extension where extname = 'vector') then
    alter table memories add column if not exists embedding_vector vector;
    alter table entities add column if not exists embedding_vector vector;
    alter table edges add column if not exists embedding_vector vector;

    begin
      create index if not exists memories_embedding_vector_hnsw_idx
        on memories using hnsw (embedding_vector vector_cosine_ops);
    exception
      when others then
        raise notice 'Could not create memories pgvector index: %', sqlerrm;
    end;

    begin
      create index if not exists entities_embedding_vector_hnsw_idx
        on entities using hnsw (embedding_vector vector_cosine_ops);
    exception
      when others then
        raise notice 'Could not create entities pgvector index: %', sqlerrm;
    end;

    begin
      create index if not exists edges_embedding_vector_hnsw_idx
        on edges using hnsw (embedding_vector vector_cosine_ops);
    exception
      when others then
        raise notice 'Could not create edges pgvector index: %', sqlerrm;
    end;
  end if;
end
$$;
