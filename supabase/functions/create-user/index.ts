// supabase/functions/create-user/index.ts
// Creates an Auth account + public.users row. Callable by Super Admin or Admin only.
// Deploy: supabase functions deploy create-user
// Call:   supabase.functions.invoke('create-user', { body: { name, position, email, role, password } })

import { authorize, EMAIL_RE, MIN_PASSWORD, preflight, readJson, reply, ROLES } from "../_shared/common.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const { caller, admin } = auth;

  const body = await readJson(req);
  if (!body) return reply({ error: "Invalid JSON" }, 400);

  const name = body.name?.trim();
  const position = body.position?.trim() || null;
  const email = body.email?.trim().toLowerCase();
  const { role, password } = body;

  if (!name) return reply({ error: "Name is required" }, 400);
  if (!email || !EMAIL_RE.test(email)) return reply({ error: "Valid email is required" }, 400);
  if (!ROLES.includes(role)) return reply({ error: `Role must be one of: ${ROLES.join(", ")}` }, 400);
  if (!password || password.length < MIN_PASSWORD) {
    return reply({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) return reply({ error: createErr?.message ?? "Failed to create account" }, 400);

  // Insert profile as the caller; roll back the Auth account on failure.
  const { data: profile, error: insertErr } = await caller
    .from("users")
    .insert({ id: created.user.id, name, position, email, role })
    .select()
    .single();

  if (insertErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return reply({ error: insertErr.message }, 400);
  }

  return reply({ user: profile }, 201);
});
