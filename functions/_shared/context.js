// Auth/role/authorization logic. This is a direct port of context(),
// requireRole(), canAccessIntern(), assertInternAccess(), audit(),
// ensureRequirementProfile() and loadProfile() from the old
// netlify/functions/api.mjs, with @netlify/identity's getUser() replaced by
// verifying the Supabase Auth access token the frontend sends in the
// Authorization header.

import { HttpError, cleanEmail, leadEmails, num } from './util.js';
import { getSql, getAdmin } from './clients.js';

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
  const sql = getSql(env);
  const email = cleanEmail(user.email);

  let [profile] = await sql`
    SELECT * FROM profiles WHERE identity_user_id = ${user.id} OR lower(email) = ${email}
    ORDER BY identity_user_id IS NOT NULL DESC LIMIT 1`;

  const metadataRoles = user.app_metadata?.roles || user.user_metadata?.roles || [];
  const role = leadEmails(env).has(email)
    ? 'programme_lead'
    : (['programme_lead', 'supervisor', 'management', 'intern'].find(r => metadataRoles.includes(r)) || 'intern');

  if (!profile) {
    [profile] = await sql`
      INSERT INTO profiles(identity_user_id, email, display_name, role)
      VALUES (${user.id}, ${email}, ${user.user_metadata?.display_name || email.split('@')[0]}, ${role})
      RETURNING *`;
  } else if (profile.identity_user_id !== user.id || profile.role !== role) {
    [profile] = await sql`
      UPDATE profiles SET identity_user_id = ${user.id}, role = ${role}, updated_at = NOW()
      WHERE id = ${profile.id} RETURNING *`;
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
    const sql = getSql(env);
    const [row] = await sql`SELECT 1 FROM profiles WHERE id = ${id} AND supervisor_identity_user_id = ${ctx.user.id}`;
    return !!row;
  }
  return false;
}

export async function assertInternAccess(ctx, id, env) {
  if (!(await canAccessIntern(ctx, id, env))) throw new HttpError(403, 'You cannot access this intern record');
}

export async function audit(ctx, env, action, entityType, entityId, detail, profileId) {
  const sql = getSql(env);
  await sql`
    INSERT INTO audit_log(identity_user_id, profile_id, action, entity_type, entity_id, detail)
    VALUES (${ctx.user.id}, ${profileId || ctx.profile.id}, ${action}, ${entityType}, ${entityId ? String(entityId) : null}, ${detail ? JSON.stringify(detail) : null})`;
}

export async function ensureRequirementProfile(env, profile) {
  if (profile.requirement_profile_id) return profile.requirement_profile_id;
  const sql = getSql(env);
  const code = profile.institution === 'SACAP' ? 'sacap-bpsych' : profile.institution === 'Cornerstone Institute' ? 'cornerstone-bpsych' : 'generic-720';
  const [row] = await sql`SELECT id FROM requirement_profiles WHERE code = ${code}`;
  if (!row) return null;
  await sql`UPDATE profiles SET requirement_profile_id = ${row.id} WHERE id = ${profile.id}`;
  return row.id;
}

export async function loadProfile(env, id) {
  const sql = getSql(env);
  let [profile] = await sql`
    SELECT p.*, rp.code requirement_profile_code, rp.name requirement_profile_name, rp.overall_programme_hours
    FROM profiles p LEFT JOIN requirement_profiles rp ON rp.id = p.requirement_profile_id WHERE p.id = ${id}`;
  if (!profile) throw new HttpError(404, 'Intern not found');
  const rpId = await ensureRequirementProfile(env, profile);
  if (rpId && !profile.requirement_profile_id) {
    [profile] = await sql`
      SELECT p.*, rp.code requirement_profile_code, rp.name requirement_profile_name, rp.overall_programme_hours
      FROM profiles p LEFT JOIN requirement_profiles rp ON rp.id = p.requirement_profile_id WHERE p.id = ${id}`;
  }
  return profile;
}

export { num };
