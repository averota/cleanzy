// supabase/functions/manage-user/index.ts
// Update or delete an existing user. Callable by Super Admin or Admin only.
// Deploy: supabase functions deploy manage-user
//
// Update: invoke('manage-user', { body: { action: 'update', id, name?, position?, email?, role?, password?, is_active? } })
// Delete: invoke('manage-user', { body: { action: 'delete', id } })

import { authorize, EMAIL_RE, MIN_PASSWORD, preflight, readJson, reply, ROLES } from "../_shared/common.ts";

const BAN_FOREVER = "876000h"; // ~100 years; "none" lifts the ban

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  const auth = await authorize(req);
  if (auth instanceof Response) return auth;
  const { caller, admin, user } = auth;

  const body = await readJson(req);
  if (!body) return reply({ error: "Invalid JSON" }, 400);

  const { action, id } = body;
  if (!id) return reply({ error: "id is required" }, 400);
  if (action !== "update" && action !== "delete") {
    return reply({ error: "action must be 'update' or 'delete'" }, 400);
  }

  // Target must exist in public.users (the Super Admin never does, so it cannot be targeted).
  const { data: target } = await caller.from("users").select("*").eq("id", id).maybeSingle();
  if (!target) return reply({ error: "User not found" }, 404);

  const isSelf = id === user.id;

  // ---------------- DELETE ----------------
  if (action === "delete") {
    if (isSelf) return reply({ error: "You cannot delete your own account" }, 400);

    const { count } = await caller
      .from("users")
      .select("id", { count: "exact", head: true })
      .or(`created_by.eq.${id},updated_by.eq.${id}`);
    if (count) return reply({ error: "User has change history. Deactivate the user instead." }, 409);

    const { error } = await admin.auth.admin.deleteUser(id); // cascades to public.users
    if (error) return reply({ error: "Cannot delete user (has related records). Deactivate instead." }, 409);
    return reply({ deleted: id });
  }

  // ---------------- UPDATE ----------------
  const patch: Record<string, unknown> = {};

  if ("name" in body) {
    const name = body.name?.trim();
    if (!name) return reply({ error: "Name cannot be empty" }, 400);
    patch.name = name;
  }
  if ("position" in body) patch.position = body.position?.trim() || null;
  if ("email" in body) {
    const email = body.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return reply({ error: "Valid email is required" }, 400);
    patch.email = email;
  }
  if ("role" in body) {
    if (!ROLES.includes(body.role)) return reply({ error: `Role must be one of: ${ROLES.join(", ")}` }, 400);
    if (isSelf && body.role !== target.role) return reply({ error: "You cannot change your own role" }, 400);
    patch.role = body.role;
  }
  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") return reply({ error: "is_active must be true or false" }, 400);
    if (isSelf && !body.is_active) return reply({ error: "You cannot deactivate your own account" }, 400);
    patch.is_active = body.is_active;
  }

  const { password } = body;
  if (password !== undefined && (typeof password !== "string" || password.length < MIN_PASSWORD)) {
    return reply({ error: `Password must be at least ${MIN_PASSWORD} characters` }, 400);
  }

  // Auth account attributes that need the service-role key.
  const authAttrs: Record<string, unknown> = {};
  if (patch.email) Object.assign(authAttrs, { email: patch.email, email_confirm: true });
  if (password) authAttrs.password = password;
  if ("is_active" in patch) authAttrs.ban_duration = patch.is_active ? "none" : BAN_FOREVER;

  const patchKeys = Object.keys(patch);
  if (!patchKeys.length && !password) return reply({ error: "Nothing to update" }, 400);

  // 1) Profile first, as the caller (RLS + audit trigger).
  let profile = target;
  if (patchKeys.length) {
    const { data, error } = await caller.from("users").update(patch).eq("id", id).select().single();
    if (error) return reply({ error: error.message }, 400);
    profile = data;
  }

  // 2) Auth account; revert the profile if this fails.
  if (Object.keys(authAttrs).length) {
    const { error } = await admin.auth.admin.updateUserById(id, authAttrs);
    if (error) {
      if (patchKeys.length) {
        const revert = Object.fromEntries(patchKeys.map((k) => [k, target[k]]));
        await caller.from("users").update(revert).eq("id", id);
      }
      return reply({ error: error.message }, 400);
    }
  }

  return reply({ user: profile });
});
