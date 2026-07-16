BEGIN;

CREATE TABLE IF NOT EXISTS public.skyjo_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE public.skyjo_schema_migrations FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.skyjo_schema_migrations WHERE version = 'v2'
  ) THEN
    IF to_regclass('public.rooms') IS NOT NULL THEN
      TRUNCATE TABLE public.rooms CASCADE;
    END IF;
    INSERT INTO public.skyjo_schema_migrations (version)
    VALUES ('v2');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.rooms (
  room_id TEXT PRIMARY KEY,
  state_json JSONB NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  state_revision BIGINT NOT NULL DEFAULT 0,
  state_schema_version SMALLINT NOT NULL DEFAULT 2,
  visibility TEXT NOT NULL DEFAULT 'private',
  phase TEXT NOT NULL DEFAULT 'lobby',
  game_mode TEXT NOT NULL DEFAULT 'classic',
  player_count SMALLINT NOT NULL DEFAULT 0,
  creator_name TEXT NOT NULL DEFAULT '',
  quarantined_at TIMESTAMPTZ,
  quarantine_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rooms_visibility_check CHECK (visibility IN ('private', 'public')),
  CONSTRAINT rooms_player_count_check CHECK (player_count BETWEEN 0 AND 8),
  CONSTRAINT rooms_state_size_check CHECK (octet_length(state_json::text) <= 2097152),
  CONSTRAINT rooms_schema_version_check CHECK (state_schema_version = 2),
  CONSTRAINT rooms_id_check CHECK (room_id ~ '^[A-Za-z0-9_-]{16}$')
);

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS state_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS state_schema_version SMALLINT NOT NULL DEFAULT 2;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'lobby';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS game_mode TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS player_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS creator_name TEXT NOT NULL DEFAULT '';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;
ALTER TABLE public.rooms ALTER COLUMN state_schema_version SET DEFAULT 2;
ALTER TABLE public.rooms ALTER COLUMN state_schema_version SET NOT NULL;

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_id_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_id_check
  CHECK (room_id ~ '^[A-Za-z0-9_-]{16}$');
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_schema_version_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_schema_version_check
  CHECK (state_schema_version = 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_visibility_check') THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_visibility_check CHECK (visibility IN ('private', 'public'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_player_count_check') THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_player_count_check CHECK (player_count BETWEEN 0 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_state_size_check') THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_state_size_check CHECK (octet_length(state_json::text) <= 2097152);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS rooms_updated_at_idx ON public.rooms (updated_at);
CREATE INDEX IF NOT EXISTS rooms_public_idx
  ON public.rooms (visibility, phase, updated_at DESC)
  WHERE visibility = 'public' AND phase = 'lobby';

CREATE TABLE IF NOT EXISTS public.room_members (
  room_id TEXT NOT NULL REFERENCES public.rooms(room_id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, player_id),
  CONSTRAINT room_members_one_seat_per_user UNIQUE (room_id, user_id),
  CONSTRAINT room_members_player_id_check CHECK (player_id ~ '^[A-Za-z0-9_-]{10,40}$')
);

CREATE INDEX IF NOT EXISTS room_members_user_idx ON public.room_members (user_id, room_id);

CREATE TABLE IF NOT EXISTS public.room_messages (
  room_id TEXT NOT NULL REFERENCES public.rooms(room_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, message_id),
  CONSTRAINT room_messages_id_check CHECK (message_id ~ '^[A-Za-z0-9_-]{10,80}$'),
  CONSTRAINT room_messages_player_id_check CHECK (player_id ~ '^[A-Za-z0-9_-]{10,40}$'),
  CONSTRAINT room_messages_player_name_check CHECK (char_length(player_name) BETWEEN 1 AND 20),
  CONSTRAINT room_messages_body_check CHECK (
    char_length(body) BETWEEN 1 AND 280 AND octet_length(body) <= 1120
  )
);

CREATE INDEX IF NOT EXISTS room_messages_history_idx
  ON public.room_messages (room_id, sent_at DESC, message_id DESC);

CREATE TABLE IF NOT EXISTS public.account_consents (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider TEXT NOT NULL DEFAULT 'unknown',
  CONSTRAINT account_consents_version_check CHECK (
    char_length(terms_version) BETWEEN 1 AND 32
    AND char_length(privacy_version) BETWEEN 1 AND 32
  )
);

CREATE TABLE IF NOT EXISTS public.app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_session TEXT NOT NULL,
  access_expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  remember BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_sessions_token_hash_check CHECK (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT app_sessions_encrypted_size_check CHECK (octet_length(encrypted_session) BETWEEN 80 AND 16384),
  CONSTRAINT app_sessions_expiry_check CHECK (
    access_expires_at <= absolute_expires_at
    AND idle_expires_at <= absolute_expires_at
    AND created_at < absolute_expires_at
  )
);

CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON public.app_sessions (user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx
  ON public.app_sessions (LEAST(idle_expires_at, absolute_expires_at));

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.skyjo_schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skyjo_schema_migrations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.room_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.account_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_consents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_sessions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rooms FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skyjo_schema_migrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.account_consents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.app_sessions FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rooms TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_consents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_sessions TO service_role;

DROP FUNCTION IF EXISTS public.commit_skyjo_room(
  TEXT, JSONB, BIGINT, SMALLINT, UUID, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, TEXT
);
CREATE OR REPLACE FUNCTION public.commit_skyjo_room(
  p_room_id TEXT,
  p_state_json JSONB,
  p_expected_revision BIGINT,
  p_schema_version SMALLINT,
  p_owner_user_id UUID,
  p_visibility TEXT,
  p_phase TEXT,
  p_game_mode TEXT,
  p_player_count SMALLINT,
  p_creator_name TEXT,
  p_member_user_id UUID DEFAULT NULL,
  p_member_player_id TEXT DEFAULT NULL,
  p_remove_member_player_id TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_revision BIGINT;
BEGIN
  IF p_expected_revision = -1 THEN
    INSERT INTO public.rooms (
      room_id, state_json, owner_user_id, state_revision, state_schema_version,
      visibility, phase, game_mode, player_count, creator_name, updated_at
    ) VALUES (
      p_room_id, p_state_json, p_owner_user_id, 0, p_schema_version,
      p_visibility, p_phase, p_game_mode, p_player_count, p_creator_name, NOW()
    )
    RETURNING state_revision INTO v_revision;
  ELSE
    UPDATE public.rooms
    SET state_json = p_state_json,
        owner_user_id = COALESCE(p_owner_user_id, owner_user_id),
        state_revision = state_revision + 1,
        state_schema_version = p_schema_version,
        visibility = p_visibility,
        phase = p_phase,
        game_mode = p_game_mode,
        player_count = p_player_count,
        creator_name = p_creator_name,
        quarantined_at = NULL,
        quarantine_reason = NULL,
        updated_at = NOW()
    WHERE room_id = p_room_id AND state_revision = p_expected_revision
    RETURNING state_revision INTO v_revision;

    IF v_revision IS NULL THEN
      RAISE EXCEPTION 'room_revision_conflict' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF p_member_user_id IS NOT NULL OR p_member_player_id IS NOT NULL THEN
    IF p_member_user_id IS NULL OR p_member_player_id IS NULL THEN
      RAISE EXCEPTION 'invalid_room_member' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.room_members (room_id, player_id, user_id)
    VALUES (p_room_id, p_member_player_id, p_member_user_id);
  END IF;

  IF p_remove_member_player_id IS NOT NULL THEN
    DELETE FROM public.room_members
    WHERE room_id = p_room_id AND player_id = p_remove_member_player_id;
  END IF;

  RETURN v_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.append_skyjo_message(
  p_room_id TEXT,
  p_message_id TEXT,
  p_player_id TEXT,
  p_player_name TEXT,
  p_body TEXT,
  p_sent_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  room_id TEXT,
  message_id TEXT,
  player_id TEXT,
  player_name TEXT,
  body TEXT,
  sent_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.room_messages (
    room_id, message_id, player_id, player_name, body, sent_at
  ) VALUES (
    p_room_id, p_message_id, p_player_id, p_player_name, p_body, p_sent_at
  )
  ON CONFLICT (room_id, message_id) DO NOTHING;

  UPDATE public.rooms SET updated_at = NOW() WHERE public.rooms.room_id = p_room_id;

  RETURN QUERY
    SELECT m.room_id, m.message_id, m.player_id, m.player_name, m.body, m.sent_at
    FROM public.room_messages AS m
    WHERE m.room_id = p_room_id AND m.message_id = p_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_skyjo_session_active(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.sessions AS s
    WHERE s.id = p_session_id AND s.user_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.delete_stale_skyjo_rooms()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  DELETE FROM public.rooms WHERE updated_at < NOW() - INTERVAL '24 hours';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_expired_skyjo_app_sessions()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count BIGINT;
BEGIN
  DELETE FROM public.app_sessions
  WHERE idle_expires_at <= NOW() OR absolute_expires_at <= NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_skyjo_room(TEXT, JSONB, BIGINT, SMALLINT, UUID, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.append_skyjo_message(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_skyjo_session_active(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_stale_skyjo_rooms() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_expired_skyjo_app_sessions() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_skyjo_room(TEXT, JSONB, BIGINT, SMALLINT, UUID, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_skyjo_message(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_skyjo_session_active(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_stale_skyjo_rooms() TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_expired_skyjo_app_sessions() TO service_role;

COMMIT;
