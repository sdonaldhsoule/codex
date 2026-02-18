import { kv } from "./redis";
import { maskUserId, maskUsername } from "./logging";

let _newApiUrl: string | null = null;

const USER_QUOTA_LOCK_PREFIX = "newapi:quota:credit:lock:";
const USER_QUOTA_LOCK_TTL_SECONDS = 15;
const USER_QUOTA_LOCK_RETRY_MS = 120;
const USER_QUOTA_LOCK_MAX_RETRIES = 25;
const ADMIN_SESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const ADMIN_SESSION_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const ADMIN_USER_SCAN_MAX_PAGES = 5000;

type UserQuotaLock = {
  key: string;
  token: string;
};

type AdminSessionWithUser = {
  cookies: string;
  adminUserId: number;
};

type NewApiResponse<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从 Set-Cookie 头列表中提取纯 cookie 键值对，
 * 去除 Path / Domain / HttpOnly / Secure / Expires 等属性。
 */
function extractCookieValues(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((header) => header.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function acquireUserQuotaLock(userId: number): Promise<UserQuotaLock | null> {
  const key = `${USER_QUOTA_LOCK_PREFIX}${userId}`;
  const token = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  for (let attempt = 0; attempt < USER_QUOTA_LOCK_MAX_RETRIES; attempt += 1) {
    const locked = await kv.set(key, token, { nx: true, ex: USER_QUOTA_LOCK_TTL_SECONDS });
    if (locked === "OK") {
      return { key, token };
    }
    await sleep(USER_QUOTA_LOCK_RETRY_MS);
  }

  return null;
}

async function releaseUserQuotaLock(lock: UserQuotaLock): Promise<void> {
  const luaScript = `
    local key = KEYS[1]
    local expected = ARGV[1]
    local current = redis.call('GET', key)
    if current == expected then
      return redis.call('DEL', key)
    end
    return 0
  `;
  try {
    await kv.eval(luaScript, [lock.key], [lock.token]);
  } catch (error) {
    console.error("Release quota lock failed:", error);
  }
}

function sanitizeEnvValue(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\\r\\n|\\n|\\r/g, "").replace(/[\r\n]/g, "").trim();
}

export function getNewApiUrl(): string {
  if (_newApiUrl) return _newApiUrl;
  const rawUrl = sanitizeEnvValue(process.env.NEW_API_URL);
  if (!rawUrl) {
    throw new Error("NEW_API_URL is not set.");
  }
  _newApiUrl = rawUrl.replace(/\/+$/, "");
  return _newApiUrl;
}

export interface NewApiUser {
  id: number;
  username: string;
  display_name: string;
  role: number;
  status: number;
  email: string;
  quota: number;
  used_quota: number;
  linuxdo_id?: string;
  linuxdo_level?: number;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizeUserList(data: unknown): NewApiUser[] {
  const list = Array.isArray(data) ? data : [data];
  return list.filter((item): item is NewApiUser => !!item && typeof item === "object");
}

function readAnyField(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function readUserLinuxDoId(user: NewApiUser): string {
  return normalizeLinuxDoId(readAnyField(user, ["linuxdo_id", "linuxdoId", "LinuxDoId"]));
}

function readUserUsername(user: NewApiUser): string {
  return normalizeUsername(readAnyField(user, ["username", "user_name", "name"]));
}

function readUserDisplayName(user: NewApiUser): string {
  return normalizeUsername(readAnyField(user, ["display_name", "displayName", "name"]));
}

function findMatchByLinuxDoProfile(
  users: NewApiUser[],
  targetLinuxDoId: string,
  linuxdoUsername?: string
): NewApiUser | null {
  const byLinuxDoId = users.find((user) => readUserLinuxDoId(user) === targetLinuxDoId);
  if (byLinuxDoId) return byLinuxDoId;

  const targetUsername = normalizeUsername(linuxdoUsername);
  if (!targetUsername) return null;

  const byName = users.filter((user) => {
    const username = readUserUsername(user);
    const displayName = readUserDisplayName(user);
    return username === targetUsername || displayName === targetUsername;
  });
  if (byName.length === 1) return byName[0];

  const prefixed = byName.find((user) => readUserUsername(user).startsWith("linuxdo_"));
  return prefixed ?? null;
}

export async function loginToNewApi(
  username: string,
  password: string
): Promise<{ success: boolean; message: string; cookies?: string; user?: NewApiUser }> {
  try {
    const baseUrl = getNewApiUrl();
    const safeUsername = sanitizeEnvValue(username);
    const safePassword = sanitizeEnvValue(password);
    console.log("Attempting login to new-api", {
      endpoint: `${baseUrl}/api/user/login`,
      username: maskUsername(safeUsername),
    });

    const response = await fetch(`${baseUrl}/api/user/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: safeUsername, password: safePassword }),
    });

    // 优先使用 getSetCookie() 以正确解析多个 Set-Cookie 头，
    // 然后提取纯键值对（去除 Path / HttpOnly 等属性）
    let cookies = "";
    const setCookieHeaders = response.headers.getSetCookie?.();
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      cookies = extractCookieValues(setCookieHeaders);
    }
    if (!cookies) {
      const raw = response.headers.get("set-cookie") || "";
      if (raw) {
        cookies = extractCookieValues(raw.split(",").map((s) => s.trim()));
      }
    }

    const data = await response.json();
    console.log("Login response:", {
      success: data.success,
      message: data.message,
      hasCookies: !!cookies,
      hasData: !!data.data,
      userId: maskUserId(data.data?.id),
    });

    if (data.success) {
      return { success: true, message: "登录成功", cookies, user: data.data };
    }
    return { success: false, message: data.message || "登录失败" };
  } catch (error) {
    console.error("Login error:", error);
    return { success: false, message: "服务连接失败" };
  }
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function getResponseMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const raw = (data as { message?: unknown }).message;
  return typeof raw === "string" ? raw : "";
}

function isAuthFailureResponse(status: number, data: unknown): boolean {
  if (status === 401 || status === 403) return true;
  const message = getResponseMessage(data);
  if (!message) return false;
  return /(未登录|登录|认证|授权|会话|token|session|forbidden|unauthorized|invalid)/i.test(message);
}

let adminSessionWithUserCache: {
  cookies: string;
  adminUserId: number;
  expiresAt: number;
} | null = null;

function clearAdminSessionCache(): void {
  adminSessionWithUserCache = null;
}

function getAdminCredentials(): { username: string; password: string } | null {
  const username = sanitizeEnvValue(process.env.NEW_API_ADMIN_USERNAME);
  const password = sanitizeEnvValue(process.env.NEW_API_ADMIN_PASSWORD);
  if (!username || !password) return null;
  return { username, password };
}

export async function getAdminSession(forceRefresh: boolean = false): Promise<string | null> {
  const session = await getAdminSessionWithUser(forceRefresh);
  return session?.cookies ?? null;
}

export async function getAdminSessionWithUser(forceRefresh: boolean = false): Promise<AdminSessionWithUser | null> {
  if (forceRefresh) {
    clearAdminSessionCache();
  }

  if (
    adminSessionWithUserCache &&
    adminSessionWithUserCache.expiresAt > Date.now() + ADMIN_SESSION_REFRESH_WINDOW_MS
  ) {
    return {
      cookies: adminSessionWithUserCache.cookies,
      adminUserId: adminSessionWithUserCache.adminUserId,
    };
  }

  const credentials = getAdminCredentials();
  if (!credentials) {
    console.error("Admin credentials not configured");
    return null;
  }

  const result = await loginToNewApi(credentials.username, credentials.password);
  if (!result.success || !result.cookies || !result.user?.id) {
    console.error("Admin login failed:", result.message);
    clearAdminSessionCache();
    return null;
  }

  adminSessionWithUserCache = {
    cookies: result.cookies,
    adminUserId: result.user.id,
    expiresAt: Date.now() + ADMIN_SESSION_CACHE_TTL_MS,
  };
  return { cookies: result.cookies, adminUserId: result.user.id };
}

function buildAdminHeaders(session: AdminSessionWithUser, headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);
  headers.set("Cookie", session.cookies);
  headers.set("New-Api-User", String(session.adminUserId));
  return headers;
}

export async function getUserFromNewApi(sessionCookie: string): Promise<NewApiUser | null> {
  try {
    const baseUrl = getNewApiUrl();
    const response = await fetch(`${baseUrl}/api/user/self`, {
      headers: { Cookie: sessionCookie },
    });
    const data = await parseJsonSafe<NewApiResponse<NewApiUser>>(response);
    if (response.ok && data?.success && data.data) return data.data;
    return null;
  } catch (error) {
    console.error("Get user error:", error);
    return null;
  }
}

export async function searchUserByUsername(username: string): Promise<NewApiUser | null> {
  const baseUrl = getNewApiUrl();
  const targetUsername = normalizeUsername(username);
  if (!targetUsername) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loginResult = await getAdminSessionWithUser(attempt > 0);
    if (!loginResult) return null;

    try {
      const response = await fetch(
        `${baseUrl}/api/user/search?keyword=${encodeURIComponent(username)}`,
        {
          headers: buildAdminHeaders(loginResult),
        }
      );
      const data = await parseJsonSafe<NewApiResponse<NewApiUser | NewApiUser[]>>(response);

      if (isAuthFailureResponse(response.status, data)) {
        clearAdminSessionCache();
        continue;
      }

      if (!response.ok || !data?.success || !data.data) {
        if (!response.ok || !data?.success) {
          console.warn("Search user by username failed", {
            status: response.status,
            success: data?.success,
            message: data?.message,
          });
        }
        return null;
      }

      const users = normalizeUserList(data.data);
      const exactMatch = users.find(
        (user) => readUserUsername(user) === targetUsername
      );
      return exactMatch || null;
    } catch (error) {
      console.error("Search user error:", error);
      return null;
    }
  }

  return null;
}

function normalizeLinuxDoId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

export async function findUserByLinuxDoId(
  linuxdoId: number,
  linuxdoUsername?: string
): Promise<NewApiUser | null> {
  const baseUrl = getNewApiUrl();
  const targetLinuxDoId = String(linuxdoId);
  const keywordCandidates = [
    targetLinuxDoId,
    `linuxdo_${targetLinuxDoId}`,
    `linuxdo${targetLinuxDoId}`,
    linuxdoUsername ?? "",
  ].filter((value) => value.length > 0);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loginResult = await getAdminSessionWithUser(attempt > 0);
    if (!loginResult) return null;

    let authFailed = false;

    // 先走 search 接口快速命中，减少全量分页扫描压力
    for (const keyword of keywordCandidates) {
      try {
        const searchResponse = await fetch(
          `${baseUrl}/api/user/search?keyword=${encodeURIComponent(keyword)}`,
          {
            headers: buildAdminHeaders(loginResult),
          }
        );
        const searchData = await parseJsonSafe<NewApiResponse<NewApiUser | NewApiUser[]>>(searchResponse);

        if (isAuthFailureResponse(searchResponse.status, searchData)) {
          clearAdminSessionCache();
          authFailed = true;
          break;
        }

        if (searchResponse.ok && searchData?.success && searchData.data) {
          const users = normalizeUserList(searchData.data);
          const matched = findMatchByLinuxDoProfile(users, targetLinuxDoId, linuxdoUsername);
          if (matched) return matched;
        } else if (!searchResponse.ok || !searchData?.success) {
          console.warn("Find user by linuxdoId search step failed", {
            status: searchResponse.status,
            success: searchData?.success,
            message: searchData?.message,
            keyword,
          });
        }
      } catch (error) {
        console.error("Find user by linuxdoId via search error:", error);
      }
    }

    if (authFailed) continue;

    for (let page = 0; page < ADMIN_USER_SCAN_MAX_PAGES; page += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/user/?p=${page}`, {
          headers: buildAdminHeaders(loginResult),
        });
        const data = await parseJsonSafe<NewApiResponse<NewApiUser[]>>(response);

        if (isAuthFailureResponse(response.status, data)) {
          clearAdminSessionCache();
          authFailed = true;
          break;
        }

        if (!response.ok || !data?.success || !Array.isArray(data.data)) {
          console.warn("Find user by linuxdoId scan step failed", {
            status: response.status,
            success: data?.success,
            message: data?.message,
            page,
          });
          return null;
        }

        const users = data.data;
        const matched = findMatchByLinuxDoProfile(users, targetLinuxDoId, linuxdoUsername);
        if (matched) return matched;

        if (users.length === 0) break;
      } catch (error) {
        console.error("Find user by linuxdoId error:", error);
        return null;
      }
    }

    if (!authFailed) break;
  }

  return null;
}

export async function creditQuotaToUser(
  userId: number,
  dollars: number
): Promise<{ success: boolean; message: string; newQuota?: number; uncertain?: boolean }> {
  const baseUrl = getNewApiUrl();
  const lock = await acquireUserQuotaLock(userId);
  if (!lock) {
    return { success: false, message: "系统繁忙，充值请求排队中，请稍后重试" };
  }

  let expectedQuota: number | undefined;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loginResult = await getAdminSessionWithUser(attempt > 0);
      if (!loginResult) {
        if (attempt === 0) continue;
        return { success: false, message: "管理员会话获取失败" };
      }

      const { cookies: adminCookies, adminUserId } = loginResult;

      try {
        const userResponse = await fetch(`${baseUrl}/api/user/${userId}`, {
          headers: buildAdminHeaders(loginResult),
        });
        const userData = await parseJsonSafe<NewApiResponse<NewApiUser>>(userResponse);

        if (isAuthFailureResponse(userResponse.status, userData)) {
          clearAdminSessionCache();
          continue;
        }

        if (!userResponse.ok || !userData?.success || !userData.data) {
          return { success: false, message: userData?.message || "获取用户信息失败" };
        }

        const user = userData.data;
        const currentQuota = user.quota || 0;
        const quotaToAdd = Math.floor(dollars * 500000);
        const newQuota = currentQuota + quotaToAdd;
        expectedQuota = newQuota;

        const updatePayload = { ...user, id: userId, quota: newQuota };
        const sanitizedUpdatePayload = Object.fromEntries(
          Object.entries(updatePayload).filter(([, value]) => value !== undefined)
        );

        const updateResponse = await fetch(`${baseUrl}/api/user/`, {
          method: "PUT",
          headers: buildAdminHeaders(loginResult, { "Content-Type": "application/json" }),
          body: JSON.stringify(sanitizedUpdatePayload),
        });
        const updateData = await parseJsonSafe<NewApiResponse<unknown>>(updateResponse);

        if (isAuthFailureResponse(updateResponse.status, updateData)) {
          clearAdminSessionCache();
          continue;
        }

        if (updateData?.success) {
          return { success: true, message: `成功充值 $${dollars}`, newQuota };
        }

        const verifyResult = await verifyQuotaUpdate(userId, newQuota, adminCookies, adminUserId);
        if (verifyResult.success || verifyResult.uncertain) return verifyResult;
        return { success: false, message: updateData?.message || "额度更新失败" };
      } catch (error) {
        console.error("Credit quota error:", error);
        try {
          const nextLoginResult = await getAdminSessionWithUser(true);
          if (nextLoginResult) {
            const verifyResult = await verifyQuotaUpdate(
              userId,
              expectedQuota,
              nextLoginResult.cookies,
              nextLoginResult.adminUserId
            );
            if (verifyResult.uncertain) {
              return { success: false, message: "充值结果不确定，请稍后检查余额", uncertain: true };
            }
            return verifyResult;
          }
        } catch (verifyError) {
          console.error("Verification also failed:", verifyError);
        }
        return { success: false, message: "服务连接失败，结果不确定，请检查余额", uncertain: true };
      }
    }

    return { success: false, message: "管理员会话获取失败" };
  } finally {
    await releaseUserQuotaLock(lock);
  }
}

/**
 * 查询指定用户的当前额度，用于对账验证。
 */
export async function checkUserQuota(userId: number): Promise<{ success: boolean; quota?: number }> {
  const session = await getAdminSessionWithUser();
  if (!session) return { success: false };

  try {
    const baseUrl = getNewApiUrl();
    const response = await fetch(`${baseUrl}/api/user/${userId}`, {
      headers: buildAdminHeaders(session),
    });
    const data = await parseJsonSafe<NewApiResponse<NewApiUser>>(response);
    if (response.ok && data?.success && data.data) {
      return { success: true, quota: data.data.quota || 0 };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
}

async function verifyQuotaUpdate(
  userId: number,
  expectedQuota: number | undefined,
  adminCookies: string,
  adminUserId: number
): Promise<{ success: boolean; message: string; newQuota?: number; uncertain?: boolean }> {
  try {
    const baseUrl = getNewApiUrl();
    const verifyResponse = await fetch(`${baseUrl}/api/user/${userId}`, {
      headers: {
        Cookie: adminCookies,
        "New-Api-User": String(adminUserId),
      },
    });
    const verifyData = await parseJsonSafe<NewApiResponse<NewApiUser>>(verifyResponse);

    if (verifyResponse.ok && verifyData?.success && verifyData.data) {
      const currentQuota = verifyData.data.quota || 0;
      if (expectedQuota !== undefined && currentQuota >= expectedQuota) {
        return { success: true, message: "充值已确认成功", newQuota: currentQuota };
      }
      if (expectedQuota === undefined) {
        return { success: false, message: "无法确认充值结果", newQuota: currentQuota, uncertain: true };
      }
      return { success: false, message: "充值确认失败" };
    }

    return {
      success: false,
      message: verifyData?.message || "验证用户信息失败",
      uncertain: true,
    };
  } catch (error) {
    console.error("Verify quota update error:", error);
    return { success: false, message: "验证失败", uncertain: true };
  }
}
