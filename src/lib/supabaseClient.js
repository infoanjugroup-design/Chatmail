import { createClient } from '@supabase/supabase-js';

// Fill these in Netlify env vars as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// (both are the PUBLIC url + anon/publishable key — safe for the client;
// never put a service_role/secret key here).
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Supabase JS stores the session in localStorage by default. For a
      // stricter httpOnly-cookie session model, pair this with a small
      // Netlify Function that mints/reads an httpOnly cookie around the
      // Supabase session token — flagged as a Phase 2 hardening step.
    },
  }
);
