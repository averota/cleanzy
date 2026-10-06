// assets/js/auth.js
// Shared sign-in helpers for every page. Load AFTER supabaseClient.js.
//
//   Auth.validate()      -> { ok, user, name, role } | { ok:false, reason }
//   Auth.guard(loginUrl) -> same as validate(); on failure signs out and redirects to loginUrl
//   Auth.signOut(loginUrl)
//
// reason: 'no-session' | 'no-profile' | 'inactive' | 'error'
const Auth = (() => {
  async function validate() {
    const { data } = await sb.auth.getSession();
    const user = data?.session?.user;
    if (!user) return { ok: false, reason: 'no-session' };

    // Super Admin has no row in public.users (see 01_users.sql).
    if (user.app_metadata?.role === 'super_admin') {
      return { ok: true, user, name: 'Admin', role: 'Super Admin' };
    }

    const { data: profile, error } = await sb
      .from('users')
      .select('name, role, is_active')
      .eq('id', user.id)
      .maybeSingle();

    if (error) return { ok: false, reason: 'error' };
    if (!profile) return { ok: false, reason: 'no-profile' };
    if (!profile.is_active) return { ok: false, reason: 'inactive' };

    return { ok: true, user, name: profile.name, role: profile.role };
  }

  async function guard(loginUrl) {
    const result = await validate();
    if (result.ok) return result;

    if (result.reason !== 'no-session') await sb.auth.signOut();
    const query = result.reason === 'no-session' ? '' : `?reason=${result.reason}`;
    location.replace(loginUrl + query);
    return result;
  }

  async function signOut(loginUrl) {
    await sb.auth.signOut();
    location.replace(loginUrl);
  }

  return { validate, guard, signOut };
})();
