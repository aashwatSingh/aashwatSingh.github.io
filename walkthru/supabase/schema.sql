-- Walkthru sync schema for Supabase (Postgres 15+).
-- Paste into the Supabase SQL editor and run once. Safe to run again; it only adds what's missing
-- and replaces the functions.
--
-- Access model (the prototype has no accounts):
--   * Sync key: a long random secret held by office staff. It reads and writes everything in its
--     space (properties, units, inspections, sealed submissions, photos).
--   * Unit token: printed in a door QR code. It can only add inspections and sealed submissions for
--     its own unit, upload photos, and read that unit's records and photos (with deposits and staff
--     decisions removed).
-- Neither secret is stored: only its SHA-256. The tables are closed to the public (anon) key by row
-- level security with no policies; everything goes through the security-definer functions below,
-- which check the secret first.

create table if not exists public.wt_spaces (
  space_hash text primary key check (space_hash ~ '^[0-9a-f]{64}$'),
  name text not null default '',
  created_at timestamptz not null default now()
);

create sequence if not exists public.wt_seq;

create table if not exists public.wt_docs (
  space_hash text not null references public.wt_spaces (space_hash) on delete cascade,
  kind text not null check (kind in ('property', 'unit', 'inspection', 'submission')),
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  unit_id text,
  property_id text,
  body jsonb not null,
  seq bigint not null,
  updated_at timestamptz not null default now(),
  primary key (space_hash, kind, id)
);
create index if not exists wt_docs_seq on public.wt_docs (space_hash, seq);
create index if not exists wt_docs_unit on public.wt_docs (space_hash, unit_id);

create table if not exists public.wt_photos (
  space_hash text not null references public.wt_spaces (space_hash) on delete cascade,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  type text not null check (type in ('image/jpeg', 'image/png', 'image/webp')),
  data bytea not null,
  created_at timestamptz not null default now(),
  primary key (space_hash, hash)
);

create table if not exists public.wt_unit_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  space_hash text not null references public.wt_spaces (space_hash) on delete cascade,
  unit_id text not null,
  created_at timestamptz not null default now()
);

alter table public.wt_spaces enable row level security;
alter table public.wt_docs enable row level security;
alter table public.wt_photos enable row level security;
alter table public.wt_unit_tokens enable row level security;
revoke all on public.wt_spaces, public.wt_docs, public.wt_photos, public.wt_unit_tokens from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.wt_spaces, public.wt_docs, public.wt_photos, public.wt_unit_tokens from anon';
    execute 'revoke all on sequence public.wt_seq from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.wt_spaces, public.wt_docs, public.wt_photos, public.wt_unit_tokens from authenticated';
    execute 'revoke all on sequence public.wt_seq from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------- helpers (not callable by clients)

create or replace function public.wt_digest(p text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- Resolve a sync key or unit token to (space_hash, unit_id). unit_id is null for a sync key.
create or replace function public.wt_resolve(p_secret text, out space_hash text, out unit_id text)
language plpgsql security definer set search_path = public as $$
declare
  h text;
begin
  if p_secret is null or length(p_secret) < 32 or length(p_secret) > 200 then
    raise exception 'Walkthru: that sync key or code is not valid.' using errcode = '28000';
  end if;
  h := wt_digest(p_secret);
  select s.space_hash into space_hash from wt_spaces s where s.space_hash = h;
  if found then
    unit_id := null;
    return;
  end if;
  select t.space_hash, t.unit_id into space_hash, unit_id from wt_unit_tokens t where t.token_hash = h;
  if not found then
    raise exception 'Walkthru: that sync key or code is not recognised.' using errcode = '28000';
  end if;
end $$;

-- The fields a unit token may see of a document.
create or replace function public.wt_redact(p_kind text, p_body jsonb) returns jsonb
language sql immutable as $$
  select case p_kind
    when 'unit' then p_body || jsonb_build_object('residents', coalesce((
      select jsonb_agg(jsonb_build_object('id', r->'id', 'name', r->'name', 'bedroom', r->'bedroom', 'depositCents', 0))
      from jsonb_array_elements(coalesce(p_body->'residents', '[]'::jsonb)) r), '[]'::jsonb))
    when 'inspection' then jsonb_build_object(
      'id', p_body->'id', 'unitId', p_body->'unitId', 'kind', p_body->'kind',
      'openedAt', p_body->'openedAt', 'lockAt', p_body->'lockAt', 'surrenderDate', null, 'forwarding', '{}'::jsonb,
      'review', jsonb_build_object('decisions', '{}'::jsonb, 'finalizedAt', null))
    when 'property' then p_body - 'demo'
    else p_body
  end
$$;

-- ---------------------------------------------------------------- client functions

-- Create a sync space for a new random key (the client makes the key). Idempotent.
create or replace function public.wt_create_space(p_key text, p_name text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_key is null or length(p_key) < 32 or length(p_key) > 200 then
    raise exception 'Walkthru: a sync key must be at least 32 characters.' using errcode = '22023';
  end if;
  insert into wt_spaces (space_hash, name) values (wt_digest(p_key), left(coalesce(p_name, ''), 80))
  on conflict (space_hash) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Register a door token for one unit (sync key only). The client makes the token.
create or replace function public.wt_add_unit_token(p_key text, p_unit_id text, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  select * into r from wt_resolve(p_key);
  if r.unit_id is not null then
    raise exception 'Walkthru: only the office sync key can make door codes.' using errcode = '42501';
  end if;
  if p_unit_id !~ '^[A-Za-z0-9_-]{1,40}$' or p_token is null or length(p_token) < 32 or length(p_token) > 200 then
    raise exception 'Walkthru: bad unit or door code.' using errcode = '22023';
  end if;
  insert into wt_unit_tokens (token_hash, space_hash, unit_id) values (wt_digest(p_token), r.space_hash, p_unit_id)
  on conflict (token_hash) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Upsert documents: [{ kind, id, body }]. Sealed submissions can be added but never changed.
-- With a unit token only that unit's inspections (add only) and sealed submissions are accepted.
-- Returns { ok, saved, skipped: [{ kind, id, reason }] }.
create or replace function public.wt_push(p_secret text, p_docs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  d jsonb;
  k text;
  i text;
  b jsonb;
  doc_unit text;
  doc_prop text;
  old jsonb;
  saved int := 0;
  skipped jsonb := '[]'::jsonb;
begin
  select * into r from wt_resolve(p_secret);
  if jsonb_typeof(p_docs) <> 'array' or jsonb_array_length(p_docs) > 500 then
    raise exception 'Walkthru: send at most 500 documents at a time.' using errcode = '22023';
  end if;
  for d in select * from jsonb_array_elements(p_docs) loop
    k := d->>'kind';
    i := d->>'id';
    b := d->'body';
    if k is null or k not in ('property', 'unit', 'inspection', 'submission') or i is null or i !~ '^[A-Za-z0-9_-]{1,40}$'
       or jsonb_typeof(b) <> 'object' or b->>'id' is distinct from i or octet_length(b::text) > 2000000 then
      skipped := skipped || jsonb_build_object('kind', k, 'id', i, 'reason', 'malformed');
      continue;
    end if;
    doc_unit := case k when 'unit' then i when 'property' then null else b->>'unitId' end;
    doc_prop := case k when 'property' then i when 'unit' then b->>'propertyId' else null end;

    if r.unit_id is not null and (k not in ('inspection', 'submission') or doc_unit is distinct from r.unit_id) then
      skipped := skipped || jsonb_build_object('kind', k, 'id', i, 'reason', 'not allowed with a door code');
      continue;
    end if;
    if k = 'submission' and (b->>'seal' is null or b->>'seal' !~ '^[0-9a-f]{64}$') then
      skipped := skipped || jsonb_build_object('kind', k, 'id', i, 'reason', 'not sealed');
      continue;
    end if;

    select body into old from wt_docs where space_hash = r.space_hash and kind = k and id = i;
    if found then
      if k = 'submission' then
        if old->>'seal' is distinct from b->>'seal' then
          skipped := skipped || jsonb_build_object('kind', k, 'id', i, 'reason', 'a different sealed record has this id');
        end if;
        continue; -- same seal: already stored
      end if;
      if r.unit_id is not null then
        continue; -- door codes may add an inspection, never change one
      end if;
      if old = b then
        continue;
      end if;
      update wt_docs set body = b, unit_id = doc_unit, property_id = coalesce(doc_prop, property_id),
        seq = nextval('wt_seq'), updated_at = now()
      where space_hash = r.space_hash and kind = k and id = i;
    else
      insert into wt_docs (space_hash, kind, id, unit_id, property_id, body, seq)
      values (r.space_hash, k, i, doc_unit, doc_prop, b, nextval('wt_seq'));
    end if;
    saved := saved + 1;
  end loop;
  return jsonb_build_object('ok', true, 'saved', saved, 'skipped', skipped);
end $$;

-- Documents changed after `p_since` (a sequence number), oldest first, at most 300 per call.
-- Returns { docs: [{ kind, id, body, seq }], last, more }.
create or replace function public.wt_pull(p_secret text, p_since bigint default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  prop text;
  out_docs jsonb;
  last_seq bigint;
  more boolean;
begin
  select * into r from wt_resolve(p_secret);
  if r.unit_id is not null then
    select body->>'propertyId' into prop from wt_docs where space_hash = r.space_hash and kind = 'unit' and id = r.unit_id;
  end if;
  with picked as (
    select kind, id, body, seq from wt_docs
    where space_hash = r.space_hash and seq > coalesce(p_since, 0)
      and (r.unit_id is null or unit_id = r.unit_id or (kind = 'property' and id = prop))
    order by seq
    limit 301
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'kind', kind, 'id', id, 'seq', seq,
      'body', case when r.unit_id is null then body else wt_redact(kind, body) end) order by seq)
      filter (where rn <= 300), '[]'::jsonb),
    max(seq) filter (where rn <= 300),
    count(*) > 300
  into out_docs, last_seq, more
  from (select *, row_number() over (order by seq) rn from picked) x;
  return jsonb_build_object('docs', out_docs, 'last', coalesce(last_seq, p_since, 0), 'more', more);
end $$;

-- Which of these photo hashes the server doesn't have yet.
create or replace function public.wt_missing_photos(p_secret text, p_hashes text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  select * into r from wt_resolve(p_secret);
  if array_length(p_hashes, 1) > 1000 then
    raise exception 'Walkthru: ask about at most 1000 photos at a time.' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(h) from unnest(p_hashes) h
    where not exists (select 1 from wt_photos p where p.space_hash = r.space_hash and p.hash = h)
  ), '[]'::jsonb);
end $$;

-- Store a photo. The server recomputes its SHA-256 and refuses it if it doesn't match the name.
create or replace function public.wt_put_photo(p_secret text, p_hash text, p_type text, p_b64 text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  bytes bytea;
begin
  select * into r from wt_resolve(p_secret);
  if p_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Walkthru: photos must be JPEG, PNG or WebP.' using errcode = '22023';
  end if;
  if length(p_b64) > 8000000 then
    raise exception 'Walkthru: that photo is too large.' using errcode = '22023';
  end if;
  bytes := decode(p_b64, 'base64');
  if encode(sha256(bytes), 'hex') <> p_hash then
    raise exception 'Walkthru: the photo does not match its fingerprint.' using errcode = '22023';
  end if;
  insert into wt_photos (space_hash, hash, type, data) values (r.space_hash, p_hash, p_type, bytes)
  on conflict (space_hash, hash) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Fetch a photo as { type, b64 }. A door code only gets photos used by its own unit's records.
create or replace function public.wt_get_photo(p_secret text, p_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record;
  ph record;
begin
  select * into r from wt_resolve(p_secret);
  if r.unit_id is not null and not exists (
    select 1 from wt_docs
    where space_hash = r.space_hash and kind = 'submission' and unit_id = r.unit_id
      and body->'entries' @> jsonb_build_array(jsonb_build_object('photo', jsonb_build_object('hash', p_hash)))
  ) then
    raise exception 'Walkthru: that photo is not part of this unit.' using errcode = '42501';
  end if;
  select type, data into ph from wt_photos where space_hash = r.space_hash and hash = p_hash;
  if not found then
    return null;
  end if;
  return jsonb_build_object('type', ph.type, 'b64', encode(ph.data, 'base64'));
end $$;

-- Only the client functions are callable from the web page. New functions are executable by
-- everyone by default (and Supabase grants anon and authenticated too), so the helpers are revoked
-- explicitly. Nothing outside the wt_ functions is touched.
do $$
declare
  fn text;
  who text;
begin
  foreach fn in array array['wt_digest(text)', 'wt_resolve(text)', 'wt_redact(text, jsonb)'] loop
    execute format('revoke execute on function public.%s from public', fn);
    foreach who in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = who) then
        execute format('revoke execute on function public.%s from %I', fn, who);
      end if;
    end loop;
  end loop;
  foreach fn in array array[
    'wt_create_space(text, text)', 'wt_add_unit_token(text, text, text)', 'wt_push(text, jsonb)',
    'wt_pull(text, bigint)', 'wt_missing_photos(text, text[])', 'wt_put_photo(text, text, text, text)',
    'wt_get_photo(text, text)'
  ] loop
    execute format('grant execute on function public.%s to public', fn);
  end loop;
end $$;
