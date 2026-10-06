// supabase/functions/_shared/common.ts
// Shared helpers for user-management Edge Functions.

import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

export const ROLES = ["Admin", "Store Manager", "Clerk"];
export const MIN_PASSWORD = 8;
export const EMAIL_RE = /^\S+@\S+\.\S+$/;

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

/** Handles CORS preflight and non-POST requests. Returns a Response to stop, or null to continue. */
export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  return null;
}

export async function readJson(req: Request): Promise<Record<string, any> | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Verifies the caller is Super Admin or Admin.
 * - caller: client acting as the caller (RLS + audit triggers see the real actor)
 * - admin:  service-role client (only for Auth account operations)
 */
export async function authorize(
  req: Request,
): Promise<{ caller: SupabaseClient; admin: SupabaseClient; user: User } | Response> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return reply({ error: "Unauthorized" }, 401);

  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: { user }, error } = await caller.auth.getUser();
  if (error || !user) return reply({ error: "Unauthorized" }, 401);

  if (user.app_metadata?.role !== "super_admin") {
    const { data: isAdmin } = await caller.rpc("is_admin");
    if (!isAdmin) return reply({ error: "Forbidden" }, 403);
  }

  return { caller, admin, user };
}
