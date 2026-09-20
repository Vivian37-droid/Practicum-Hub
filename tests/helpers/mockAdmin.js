// A minimal stand-in for the supabase-js admin client, built only to cover
// the small slice of the query-builder surface functions/api/_handlers.js
// and functions/_shared/context.js actually call. Never touches a real
// Supabase project — everything is answered from a FIFO `queue` of
// {data, error} results the test supplies, one per terminal resolution
// (.maybeSingle()/.single()/awaiting the builder itself), in the exact
// order the code under test calls them. This is what keeps these tests from
// ever reading or writing production data: there is no database here.
import { vi } from 'vitest';

export function createMockAdmin(queue = []) {
  const calls = [];
  let i = 0;
  function resolveNext(meta) {
    const result = i < queue.length ? queue[i] : { data: null, error: null };
    i += 1;
    calls.push({ ...meta, result });
    return result;
  }
  function builder(table) {
    const ops = [];
    const record = (name, ...args) => { ops.push([name, ...args]); return b; };
    const b = {
      select: (...a) => record('select', ...a),
      eq: (...a) => record('eq', ...a),
      neq: (...a) => record('neq', ...a),
      not: (...a) => record('not', ...a),
      lt: (...a) => record('lt', ...a),
      gt: (...a) => record('gt', ...a),
      order: (...a) => record('order', ...a),
      limit: (...a) => record('limit', ...a),
      in: (...a) => record('in', ...a),
      insert: (v) => record('insert', v),
      update: (v) => record('update', v),
      upsert: (v, o) => record('upsert', v, o),
      delete: () => record('delete'),
      maybeSingle: () => Promise.resolve(resolveNext({ table, ops: [...ops, 'maybeSingle'] })),
      single: () => Promise.resolve(resolveNext({ table, ops: [...ops, 'single'] })),
      then: (resolve, reject) => Promise.resolve(resolveNext({ table, ops })).then(resolve, reject)
    };
    return b;
  }
  const admin = {
    from: vi.fn(builder),
    rpc: vi.fn((name, args) => Promise.resolve(resolveNext({ rpc: name, args }))),
    auth: { getUser: vi.fn(), admin: { deleteUser: vi.fn(), inviteUserByEmail: vi.fn() } }
  };
  return { admin, calls };
}

// Finds the payload passed to admin.from('audit_log').insert(payload) for
// the nth (default: first) audit_log insert call, with `detail` parsed back
// out of its JSON string for easy assertions.
export function auditInsertPayload(calls, n = 0) {
  const inserts = calls.filter(c => c.table === 'audit_log' && c.ops.some(op => op[0] === 'insert'));
  const call = inserts[n];
  if (!call) return null;
  const insertOp = call.ops.find(op => op[0] === 'insert');
  const payload = insertOp[1];
  return { ...payload, detail: payload.detail ? JSON.parse(payload.detail) : null };
}

export function ctxFor(role, profile = {}) {
  return { user: { id: 'user-' + role, email: `${role}@example.test` }, profile: { id: 1, display_name: 'Test Person', email: `${role}@example.test`, ...profile }, role };
}
