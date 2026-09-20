// Auth/role/authorization logic. Ported from the old netlify/functions/api.mjs,
// with @netlify/identity's getUser() replaced by verifying the Supabase Auth
// access token the frontend sends in the Authorization header, and — as of
// the PostgREST migration — all database access going through supabase-js's
// .from()/.rpc() builders (HTTP) instead of raw `sql` tagged-template queries
// (TCP), which were unreliable from this Cloudflare Pages Functions runtime.

import { HttpError, cleanEmail, leadEmails, num, unwrap } from './util.js';
import { getAdmin } from './clients.js';

async function getAuthUser(request, env) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const admin = getAdmin(env);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user; // { id, email, user_metadata, app_metadata, ... }
}

export async function context(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) throw new HttpError(401, 'Please sign in');
  const admin = getAdmin(env);
  const email = cleanEmail(user.email);

  const metadataRoles = user.app_metadata?.roles || user.user_metadata?.roles || [];
  const role = leadEmails(env).has(email)
    ? 'programme_lead'
    : (['programme_lead', 'supervisor', 'management', 'intern'].find(r => metadataRoles.includes(r)) || 'intern');

  const profile = unwrap(await admin.rpc('app_context_upsert', {
    p_identity_user_id: user.id,
    p_email: email,
    p_default_display_name: user.user_metadata?.display_name || email.split('@')[0],
    p_role: role
  }));

  // Prompt 4: deactivating an intern (soft-delete, profiles.active = false)
  // must actually cut off their access, not just hide them from lists — an
  // intern whose placement was removed can still hold a valid Supabase Auth
  // session otherwise.
  if (role === 'intern' && profile.active === false) {
    throw new HttpError(403, 'This placement has been deactivated. Contact your programme lead.');
  }

  return { user, profile, role };
}

export function requireRole(ctx, roles) {
  if (!roles.includes(ctx.role)) throw new HttpError(403, 'You do not have permission');
}

export async function canAccessIntern(ctx, id, env) {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (ctx.role === 'programme_lead') return true;
  if (ctx.role === 'intern') return ctx.profile.id === id;
  if (ctx.role === 'supervisor') {
    const admin = getAdmin(env);
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('id', id)
      .eq('supervisor_identity_user_id', ctx.user.id)
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    return !!data;
  }
  return false;
}

export async function assertInternAccess(ctx, id, env) {
  if (!(await canAccessIntern(ctx, id, env))) throw new HttpError(403, 'You cannot access this intern record');
}

// Returns the new audit_log row's id so callers can offer an undo (see
// restoreAudit in _handlers.js) or otherwise reference this exact entry.
export async function audit(ctx, env, action, entityType, entityId, detail, profileId, reason = null) {
  const admin = getAdmin(env);
  const { data, error } = await admin.from('audit_log').insert({
    identity_user_id: ctx.user.id,
    profile_id: profileId || ctx.profile.id,
    action,
    entity_type: entityType,
    entity_id: entityId ? String(entityId) : null,
    detail: detail ? JSON.stringify(detail) : null,
    reason: reason || null
  }).select('id').single();
  if (error) throw new HttpError(500, error.message);
  return data.id;
}

export async function ensureRequirementProfile(env, profile) {
  if (profile.requirement_profile_id) return profile.requirement_profile_id;
  const admin = getAdmin(env);
  const code = profile.institution === 'SACAP' ? 'sacap-bpsych' : profile.institution === 'Cornerstone Institute' ? 'cornerstone-bpsych' : 'generic-720';
  const { data: row, error } = await admin.from('requirement_profiles').select('id').eq('code', code).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!row) return null;
  const { error: updateError } = await admin.from('profiles').update({ requirement_profile_id: row.id }).eq('id', profile.id);
  if (updateError) throw new HttpError(500, updateError.message);
  return row.id;
}

function flattenProfile(row) {
  if (!row) return row;
  const rp = row.requirement_profiles;
  const { requirement_profiles, ...rest } = row;
  return {
    ...rest,
    requirement_profile_code: rp?.code ?? null,
    requirement_profile_name: rp?.name ?? null,
    overall_programme_hours: rp?.overall_programme_hours ?? null
  };
}

export async function loadProfile(env, id) {
  const admin = getAdmin(env);
  const { data, error } = await admin
    .from('profiles')
    .select('*, requirement_profiles(code, name, overall_programme_hours)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, 'Intern not found');
  let profile = flattenProfile(data);
  const rpId = await ensureRequirementProfile(env, profile);
  if (rpId && !profile.requirement_profile_id) {
    const { data: refetched, error: refetchError } = await admin
      .from('profiles')
      .select('*, requirement_profiles(code, name, overall_programme_hours)')
      .eq('id', id)
      .maybeSingle();
    if (refetchError) throw new HttpError(500, refetchError.message);
    profile = flattenProfile(refetched);
  }
  return profile;
}

export { num };
