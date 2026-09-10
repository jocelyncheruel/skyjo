BEGIN;

CREATE TABLE IF NOT EXISTS public.skyjo_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

REVOKE ALL ON TABLE public.skyjo_schema_migrations FROM PUBLIC, anon, authenticated;

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
  room_visibility TEXT NOT NULL DEFAULT 'private',
  outcome TEXT NOT NULL DEFAULT 'active',
  rounds_played INTEGER NOT NULL DEFAULT 0,
  final_score INTEGER,
  final_rank INTEGER,
  participant_count INTEGER,
  bot_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, game_serial, user_id),
  CONSTRAINT user_game_participations_player_unique UNIQUE (room_id, game_serial, player_id),
  CONSTRAINT user_game_participations_serial_check CHECK (game_serial > 0),
  CONSTRAINT user_game_participations_player_id_check CHECK (player_id ~ '^[A-Za-z0-9_-]{10,40}$'),
  CONSTRAINT user_game_participations_mode_check CHECK (game_mode IN ('classic', 'action')),
  CONSTRAINT user_game_participations_visibility_check CHECK (room_visibility IN ('private', 'public')),
  CONSTRAINT user_game_participations_outcome_check CHECK (outcome IN ('active', 'won', 'lost', 'draw', 'abandoned')),
  CONSTRAINT user_game_participations_rounds_check CHECK (rounds_played >= 0),
  CONSTRAINT user_game_participations_bot_count_check CHECK (
    bot_count >= 0 AND (participant_count IS NULL OR bot_count <= participant_count)
  )
);

CREATE TABLE IF NOT EXISTS public.game_decision_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id TEXT NOT NULL,
  game_serial BIGINT NOT NULL,
  round_number INTEGER NOT NULL,
  turn_serial BIGINT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  game_mode TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  decision_context JSONB NOT NULL,
  decision JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_decision_events_serial_check CHECK (game_serial > 0 AND turn_serial >= 0),
  CONSTRAINT game_decision_events_round_check CHECK (round_number > 0),
  CONSTRAINT game_decision_events_player_id_check CHECK (player_id ~ '^[A-Za-z0-9_-]{10,40}$'),
  CONSTRAINT game_decision_events_mode_check CHECK (game_mode IN ('classic', 'action')),
  CONSTRAINT game_decision_events_type_check CHECK (
    decision_type IN (
      'initial_flip', 'draw_source', 'drawn_card', 'place_card', 'reveal_card',
      'play_action', 'discard_action', 'resolve_action', 'resolve_defense',
      'resolve_group', 'claim_star_action'
    )
  ),
  CONSTRAINT game_decision_events_context_size_check CHECK (octet_length(decision_context::text) <= 32768),
  CONSTRAINT game_decision_events_decision_size_check CHECK (octet_length(decision::text) <= 4096)
);

CREATE INDEX IF NOT EXISTS game_decision_events_user_idx
  ON public.game_decision_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_decision_events_game_idx
  ON public.game_decision_events (room_id, game_serial, turn_serial);

CREATE TABLE IF NOT EXISTS public.social_profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_code TEXT NOT NULL UNIQUE DEFAULT UPPER(SUBSTRING(REPLACE(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 8)),
  display_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_profiles_friend_code_check CHECK (friend_code ~ '^[A-Z0-9]{8}$'),
  CONSTRAINT social_profiles_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 20)
);

ALTER TABLE public.social_profiles
  ADD COLUMN IF NOT EXISTS presence_status TEXT NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS show_presence BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_game BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS allow_friend_join BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS allow_friend_watch BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_quick_profile BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS friends_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS notify_game_invites BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.social_profiles'::regclass
      AND conname = 'social_profiles_presence_status_check'
  ) THEN
    ALTER TABLE public.social_profiles ADD CONSTRAINT social_profiles_presence_status_check
      CHECK (presence_status IN ('available', 'dnd'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.friendships (
  id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  requester_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  addressee_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (requester_user_id, addressee_user_id),
  CONSTRAINT friendships_distinct_users_check CHECK (requester_user_id <> addressee_user_id),
  CONSTRAINT friendships_status_check CHECK (status IN ('pending', 'accepted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS friendships_unique_pair_idx
  ON public.friendships (
    LEAST(requester_user_id, addressee_user_id),
    GREATEST(requester_user_id, addressee_user_id)
  );
CREATE INDEX IF NOT EXISTS friendships_addressee_idx
  ON public.friendships (addressee_user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.friend_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT friend_notifications_kind_check CHECK (kind IN ('friend_accepted')),
  CONSTRAINT friend_notifications_message_check CHECK (char_length(message) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS friend_notifications_user_idx
  ON public.friend_notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS public.friend_room_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id TEXT NOT NULL REFERENCES public.rooms(room_id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT friend_room_invitations_distinct_users_check CHECK (sender_user_id <> recipient_user_id),
  CONSTRAINT friend_room_invitations_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  CONSTRAINT friend_room_invitations_expiry_check CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS friend_room_invitations_pending_idx
  ON public.friend_room_invitations (room_id, sender_user_id, recipient_user_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS friend_room_invitations_recipient_idx
  ON public.friend_room_invitations (recipient_user_id, status, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.friend_online_notifications (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  friend_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_user_id),
  CONSTRAINT friend_online_notifications_distinct_users_check CHECK (user_id <> friend_user_id)
);

CREATE INDEX IF NOT EXISTS friend_online_notifications_friend_idx
  ON public.friend_online_notifications (friend_user_id, user_id);

CREATE TABLE IF NOT EXISTS public.web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT web_push_subscriptions_endpoint_check CHECK (
    endpoint ~ '^https://' AND char_length(endpoint) BETWEEN 16 AND 2048
  ),
  CONSTRAINT web_push_subscriptions_p256dh_check CHECK (char_length(p256dh) BETWEEN 40 AND 180),
  CONSTRAINT web_push_subscriptions_auth_check CHECK (char_length(auth) BETWEEN 16 AND 64)
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_user_idx
  ON public.web_push_subscriptions (user_id, updated_at DESC);

INSERT INTO public.skyjo_schema_migrations (version)
VALUES ('v9')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.skyjo_schema_migrations (version)
VALUES ('v7')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.skyjo_schema_migrations (version)
VALUES ('v8')
ON CONFLICT (version) DO NOTHING;

INSERT INTO public.skyjo_schema_migrations (version)
VALUES ('v6')
ON CONFLICT (version) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.skyjo_schema_migrations WHERE version = 'v5') THEN
    ALTER TABLE public.user_game_participations
      ADD COLUMN IF NOT EXISTS room_visibility TEXT NOT NULL DEFAULT 'private',
      ADD COLUMN IF NOT EXISTS final_rank INTEGER,
      ADD COLUMN IF NOT EXISTS participant_count INTEGER;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.user_game_participations'::regclass
        AND conname = 'user_game_participations_visibility_check'
    ) THEN
      ALTER TABLE public.user_game_participations
        ADD CONSTRAINT user_game_participations_visibility_check
        CHECK (room_visibility IN ('private', 'public'));
    END IF;

    DROP FUNCTION IF EXISTS public.skyjo_auth_account_exists(TEXT);
    DROP FUNCTION IF EXISTS public.commit_skyjo_room(
      TEXT, JSONB, BIGINT, SMALLINT, UUID, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, TEXT
    );

    INSERT INTO public.skyjo_schema_migrations (version) VALUES ('v5');
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.skyjo_schema_migrations WHERE version = 'v7') THEN
    ALTER TABLE public.user_game_participations
      ADD COLUMN IF NOT EXISTS bot_count INTEGER NOT NULL DEFAULT 0;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.user_game_participations'::regclass
        AND conname = 'user_game_participations_bot_count_check'
    ) THEN
      ALTER TABLE public.user_game_participations
        ADD CONSTRAINT user_game_participations_bot_count_check
        CHECK (bot_count >= 0 AND (participant_count IS NULL OR bot_count <= participant_count));
    END IF;

    INSERT INTO public.skyjo_schema_migrations (version) VALUES ('v7');
  END IF;
END;
$$;

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
ALTER TABLE public.game_decision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_decision_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.social_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships FORCE ROW LEVEL SECURITY;
ALTER TABLE public.friend_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.friend_room_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_room_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.friend_online_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_online_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE public.web_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_push_subscriptions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rooms FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.skyjo_schema_migrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_members FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.room_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.account_consents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.app_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_game_participations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.game_decision_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.social_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.friendships FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.friend_notifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.friend_room_invitations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.friend_online_notifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.web_push_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.game_decision_events_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rooms TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.room_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_consents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_game_participations TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.game_decision_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.social_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.friendships TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.friend_notifications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.friend_room_invitations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.friend_online_notifications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.web_push_subscriptions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.game_decision_events_id_seq TO service_role;

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
  v_existing_room_id TEXT;
BEGIN
  IF COALESCE(p_state_json ->> 'gameSerial', '') ~ '^[0-9]+$' THEN
    v_game_serial := (p_state_json ->> 'gameSerial')::BIGINT;
  END IF;
  IF COALESCE(p_state_json ->> 'completedRounds', '') ~ '^[0-9]+$' THEN
    v_rounds_played := (p_state_json ->> 'completedRounds')::INTEGER;
  END IF;

  IF p_expected_revision = -1 THEN
    IF p_owner_user_id IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_owner_user_id::TEXT, 0)
      );
      SELECT existing_room.room_id
      INTO v_existing_room_id
      FROM public.rooms AS existing_room
      INNER JOIN public.room_members AS existing_member
        ON existing_member.room_id = existing_room.room_id
        AND existing_member.user_id = p_owner_user_id
      WHERE existing_room.owner_user_id = p_owner_user_id
        AND existing_room.quarantined_at IS NULL
      ORDER BY existing_room.updated_at DESC
      LIMIT 1;
      IF v_existing_room_id IS NOT NULL THEN
        RAISE EXCEPTION 'active_room_exists' USING ERRCODE = 'P0001';
      END IF;
    END IF;

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
      room_id, game_serial, user_id, player_id, game_mode, room_visibility
    )
    SELECT p_room_id, v_game_serial, member.user_id, member.player_id,
      CASE WHEN p_game_mode = 'action' THEN 'action' ELSE 'classic' END,
      CASE WHEN p_visibility = 'public' THEN 'public' ELSE 'private' END
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

    WITH final_players AS (
      SELECT player.key AS player_id,
        (player.value ->> 'totalScore')::INTEGER AS final_score,
        COALESCE((player.value ->> 'isBot')::BOOLEAN, FALSE) AS is_bot
      FROM jsonb_each(COALESCE(p_state_json -> 'playersById', '{}'::JSONB)) AS player
      WHERE COALESCE(player.value ->> 'totalScore', '') ~ '^-?[0-9]+$'
    ), final_placements AS (
      SELECT ranked.player_id,
        RANK() OVER (ORDER BY ranked.final_score ASC) AS final_rank,
        COUNT(*) OVER () AS participant_count,
        COUNT(*) FILTER (WHERE ranked.is_bot) OVER () AS bot_count
      FROM final_players AS ranked
    )
    UPDATE public.user_game_participations AS participation
    SET final_rank = placements.final_rank,
        participant_count = placements.participant_count,
        bot_count = placements.bot_count
    FROM final_placements AS placements
    WHERE participation.room_id = p_room_id
      AND participation.game_serial = v_game_serial
      AND participation.player_id = placements.player_id;
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
  ON CONFLICT ON CONSTRAINT room_messages_pkey DO NOTHING;

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

DROP FUNCTION IF EXISTS public.get_skyjo_friend_quick_profiles(UUID);
DROP FUNCTION IF EXISTS public.get_skyjo_user_stats(UUID);
DROP FUNCTION IF EXISTS public.get_skyjo_leaderboard(INTEGER);
DROP FUNCTION IF EXISTS public.skyjo_placement_trophies(INTEGER, INTEGER);

CREATE FUNCTION public.skyjo_placement_trophies(p_rank INTEGER, p_player_count INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_player_count < 2 OR p_rank < 1 OR p_rank > p_player_count THEN 0
    WHEN p_player_count = 2 THEN CASE WHEN p_rank = 1 THEN 20 ELSE -5 END
    WHEN p_rank = CEIL(p_player_count / 2.0) THEN 0
    WHEN p_rank < CEIL(p_player_count / 2.0) THEN GREATEST(
      6,
      ROUND(20.0 * (CEIL(p_player_count / 2.0) - p_rank) / (CEIL(p_player_count / 2.0) - 1))::INTEGER
    )
    ELSE LEAST(
      -1,
      -ROUND(5.0 * (p_rank - CEIL(p_player_count / 2.0)) / (p_player_count - CEIL(p_player_count / 2.0)))::INTEGER
    )
  END;
$$;

CREATE FUNCTION public.get_skyjo_user_stats(
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
  last_game_at TIMESTAMPTZ,
  competitive_rating BIGINT,
  current_win_streak BIGINT,
  recent_games JSONB,
  usage_metrics JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ordered_results AS (
    SELECT participation.*,
      COUNT(*) FILTER (WHERE outcome <> 'won') OVER (
        PARTITION BY user_id ORDER BY COALESCE(finished_at, started_at), room_id, game_serial
      ) AS streak_group
    FROM public.user_game_participations AS participation
    WHERE user_id = p_user_id
  ), scored_results AS (
    SELECT ordered_results.*,
      CASE WHEN outcome = 'won' THEN COUNT(*) FILTER (WHERE outcome = 'won') OVER (
        PARTITION BY user_id, streak_group ORDER BY COALESCE(finished_at, started_at), room_id, game_serial
      ) ELSE 0 END AS win_streak
    FROM ordered_results
  ), rated_results AS (
    SELECT scored_results.*,
      CASE WHEN outcome = 'abandoned' THEN -8
        WHEN final_rank IS NULL OR participant_count IS NULL OR participant_count < 2 THEN 0
        ELSE public.skyjo_placement_trophies(final_rank, participant_count)
          + CASE WHEN final_rank = 1 THEN LEAST(GREATEST(win_streak - 1, 0), 5) ELSE 0 END
      END AS base_rating
    FROM scored_results
  )
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
    ) AS last_game_at,
    GREATEST(0, COALESCE(SUM(CASE
      WHEN base_rating > 0 AND bot_count > 0 THEN GREATEST(1, ROUND(
        base_rating * GREATEST(
          0.5,
          (participant_count - bot_count)::NUMERIC / NULLIF(participant_count, 0)
        )
      )::INTEGER)
      ELSE base_rating
    END), 0)) AS competitive_rating,
    COALESCE((ARRAY_AGG(win_streak ORDER BY COALESCE(finished_at, started_at) DESC, room_id DESC, game_serial DESC)
      FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')))[1], 0) AS current_win_streak,
    COALESCE((
      SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'outcome', recent.outcome,
        'mode', recent.game_mode
      ) ORDER BY recent.finished_at ASC)
      FROM (
        SELECT result.outcome, result.game_mode,
          COALESCE(result.finished_at, result.started_at) AS finished_at
        FROM scored_results AS result
        WHERE result.outcome IN ('won', 'lost', 'draw')
        ORDER BY COALESCE(result.finished_at, result.started_at) DESC,
          result.room_id DESC, result.game_serial DESC
        LIMIT 10
      ) AS recent
    ), '[]'::JSONB) AS recent_games,
    JSONB_BUILD_OBJECT(
      'last7', COUNT(*) FILTER (
        WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')
          AND COALESCE(finished_at, started_at) >= NOW() - INTERVAL '7 days'
      ),
      'last30', COUNT(*) FILTER (
        WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')
          AND COALESCE(finished_at, started_at) >= NOW() - INTERVAL '30 days'
      ),
      'activeDays30', COUNT(DISTINCT DATE(COALESCE(finished_at, started_at))) FILTER (
        WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')
          AND COALESCE(finished_at, started_at) >= NOW() - INTERVAL '30 days'
      ),
      'weekdays', JSONB_BUILD_ARRAY(
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 1),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 2),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 3),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 4),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 5),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 6),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(ISODOW FROM COALESCE(finished_at, started_at)) = 7)
      ),
      'periods', JSONB_BUILD_ARRAY(
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(HOUR FROM COALESCE(finished_at, started_at) AT TIME ZONE 'Europe/Paris') BETWEEN 5 AND 11),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(HOUR FROM COALESCE(finished_at, started_at) AT TIME ZONE 'Europe/Paris') BETWEEN 12 AND 17),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND EXTRACT(HOUR FROM COALESCE(finished_at, started_at) AT TIME ZONE 'Europe/Paris') BETWEEN 18 AND 22),
        COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned') AND (EXTRACT(HOUR FROM COALESCE(finished_at, started_at) AT TIME ZONE 'Europe/Paris') >= 23 OR EXTRACT(HOUR FROM COALESCE(finished_at, started_at) AT TIME ZONE 'Europe/Paris') < 5))
      )
    ) AS usage_metrics
  FROM rated_results;
$$;

CREATE OR REPLACE FUNCTION public.get_skyjo_friend_quick_profiles(p_user_id UUID)
RETURNS TABLE (
  user_id UUID,
  games_played BIGINT,
  games_won BIGINT,
  games_lost BIGINT,
  games_drawn BIGINT,
  games_abandoned BIGINT,
  games_in_progress BIGINT,
  classic_games BIGINT,
  rounds_played BIGINT,
  action_games BIGINT,
  best_score INTEGER,
  last_game_at TIMESTAMPTZ,
  competitive_rating BIGINT,
  current_win_streak BIGINT,
  recent_games JSONB,
  usage_metrics JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT friend.friend_user_id,
    stats.games_played, stats.games_won, stats.games_lost, stats.games_drawn,
    stats.games_abandoned, stats.games_in_progress, stats.classic_games,
    stats.rounds_played, stats.action_games, stats.best_score, stats.last_game_at,
    stats.competitive_rating, stats.current_win_streak, stats.recent_games,
    stats.usage_metrics
  FROM (
    SELECT CASE
      WHEN relation.requester_user_id = p_user_id THEN relation.addressee_user_id
      ELSE relation.requester_user_id
    END AS friend_user_id
    FROM public.friendships AS relation
    WHERE relation.status = 'accepted'
      AND (relation.requester_user_id = p_user_id OR relation.addressee_user_id = p_user_id)
    LIMIT 100
  ) AS friend
  INNER JOIN public.social_profiles AS profile
    ON profile.user_id = friend.friend_user_id AND profile.show_quick_profile = TRUE
  CROSS JOIN LATERAL public.get_skyjo_user_stats(friend.friend_user_id) AS stats;
$$;

CREATE FUNCTION public.get_skyjo_leaderboard(
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  rank_position BIGINT,
  user_id UUID,
  player_name TEXT,
  competitive_rating BIGINT,
  games_played BIGINT,
  games_won BIGINT,
  current_win_streak BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH ordered_results AS (
    SELECT participation.*,
      COUNT(*) FILTER (WHERE outcome <> 'won') OVER (
        PARTITION BY user_id ORDER BY COALESCE(finished_at, started_at), room_id, game_serial
      ) AS streak_group
    FROM public.user_game_participations AS participation
    WHERE participation.user_id IS NOT NULL
  ), scored_results AS (
    SELECT ordered_results.*,
      CASE WHEN outcome = 'won' THEN COUNT(*) FILTER (WHERE outcome = 'won') OVER (
        PARTITION BY user_id, streak_group ORDER BY COALESCE(finished_at, started_at), room_id, game_serial
      ) ELSE 0 END AS win_streak
    FROM ordered_results
  ), rated_results AS (
    SELECT scored_results.*,
      CASE WHEN outcome = 'abandoned' THEN -8
        WHEN final_rank IS NULL OR participant_count IS NULL OR participant_count < 2 THEN 0
        ELSE public.skyjo_placement_trophies(final_rank, participant_count)
          + CASE WHEN final_rank = 1 THEN LEAST(GREATEST(win_streak - 1, 0), 5) ELSE 0 END
      END AS base_rating
    FROM scored_results
  ), player_results AS (
    SELECT
      user_id,
      COUNT(*) FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')) AS games_played,
      COUNT(*) FILTER (WHERE outcome = 'won') AS games_won,
      GREATEST(0, COALESCE(SUM(CASE
        WHEN base_rating > 0 AND bot_count > 0 THEN GREATEST(1, ROUND(
          base_rating * GREATEST(
            0.5,
            (participant_count - bot_count)::NUMERIC / NULLIF(participant_count, 0)
          )
        )::INTEGER)
        ELSE base_rating
      END), 0)) AS rating,
      COALESCE((ARRAY_AGG(win_streak ORDER BY COALESCE(finished_at, started_at) DESC, room_id DESC, game_serial DESC)
        FILTER (WHERE outcome IN ('won', 'lost', 'draw', 'abandoned')))[1], 0) AS current_win_streak
    FROM rated_results
    GROUP BY user_id
  ), ranked AS (
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(results.rating, 0) DESC,
          CASE WHEN COALESCE(results.rating, 0) = 0
            THEN COALESCE(results.games_played, 0) END DESC,
          CASE WHEN COALESCE(results.rating, 0) = 0
            THEN COALESCE(results.games_won, 0) END DESC,
          COALESCE(results.games_won, 0) DESC,
          COALESCE(results.games_played, 0) ASC,
          user_account.created_at ASC,
          user_account.id
      ) AS rank_position,
      user_account.id AS user_id,
      LEFT(CASE COALESCE(user_account.raw_user_meta_data ->> 'leaderboard_name_format', 'first_initial')
        WHEN 'first_name' THEN COALESCE(NULLIF(user_account.raw_user_meta_data ->> 'first_name', ''), 'Joueur')
        WHEN 'first_initial' THEN CONCAT(
          COALESCE(NULLIF(user_account.raw_user_meta_data ->> 'first_name', ''), 'Joueur'),
          CASE WHEN NULLIF(user_account.raw_user_meta_data ->> 'last_name', '') IS NULL THEN ''
            ELSE CONCAT(' ', LEFT(user_account.raw_user_meta_data ->> 'last_name', 1), '.') END
        )
        WHEN 'full_name' THEN COALESCE(NULLIF(CONCAT_WS(' ',
          NULLIF(user_account.raw_user_meta_data ->> 'first_name', ''),
          NULLIF(user_account.raw_user_meta_data ->> 'last_name', '')
        ), ''), 'Joueur')
        ELSE COALESCE(
          NULLIF(user_account.raw_user_meta_data ->> 'player_name', ''),
          NULLIF(user_account.raw_user_meta_data ->> 'first_name', ''),
          'Joueur'
        )
      END, 20) AS player_name,
      COALESCE(results.rating, 0) AS competitive_rating,
      COALESCE(results.games_played, 0) AS games_played,
      COALESCE(results.games_won, 0) AS games_won,
      COALESCE(results.current_win_streak, 0) AS current_win_streak
    FROM auth.users AS user_account
    LEFT JOIN player_results AS results ON results.user_id = user_account.id
    WHERE COALESCE(user_account.raw_user_meta_data ->> 'leaderboard_visible', 'true') = 'true'
  )
  SELECT ranked.rank_position, ranked.user_id, ranked.player_name,
    ranked.competitive_rating, ranked.games_played, ranked.games_won, ranked.current_win_streak
  FROM ranked
  ORDER BY ranked.rank_position, ranked.user_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100);
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
REVOKE ALL ON FUNCTION public.get_skyjo_friend_quick_profiles(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_skyjo_leaderboard(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_stale_skyjo_rooms() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_expired_skyjo_app_sessions() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_skyjo_room(TEXT, JSONB, BIGINT, SMALLINT, UUID, TEXT, TEXT, TEXT, SMALLINT, TEXT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.append_skyjo_message(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_skyjo_session_active(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_skyjo_user_stats(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_skyjo_friend_quick_profiles(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_skyjo_leaderboard(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_stale_skyjo_rooms() TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_expired_skyjo_app_sessions() TO service_role;

COMMIT;
