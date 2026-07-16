import { createClient } from '@supabase/supabase-js';

export function buildSupabaseClient({ url, secretKey, clientFactory = createClient }) {
  if (typeof clientFactory !== 'function') throw new TypeError('clientFactory invalide');
  return clientFactory(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
