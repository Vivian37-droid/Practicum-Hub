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
      lte: (...a) => record('lte', ...a),
      gt: (...a) => record('gt', ...a),
      gte: (...a) => record('gte', ...a),
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

// A second flavour of mock, for handlers (like reports()) that fire several
// admin.from()/admin.rpc() calls concurrently via Promise.all: resolving by
// FIFO position across branches that race is fragile (their completion
// order isn't guaranteed), so this resolves by table/rpc NAME instead. Each
// entry in `tables`/`rpcs` can be a plain {data,error} response (returned
// every time), an array (consumed FIFO per name, for repeat calls to the
// same table), or a function `(opsOrArgs, callIndex) => {data,error}` for a
// response computed from the actual arguments a call used — which is what
// makes "this call got its own intern/month, not someone else's" testable
// directly, rather than just inspected after the fact.
export function createNamedMockAdmin({ tables = {}, rpcs = {} } = {}) {
  const calls = [];
  const counters = {};
  function resolveEntry(map, name, argsOrOps) {
    const entry = map[name];
    const idx = counters[name] || 0;
    counters[name] = idx + 1;
    let value;
    if (typeof entry === 'function') value = entry(argsOrOps, idx);
    else if (Array.isArray(entry)) value = entry[Math.min(idx, entry.length - 1)];
    else value = entry;
    return value ?? { data: null, error: null };
  }
  function builder(table) {
    const ops = [];
    const record = (name, ...args) => { ops.push([name, ...args]); return b; };
    const finish = (extra) => {
      const allOps = extra ? [...ops, extra] : ops;
      const result = resolveEntry(tables, table, allOps);
      calls.push({ table, ops: allOps, result });
      return result;
    };
    const b = {
      select: (...a) => record('select', ...a),
      eq: (...a) => record('eq', ...a),
      neq: (...a) => record('neq', ...a),
      not: (...a) => record('not', ...a),
      lt: (...a) => record('lt', ...a),
      lte: (...a) => record('lte', ...a),
      gt: (...a) => record('gt', ...a),
      gte: (...a) => record('gte', ...a),
      order: (...a) => record('order', ...a),
      limit: (...a) => record('limit', ...a),
      in: (...a) => record('in', ...a),
      insert: (v) => record('insert', v),
      update: (v) => record('update', v),
      upsert: (v, o) => record('upsert', v, o),
      delete: () => record('delete'),
      maybeSingle: () => Promise.resolve(finish('maybeSingle')),
      single: () => Promise.resolve(finish('single')),
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject)
    };
    return b;
  }
  const admin = {
    from: vi.fn(builder),
    rpc: vi.fn((name, args) => {
      const result = resolveEntry(rpcs, name, args);
      calls.push({ rpc: name, args, result });
      return Promise.resolve(result);
    }),
    auth: { getUser: vi.fn(), admin: { deleteUser: vi.fn(), inviteUserByEmail: vi.fn() } }
  };
  return { admin, calls };
}

export function ctxFor(role, profile = {}) {
  return { user: { id: 'user-' + role, email: `${role}@example.test` }, profile: { id: 1, display_name: 'Test Person', email: `${role}@example.test`, ...profile }, role };
}
