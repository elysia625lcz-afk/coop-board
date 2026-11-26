-- Co-op 投递台：通用文档库（Claude 2026-11-26）
-- 和 Life OS 共用 Supabase 项目 life-os，表名都以 coop_ 开头，不碰 Life OS 的表。
-- 2026-11-26 已在 Supabase SQL Editor 运行成功。
-- 结构照搬 claude.ai artifact 数据库：collection / doc_id / data(jsonb) / version。
-- 网页用登录账号读写（RLS 只看自己的行）；其他 AI 用“AI 钥匙”调 coop_ai_* 函数，不需要密码。

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.coop_docs (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  collection text not null check (collection ~ '^[A-Za-z0-9_.-]{1,60}$'),
  doc_id     text not null check (length(doc_id) between 1 and 200),
  data       jsonb not null default '{}'::jsonb,
  version    integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'web',
  primary key (user_id, collection, doc_id)
);

alter table public.coop_docs enable row level security;
drop policy if exists own_rows on public.coop_docs;
create policy own_rows on public.coop_docs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select on public.coop_docs to authenticated;   -- 网页直接读；写一律走下面的函数（统一处理版本号）

-- AI 钥匙：只存哈希。一个账号可以有多把（每个 AI 一把，可以单独作废）。
create table if not exists public.coop_keys (
  key_hash   text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text not null default 'ai',
  created_at timestamptz not null default now(),
  last_used  timestamptz
);
alter table public.coop_keys enable row level security;
drop policy if exists own_rows on public.coop_keys;
create policy own_rows on public.coop_keys for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, delete on public.coop_keys to authenticated;

-- 改动日志：谁（网页 / 哪个 AI）在什么时候改了哪条。方便调试和撤销。
create table if not exists public.coop_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  at         timestamptz not null default now(),
  who        text not null,
  op         text not null,
  collection text not null,
  doc_id     text not null,
  old_data   jsonb,
  new_version integer
);
alter table public.coop_log enable row level security;
drop policy if exists own_rows on public.coop_log;
create policy own_rows on public.coop_log for select to authenticated using (user_id = auth.uid());
grant select on public.coop_log to authenticated;

-- ---------- 核心：一批写入（set / update / delete），全部成功或全部回滚 ----------
-- p_writes: [{op, collection, doc_id, data, if_version}]；update 是顶层字段合并，值为 null 的字段会被删掉。
create or replace function public.coop_apply(p_uid uuid, p_who text, p_writes jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare w jsonb; op text; c text; d text; cur public.coop_docs; nv integer; out jsonb := '[]'::jsonb; patch jsonb;
begin
  if p_uid is null then raise exception 'not signed in'; end if;
  if jsonb_typeof(p_writes) <> 'array' or jsonb_array_length(p_writes) = 0 then raise exception 'writes must be a non-empty array'; end if;
  if jsonb_array_length(p_writes) > 200 then raise exception 'at most 200 writes per call'; end if;
  for w in select * from jsonb_array_elements(p_writes) loop
    op := w->>'op'; c := w->>'collection'; d := coalesce(w->>'doc_id', encode(gen_random_bytes(10), 'hex'));
    if op not in ('set','update','delete') then raise exception 'bad op %', op; end if;
    cur := null;
    select * into cur from public.coop_docs where user_id = p_uid and collection = c and doc_id = d for update;
    if w ? 'if_version' and (cur.version is null or cur.version <> (w->>'if_version')::int) then
      raise exception 'version conflict on %/% (now %)', c, d, coalesce(cur.version::text, 'missing');
    end if;
    if op = 'delete' then
      delete from public.coop_docs where user_id = p_uid and collection = c and doc_id = d;
      nv := null;
    elsif op = 'set' or cur.doc_id is null then
      if op = 'update' and cur.doc_id is null then raise exception 'update of missing doc %/%', c, d; end if;
      insert into public.coop_docs(user_id, collection, doc_id, data, version, updated_by)
      values (p_uid, c, d, coalesce(w->'data', '{}'::jsonb), 1, p_who)
      on conflict (user_id, collection, doc_id) do update
        set data = excluded.data, version = public.coop_docs.version + 1, updated_at = now(), updated_by = p_who
      returning version into nv;
    else
      patch := coalesce(w->'data', '{}'::jsonb);
      update public.coop_docs
         set data = public.jsonb_strip_nulls_top(data || patch, patch), version = version + 1, updated_at = now(), updated_by = p_who
       where user_id = p_uid and collection = c and doc_id = d
      returning version into nv;
    end if;
    insert into public.coop_log(user_id, who, op, collection, doc_id, old_data, new_version)
    values (p_uid, p_who, op, c, d, cur.data, nv);
    out := out || jsonb_build_object('collection', c, 'doc_id', d, 'version', nv);
  end loop;
  return out;
end $$;

-- update 时：patch 里写成 null 的顶层字段从文档里删掉（和 artifact 的 draft:null 用法一致）
create or replace function public.jsonb_strip_nulls_top(merged jsonb, patch jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    from jsonb_each(merged) as e(k, v)
   where not (patch ? k and jsonb_typeof(patch->k) = 'null');
$$;

revoke all on function public.coop_apply(uuid, text, jsonb) from public, anon, authenticated;

-- 网页用（已登录）
create or replace function public.coop_web_write(p_writes jsonb)
returns jsonb language sql security definer set search_path = public as $$
  select public.coop_apply(auth.uid(), 'web', p_writes);
$$;
revoke all on function public.coop_web_write(jsonb) from public, anon;
grant execute on function public.coop_web_write(jsonb) to authenticated;

-- 网页里生成一把 AI 钥匙（只显示一次，库里只存哈希）
create or replace function public.coop_new_key(p_label text default 'ai')
returns text language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  k := 'coop_' || encode(gen_random_bytes(24), 'hex');
  insert into public.coop_keys(key_hash, user_id, label) values (encode(digest(k, 'sha256'), 'hex'), auth.uid(), left(coalesce(p_label,'ai'), 40));
  return k;
end $$;
revoke all on function public.coop_new_key(text) from public, anon;
grant execute on function public.coop_new_key(text) to authenticated;

-- ---------- 给任何 AI 用（匿名 + 钥匙，不需要密码） ----------
create or replace function public.coop_key_user(p_key text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid;
begin
  update public.coop_keys set last_used = now()
   where key_hash = encode(digest(coalesce(p_key,''), 'sha256'), 'hex')
  returning user_id into uid;
  if uid is null then raise exception 'bad key'; end if;
  return uid;
end $$;
revoke all on function public.coop_key_user(text) from public, anon, authenticated;

-- 读：不给 collection 就列出各集合的数量；给 collection 返回整个集合；再给 doc_id 返回一条
create or replace function public.coop_ai_read(p_key text, p_collection text default null, p_doc_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := public.coop_key_user(p_key);
begin
  if p_collection is null then
    return (select coalesce(jsonb_object_agg(collection, n), '{}'::jsonb)
              from (select collection, count(*) n from public.coop_docs where user_id = uid group by collection) s);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('collection', collection, 'doc_id', doc_id, 'version', version,
                                                       'updated_at', updated_at, 'updated_by', updated_by, 'data', data)
                                    order by doc_id), '[]'::jsonb)
            from public.coop_docs
           where user_id = uid and collection = p_collection and (p_doc_id is null or doc_id = p_doc_id));
end $$;

-- 写：p_who 写上自己是谁（claude / codex / gemini / muse ...），会记进日志
create or replace function public.coop_ai_write(p_key text, p_writes jsonb, p_who text default 'ai')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public.coop_apply(public.coop_key_user(p_key), 'ai:' || left(coalesce(p_who,'ai'), 30), p_writes);
end $$;

grant execute on function public.coop_ai_read(text, text, text) to anon, authenticated;
grant execute on function public.coop_ai_write(text, jsonb, text) to anon, authenticated;

-- 网页实时刷新
do $$ begin
  alter publication supabase_realtime add table public.coop_docs;
exception when duplicate_object then null; when undefined_object then null; end $$;
