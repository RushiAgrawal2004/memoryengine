create extension if not exists vector;

alter table memories add column if not exists embedding_vector vector;
alter table entities add column if not exists embedding_vector vector;
alter table edges add column if not exists embedding_vector vector;
