// Public runtime config — filled in once per deploy. The anon key is safe to
// ship to the browser: it can only reach Supabase Auth endpoints here, since
// every table has Row Level Security enabled with no permissive policies
// (see supabase/migrations/0001_init.sql), so it cannot read or write data
// directly even if someone inspects it.
window.__SUPABASE_URL__ = 'https://YOUR-PROJECT-REF.supabase.co';
window.__SUPABASE_ANON_KEY__ = 'YOUR-ANON-PUBLIC-KEY';
