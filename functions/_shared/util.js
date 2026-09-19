// Shared helpers, ported as-is from the old netlify/functions/api.mjs so the
// validation/business-rule behaviour does not drift during the rebuild.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export const cleanEmail = v => String(v || '').trim().toLowerCase();
export const num = v => Number(v || 0);
export const round = (v, d = 1) => Number(num(v).toFixed(d));
export const leadEmails = (env) =>
  new Set((env.PROGRAMME_LEAD_EMAILS || '').split(',').map(cleanEmail).filter(Boolean));
export const weeksBetween = (a, b) => Math.max(0, (new Date(b) - new Date(a)) / (7 * 86400000));
export const monthEnd = start => { const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };

export const CASE_STATUSES = new Set(['Allocated', 'Contact attempted', 'Booked', 'Intake', 'Active', 'Exit review', 'Exited']);
export const SUPERVISION_STATUSES = new Set(['Open', 'Reviewed', 'Closed']);
export const SUPERVISION_PRIORITIES = new Set(['Routine', 'Important', 'Risk / urgent']);
export const SESSION_TYPES = new Set(['First', 'Follow-up']);
export const GENDERS = new Set(['Female', 'Male', 'Other', 'Unknown']);
export const REFERRAL_STATUSES = new Set(['Allocated', 'Contact attempted', 'Contact made', 'Booked', 'Intake completed', 'Active', 'Awaiting feedback', 'Closed – completed', 'Closed – no contact', 'Reallocated']);
export const REFERRAL_PRIORITIES = new Set(['Routine', 'Priority', 'Urgent']);

export const dateValue = (value, label) => {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new HttpError(400, `${label} is invalid`);
  return text;
};

export const limited = (value, max, label, required = false) => {
  const text = String(value || '').trim();
  if (required && !text) throw new HttpError(400, `${label} is required`);
  if (text.length > max) throw new HttpError(400, `${label} is too long`);
  return text || null;
};

export function requireMethod(method, allowed) {
  if (!allowed.includes(method)) throw new HttpError(405, 'Method not allowed');
}

// Every Supabase call (via .from() or .rpc()) now goes over PostgREST/HTTP
// and returns a { data, error } shape instead of throwing. This unwraps
// that shape consistently, turning any Postgres/PostgREST error into an
// HttpError so it surfaces the same way a failed raw `sql` query used to.
export function unwrap({ data, error }) {
  if (error) throw new HttpError(500, error.message || 'Database error');
  return data;
}

export function requireSameOrigin(request) {
  if (['GET', 'HEAD'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).origin !== new URL(request.url).origin) throw new HttpError(403, 'Request origin is not allowed');
}
