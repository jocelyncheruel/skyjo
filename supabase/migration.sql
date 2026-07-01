CREATE TABLE IF NOT EXISTS public.rooms (
  room_id TEXT PRIMARY KEY,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rooms_updated_at_idx ON public.rooms (updated_at);

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rooms FROM PUBLIC;
REVOKE ALL ON TABLE public.rooms FROM anon;
REVOKE ALL ON TABLE public.rooms FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rooms TO service_role;
