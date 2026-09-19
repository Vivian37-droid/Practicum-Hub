// Public runtime config — filled in once per deploy. The anon key is safe to
// ship to the browser: it can only reach Supabase Auth endpoints here, since
// every table has Row Level Security enabled with no permissive policies
// (see supabase/migrations/0001_init.sql), so it cannot read or write data
// directly even if someone inspects it.
window.__SUPABASE_URL__ = 'https://zegszyahpkwmgujbdwoo.supabase.co';
window.__SUPABASE_ANON_KEY__ = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InplZ3N6eWFocGt3bWd1amJkd29vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NjM4MTgsImV4cCI6MjEwNTMzOTgxOH0.i4O0n1YodkPuTf_Uiy7e_Tak3hgTCoxsS9zEABxBwy4';
