-- =====================================================================
-- CHATMAIL — Supabase schema (PostgreSQL)
-- Run once in the Supabase SQL Editor on a fresh project.
-- =====================================================================
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text,
  avatar_url text,
  bio text,
  status_text text,               -- "VibeSync" text status (WhatsApp-style)
  mood_media_url text,            -- "VibeSync" active mood-ring media (Instagram-style)
  mood_expires_at timestamptz,
  mfa_enabled boolean not null default false,
  public_key text,                -- client's Web Crypto public key (for envelope encryption)
  created_at timestamptz not null default now()
);

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, username, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text,1,8)),
          new.raw_user_meta_data->>'display_name')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and username = 'admin'); -- swap for a real role column in production
$$;

-- ---------------------------------------------------------------------
-- CHATS (1:1 and group)
-- ---------------------------------------------------------------------
create table if not exists chats (
  id uuid primary key default gen_random_uuid(),
  is_group boolean not null default false,
  title text,                      -- group name (null for 1:1)
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists chat_members (
  chat_id uuid not null references chats(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (chat_id, user_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  -- envelope-encrypted body: ciphertext + iv, produced client-side via Web
  -- Crypto (see src/lib/crypto.js). Server never sees plaintext for DMs.
  ciphertext text,
  iv text,
  plaintext text,                  -- used only for group chats / non-E2E flows; null for encrypted DMs
  media_url text,
  media_type text check (media_type in ('image','video','audio','voice_note','file')),
  reply_to uuid references messages(id),
  is_pinned boolean not null default false,   -- "pinned memory capsules"
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
create index if not exists messages_chat_idx on messages(chat_id, created_at);

create table if not exists message_receipts (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (message_id, user_id)
);

-- Envelope encryption: the AES data key for a given message, wrapped
-- (RSA-OAEP encrypted) separately for each recipient with their own
-- public key. See src/lib/crypto.js for the client-side scheme.
create table if not exists message_keys (
  message_id uuid not null references messages(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  wrapped_key text not null,
  primary key (message_id, recipient_id)
);

create table if not exists typing_status (
  chat_id uuid not null references chats(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  is_typing boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

-- ---------------------------------------------------------------------
-- STORIES (24h disappearing)
-- ---------------------------------------------------------------------
create table if not exists stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image','video')),
  caption text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists stories_expiry_idx on stories(expires_at);

create table if not exists story_views (
  story_id uuid not null references stories(id) on delete cascade,
  viewer_id uuid not null references profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

-- ---------------------------------------------------------------------
-- FEED: posts, likes, comments (nested)
-- ---------------------------------------------------------------------
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  caption text,
  media_url text,
  media_type text check (media_type in ('image','video')),
  -- "Truth & Morals First": educational/factual content gets a manual or
  -- moderation-assigned quality weight that feed ranking multiplies by.
  quality_weight numeric not null default 1.0 check (quality_weight between 0 and 3),
  is_flagged boolean not null default false,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists post_likes (
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  parent_comment_id uuid references comments(id) on delete cascade, -- nesting
  body text not null,
  is_flagged boolean not null default false,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);

-- Feed ranking helper: recency decay x engagement x quality_weight.
-- "Truth & Morals First" = quality_weight multiplies the score, so a
-- factual/educational post (weight 2-3) consistently outranks a purely
-- viral but low-quality one (weight 1) at equal engagement.
create or replace function feed_rank_score(p_post posts)
returns numeric language sql stable as $$
  select (
    coalesce((select count(*) from post_likes where post_id = p_post.id), 0) * 1.0
    + coalesce((select count(*) from comments where post_id = p_post.id and not is_hidden), 0) * 1.5
  ) * p_post.quality_weight
    / power(extract(epoch from (now() - p_post.created_at)) / 3600 + 2, 1.4); -- time decay
$$;

-- Convenience view: posts pre-sorted by the "Truth & Morals First" ranking.
create or replace view posts_ranked as
  select p.*,
         (select count(*) from post_likes l where l.post_id = p.id) as like_count,
         (select count(*) from comments c where c.post_id = p.id and not c.is_hidden) as comment_count,
         feed_rank_score(p) as score
  from posts p
  where p.is_hidden = false
  order by feed_rank_score(p) desc;

-- ---------------------------------------------------------------------
-- MODERATION
-- ---------------------------------------------------------------------
create table if not exists blocked_terms (
  term text primary key,
  severity text not null default 'block' check (severity in ('flag','block')),
  added_at timestamptz not null default now()
);

create table if not exists moderation_queue (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('post','comment','message')),
  content_id uuid not null,
  reason text,
  matched_terms text[],
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table profiles enable row level security;
alter table chats enable row level security;
alter table chat_members enable row level security;
alter table messages enable row level security;
alter table message_receipts enable row level security;
alter table message_keys enable row level security;
alter table typing_status enable row level security;
alter table stories enable row level security;
alter table story_views enable row level security;
alter table posts enable row level security;
alter table post_likes enable row level security;
alter table comments enable row level security;
alter table blocked_terms enable row level security;
alter table moderation_queue enable row level security;

-- profiles: public read (usernames/avatars), self-write
drop policy if exists "profiles_read" on profiles;
create policy "profiles_read" on profiles for select using (true);
drop policy if exists "profiles_self_write" on profiles;
create policy "profiles_self_write" on profiles for update using (id = auth.uid());

-- chats/members: only members can see or act on their own chats
drop policy if exists "chats_member_read" on chats;
create policy "chats_member_read" on chats for select using (
  exists (select 1 from chat_members m where m.chat_id = id and m.user_id = auth.uid())
);
drop policy if exists "chats_create" on chats;
create policy "chats_create" on chats for insert with check (created_by = auth.uid());

drop policy if exists "chat_members_read" on chat_members;
create policy "chat_members_read" on chat_members for select using (
  exists (select 1 from chat_members m2 where m2.chat_id = chat_id and m2.user_id = auth.uid())
);
drop policy if exists "chat_members_insert" on chat_members;
create policy "chat_members_insert" on chat_members for insert with check (
  user_id = auth.uid() or exists (select 1 from chats c where c.id = chat_id and c.created_by = auth.uid())
);

-- messages: only chat members can read/write; sender must be self
drop policy if exists "messages_read" on messages;
create policy "messages_read" on messages for select using (
  exists (select 1 from chat_members m where m.chat_id = messages.chat_id and m.user_id = auth.uid())
);
drop policy if exists "messages_insert" on messages;
create policy "messages_insert" on messages for insert with check (
  sender_id = auth.uid()
  and exists (select 1 from chat_members m where m.chat_id = messages.chat_id and m.user_id = auth.uid())
);
drop policy if exists "messages_update_own" on messages;
create policy "messages_update_own" on messages for update using (sender_id = auth.uid());

drop policy if exists "receipts_rw" on message_receipts;
create policy "receipts_rw" on message_receipts for all using (
  user_id = auth.uid() or exists (
    select 1 from messages msg join chat_members m on m.chat_id = msg.chat_id
    where msg.id = message_id and m.user_id = auth.uid()
  )
) with check (user_id = auth.uid());

drop policy if exists "message_keys_rw" on message_keys;
create policy "message_keys_rw" on message_keys for all using (
  recipient_id = auth.uid() or exists (
    select 1 from messages msg where msg.id = message_id and msg.sender_id = auth.uid()
  )
) with check (
  recipient_id = auth.uid() or exists (
    select 1 from messages msg where msg.id = message_id and msg.sender_id = auth.uid()
  )
);

drop policy if exists "typing_rw" on typing_status;
create policy "typing_rw" on typing_status for all using (
  exists (select 1 from chat_members m where m.chat_id = typing_status.chat_id and m.user_id = auth.uid())
) with check (user_id = auth.uid());

-- stories: readable by anyone (public feed) while not expired; owner writes
drop policy if exists "stories_read" on stories;
create policy "stories_read" on stories for select using (expires_at > now());
drop policy if exists "stories_write" on stories;
create policy "stories_write" on stories for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "story_views_rw" on story_views;
create policy "story_views_rw" on story_views for all using (true) with check (viewer_id = auth.uid());

-- posts/likes/comments: public read (unless hidden by moderation), owner writes
drop policy if exists "posts_read" on posts;
create policy "posts_read" on posts for select using (is_hidden = false or user_id = auth.uid() or is_admin());
drop policy if exists "posts_write" on posts;
create policy "posts_write" on posts for insert with check (user_id = auth.uid());
drop policy if exists "posts_update_own" on posts;
create policy "posts_update_own" on posts for update using (user_id = auth.uid() or is_admin());

drop policy if exists "post_likes_rw" on post_likes;
create policy "post_likes_rw" on post_likes for all using (true) with check (user_id = auth.uid());

drop policy if exists "comments_read" on comments;
create policy "comments_read" on comments for select using (is_hidden = false or user_id = auth.uid() or is_admin());
drop policy if exists "comments_write" on comments;
create policy "comments_write" on comments for insert with check (user_id = auth.uid());

-- moderation: admin-only
drop policy if exists "blocked_terms_read" on blocked_terms;
create policy "blocked_terms_read" on blocked_terms for select using (is_admin());
drop policy if exists "blocked_terms_write" on blocked_terms;
create policy "blocked_terms_write" on blocked_terms for all using (is_admin()) with check (is_admin());

drop policy if exists "moderation_queue_admin" on moderation_queue;
create policy "moderation_queue_admin" on moderation_queue for all using (is_admin()) with check (is_admin());

-- =====================================================================
-- REALTIME
-- =====================================================================
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table typing_status;
alter publication supabase_realtime add table message_receipts;
alter publication supabase_realtime add table stories;

-- =====================================================================
-- STORAGE BUCKETS
-- =====================================================================
insert into storage.buckets (id, name, public) values ('media', 'media', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;

drop policy if exists "media_public_read" on storage.objects;
create policy "media_public_read" on storage.objects for select using (bucket_id in ('media','avatars'));
drop policy if exists "media_owner_write" on storage.objects;
create policy "media_owner_write" on storage.objects for insert with check (
  bucket_id in ('media','avatars') and owner = auth.uid()
);

-- Seed a starter block-list — extend this generously in production, and/or
-- route through the moderate-content Edge Function for smarter checks.
insert into blocked_terms (term, severity) values
  ('__example_slur_placeholder__', 'block')
on conflict (term) do nothing;
