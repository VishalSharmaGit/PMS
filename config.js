// Paste your Supabase values here (Project Settings -> API). The anon key is PUBLIC by design;
// the security comes from the database rules, not from hiding this key. NEVER paste the service_role key here.
window.PMS_CONFIG = {
  SUPABASE_URL: 'https://zrsicjrcucpejycfhnta.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_fT6qc3X0LawK5-rqZyN2NA_9pN0s2gt',
  WORKER_EMAIL_DOMAIN: 'pms-worker.com',   // must match the domain used in 02_accounts_and_grants.sql
  RECENT_DAYS: 45                          // dashboard/my-tasks load open tasks + this many recent days first
};
