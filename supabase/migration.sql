BEGIN;

CREATE TABLE IF NOT EXISTS public.skyjo_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE public.skyjo_schema_migrations FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.skyjo_schema_migrations WHERE version = 'v4'
  ) THEN
    IF to_regclass('public.rooms') IS NOT NULL THEN
      TRUNCATE TABLE public.rooms CASCADE;
    END IF;
    INSERT INTO public.skyjo_schema_migrations (version)
    VALUES ('v4');
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.rooms (
  room_id TEXT PRIMARY KEY,
  state_json JSONB NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  state_revision BIGINT NOT NULL DEFAULT 0,
  state_schema_version SMALLINT NOT NULL DEFAULT 3,
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
  CONSTRAINT rooms_schema_version_check CHECK (state_schema_version = 3),
  CONSTRAINT rooms_id_check CHECK (room_id ~ '^[0-9]{6}$')
);

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS state_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS state_schema_version SMALLINT NOT NULL DEFAULT 3;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'lobby';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS game_mode TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS player_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS creator_name TEXT NOT NULL DEFAULT '';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;
ALTER TABLE public.rooms ALTER COLUMN state_schema_version SET DEFAULT 3;

DELETE FROM public.rooms
WHERE state_schema_version IS DISTINCT FROM 3
   OR room_id !~ '^[0-9]{6}$';

ALTER TABLE public.rooms ALTER COLUMN state_schema_version SET NOT NULL;

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_id_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_id_check
  CHECK (room_id ~ '^[0-9]{6}$');
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_schema_version_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_schema_version_check
  CHECK (state_schema_version = 3);

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

CREATE TABLE IF NOT EXISTS public.user_game_participations (
  room_id TEXT NOT NULL,
  game_serial BIGINT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  game_mode TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'active',
  rounds_played INTEGER NOT NULL DEFAULT 0,
  final_score INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, game_serial, user_id),
  CONSTRAINT user_game_participations_player_unique UNIQUE (room_id, game_serial, player_id),
  CONSTRAINT user_game_participations_serial_check CHECK (game_serial > 0),
  CONSTRAINT user_game_participations_player_id_check CHECK (player_id ~ '^[A-Za-z0-9_-]{10,40}$'),
  CONSTRAINT user_game_participations_mode_check CHECK (game_mode IN ('classic', 'action')),
  CONSTRAINT user_game_participations_outcome_check CHECK (outcome IN ('active', 'won', 'lost', 'draw', 'abandoned')),
  CONSTRAINT user_game_participations_rounds_check CHECK (rounds_played >= 0)
);

ALTER TABLE public.user_game_participations
  DROP CONSTRAINT IF EXISTS user_game_participations_outcome_check;
ALTER TABLE public.user_game_participations
  ADD CONSTRAINT user_game_participations_outcome_check
  CHECK (outcome IN ('active', 'won', 'lost', 'draw', 'abandoned'));

CREATE INDEX IF NOT EXISTS user_game_participations_user_idx
  ON public.user_game_participations (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS user_game_participations_active_idx
  ON public.user_game_participations (room_id, game_serial)
  WHERE outcome = 'active';

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
ALTER TABLE public.user_game_participations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_game_participations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rooms FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skyjo_schema_migrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.account_consents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.app_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_game_participations FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rooms TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_consents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_game_participations TO service_role;

DROP FUNCTION IF EXISTS public.skyjo_auth_account_exists(TEXT);
CREATE OR REPLACE FUNCTION public.skyjo_auth_account_exists(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    WHERE LOWER(auth_user.email) = LOWER(BTRIM(p_email))
  );
$$;

REVOKE ALL ON FUNCTION public.skyjo_auth_account_exists(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.skyjo_auth_account_exists(TEXT)
  TO service_role;

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
  v_previous_state JSONB;
  v_previous_phase TEXT;
  v_previous_game_serial BIGINT := 0;
  v_game_serial BIGINT := 0;
  v_rounds_played INTEGER := 0;
BEGIN
  IF COALESCE(p_state_json ->> 'gameSerial', '') ~ '^[0-9]+$' THEN
    v_game_serial := (p_state_json ->> 'gameSerial')::BIGINT;
  END IF;
  IF COALESCE(p_state_json ->> 'completedRounds', '') ~ '^[0-9]+$' THEN
    v_rounds_played := (p_state_json ->> 'completedRounds')::INTEGER;
  END IF;

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
    SELECT state_json
    INTO v_previous_state
    FROM public.rooms
    WHERE room_id = p_room_id AND state_revision = p_expected_revision
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'room_revision_conflict' USING ERRCODE = '40001';
    END IF;

    v_previous_phase := COALESCE(v_previous_state ->> 'phase', 'lobby');
    IF COALESCE(v_previous_state ->> 'gameSerial', '') ~ '^[0-9]+$' THEN
      v_previous_game_serial := (v_previous_state ->> 'gameSerial')::BIGINT;
    END IF;

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
    WHERE room_id = p_room_id
    RETURNING state_revision INTO v_revision;
  END IF;

  IF p_member_user_id IS NOT NULL OR p_member_player_id IS NOT NULL THEN
    IF p_member_user_id IS NULL OR p_member_player_id IS NULL THEN
      RAISE EXCEPTION 'invalid_room_member' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.room_members (room_id, player_id, user_id)
    VALUES (p_room_id, p_member_player_id, p_member_user_id);
  END IF;

  IF v_game_serial > 0 AND p_phase <> 'lobby' THEN
    INSERT INTO public.user_game_participations (
      room_id, game_serial, user_id, player_id, game_mode
    )
    SELECT p_room_id, v_game_serial, member.user_id, member.player_id,
      CASE WHEN p_game_mode = 'action' THEN 'action' ELSE 'classic' END
    FROM public.room_members AS member
    WHERE member.room_id = p_room_id
    ON CONFLICT (room_id, game_serial, user_id) DO NOTHING;
  END IF;

  IF p_remove_member_player_id IS NOT NULL THEN
    IF v_previous_phase NOT IN ('lobby', 'gameEnd')
      AND v_previous_game_serial > 0 THEN
      UPDATE public.user_game_participations AS participation
      SET outcome = 'abandoned',
          rounds_played = GREATEST(
            participation.rounds_played,
            CASE
              WHEN COALESCE(v_previous_state ->> 'completedRounds', '') ~ '^[0-9]+$'
                THEN (v_previous_state ->> 'completedRounds')::INTEGER
              ELSE 0
            END
          ),
          final_score = CASE
            WHEN COALESCE(
              v_previous_state #>> ARRAY['playersById', p_remove_member_player_id, 'totalScore'],
              ''
            ) ~ '^-?[0-9]+$'
              THEN (v_previous_state #>> ARRAY['playersById', p_remove_member_player_id, 'totalScore'])::INTEGER
            ELSE participation.final_score
          END,
          finished_at = COALESCE(participation.finished_at, NOW())
      WHERE participation.room_id = p_room_id
        AND participation.game_serial = v_previous_game_serial
        AND participation.player_id = p_remove_member_player_id
        AND participation.outcome = 'active';
    END IF;

    DELETE FROM public.room_members
    WHERE room_id = p_room_id AND player_id = p_remove_member_player_id;
  END IF;

  IF p_phase = 'gameEnd' AND v_game_serial > 0 THEN
    UPDATE public.user_game_participations AS participation
    SET outcome = CASE
          WHEN participation.outcome <> 'active' THEN participation.outcome
          WHEN jsonb_typeof(p_state_json -> 'winnerIds') = 'array'
            AND (p_state_json -> 'winnerIds') ? participation.player_id
            AND (p_state_json -> 'winnerIds') <> jsonb_build_array(participation.player_id)
            THEN 'draw'
          WHEN participation.player_id = p_state_json ->> 'winnerId' THEN 'won'
          ELSE 'lost'
        END,
        rounds_played = GREATEST(participation.rounds_played, v_rounds_played),
        final_score = CASE
          WHEN COALESCE(
            p_state_json #>> ARRAY['playersById', participation.player_id, 'totalScore'],
            ''
          ) ~ '^-?[0-9]+$'
            THEN (p_state_json #>> ARRAY['playersById', participation.player_id, 'totalScore'])::INTEGER
          ELSE participation.final_score
        END,
        finished_at = COALESCE(participation.finished_at, NOW())
    WHERE participation.room_id = p_room_id
      AND participation.game_serial = v_game_serial;
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

DROP FUNCTION IF EXISTS public.get_skyjo_user_stats(UUID);

CREATE OR REPLACE FUNCTION public.get_skyjo_user_stats(
  p_user_id UUID
)
RETURNS TABLE (
  games_played BIGINT,
  games_won BIGINT,
  games_lost BIGINT,
  games_drawn BIGINT,
  games_abandoned BIGINT,
  games_in_progress BIGINT,
  classic_games BIGINT,
  action_games BIGINT,
  rounds_played BIGINT,
  best_score INTEGER,
  last_game_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')) AS games_played,
    COUNT(*) FILTER (WHERE outcome = 'won') AS games_won,
    COUNT(*) FILTER (WHERE outcome = 'lost') AS games_lost,
    COUNT(*) FILTER (WHERE outcome = 'draw') AS games_drawn,
    COUNT(*) FILTER (WHERE outcome = 'abandoned') AS games_abandoned,
    COUNT(*) FILTER (WHERE outcome = 'active') AS games_in_progress,
    COUNT(*) FILTER (
      WHERE game_mode = 'classic' AND outcome IN ('won', 'lost', 'draw', 'abandoned')
    ) AS classic_games,
    COUNT(*) FILTER (
      WHERE game_mode = 'action' AND outcome IN ('won', 'lost', 'draw', 'abandoned')
    ) AS action_games,
    COALESCE(SUM(rounds_played) FILTER (
      WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')
    ), 0) AS rounds_played,
    MIN(final_score) FILTER (WHERE outcome IN ('won', 'lost', 'draw')) AS best_score,
    MAX(COALESCE(finished_at, started_at)) FILTER (
      WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')
    ) AS last_game_at
  FROM public.user_game_participations
  WHERE user_id = p_user_id;
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
  UPDATE public.user_game_participations AS participation
  SET outcome = 'abandoned',
      finished_at = COALESCE(participation.finished_at, NOW())
  WHERE participation.outcome = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.rooms AS room
      WHERE room.room_id = participation.room_id
        AND room.updated_at < NOW() - INTERVAL '24 hours'
    );

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
REVOKE ALL ON FUNCTION public.get_skyjo_user_stats(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_stale_skyjo_rooms() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_expired_skyjo_app_sessions() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_skyjo_room(TEXT, JSONB, BIGINT, SMALLINT, UUID, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_skyjo_message(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_skyjo_session_active(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_skyjo_user_stats(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_stale_skyjo_rooms() TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_expired_skyjo_app_sessions() TO service_role;

COMMIT;
