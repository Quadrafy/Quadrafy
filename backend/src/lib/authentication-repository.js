import { createClient } from "@supabase/supabase-js";

function throwDatabaseError(operation, error) {
  if (!error) return;
  const wrapped = new Error(`Supabase ${operation} failed: ${error.message}`);
  wrapped.code = error.code;
  throw wrapped;
}

function waits(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWithClockSkewRetry(request) {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await request();
    const isFutureJwt =
      response.error?.code === "PGRST303" &&
      /JWT issued at future/i.test(response.error.message);
    if (!isFutureJwt || attempt === 2) return response;
    await waits(1_000);
  }
  return response;
}

function toAppUser(row) {
  return {
    id: row.id,
    role: row.role === "club_manager" ? "club" : row.role,
    email: row.email,
    passwordHash: row.password_hash,
    profile: row.profile ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDatabaseUser(user) {
  return {
    id: user.id,
    role: user.role,
    email: user.email,
    password_hash: user.passwordHash,
    profile: user.profile ?? {},
    created_at: user.createdAt,
    updated_at: user.updatedAt,
  };
}

/**
 * Persistência da autenticação no Supabase.
 *
 * O backend usa a chave secreta apenas no servidor. O navegador continua
 * recebendo somente o cookie de sessão HttpOnly já existente.
 */
export class SupabaseAuthenticationRepository {
  constructor(client) {
    this.client = client;
  }

  async loadUsers() {
    const { data, error } = await requestWithClockSkewRetry(() =>
      this.client
        .from("app_users")
        .select("id, role, email, password_hash, profile, created_at, updated_at"),
    );
    throwDatabaseError("load users", error);
    return (data ?? []).map(toAppUser);
  }

  async createUser(user) {
    const { data, error } = await this.client
      .from("app_users")
      .insert(toDatabaseUser(user))
      .select("id, role, email, password_hash, profile, created_at, updated_at")
      .single();
    throwDatabaseError("create user", error);
    return toAppUser(data);
  }

  async updateUserProfile(userId, profile, updatedAt) {
    const { data, error } = await this.client
      .from("app_users")
      .update({ profile, updated_at: updatedAt })
      .eq("id", userId)
      .select("id, role, email, password_hash, profile, created_at, updated_at")
      .single();
    throwDatabaseError("update user", error);
    return toAppUser(data);
  }

  async loadActiveSessions(now) {
    const { data, error } = await requestWithClockSkewRetry(() =>
      this.client
        .from("app_sessions")
        .select("token_hash, user_id, expires_at")
        .gt("expires_at", now.toISOString()),
    );
    throwDatabaseError("load sessions", error);
    return (data ?? []).map((session) => ({
      tokenHash: session.token_hash,
      userId: session.user_id,
      expiresAt: new Date(session.expires_at).getTime(),
    }));
  }

  async createSession(session) {
    const { error } = await this.client.from("app_sessions").insert({
      token_hash: session.tokenHash,
      user_id: session.userId,
      expires_at: new Date(session.expiresAt).toISOString(),
    });
    throwDatabaseError("create session", error);
  }

  async revokeSession(tokenHash) {
    const { error } = await this.client
      .from("app_sessions")
      .delete()
      .eq("token_hash", tokenHash);
    throwDatabaseError("revoke session", error);
  }

  async removeExpiredSessions(now) {
    const { error } = await this.client
      .from("app_sessions")
      .delete()
      .lte("expires_at", now.toISOString());
    throwDatabaseError("remove expired sessions", error);
  }
}

export function createAuthenticationRepository(config) {
  if (!config.supabaseUrl || !config.supabaseSecretKey) return null;

  const client = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return new SupabaseAuthenticationRepository(client);
}
