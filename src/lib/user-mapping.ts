import { kv } from './redis';
import { findUserByLinuxDoId, searchUserByUsername } from './new-api';

const MAPPING_PREFIX = 'mapping:linuxdo:';
const MAPPING_TTL_SECONDS = 24 * 60 * 60; // 24 小时
const MAPPING_MISS_TTL_SECONDS = 10 * 60; // 未命中缓存 10 分钟，避免频繁全表扫描

interface UserMapping {
  newApiUserId: number | null;
  cachedAt: number;
  found?: boolean;
}

/**
 * 根据 LinuxDo ID 查找 newapi userId
 *
 * 1. 先查 Redis 缓存
 * 2. 缓存未命中或过期时，先尝试常见用户名规则（兼容历史实例）
 * 3. 若未命中，则按 linuxdo_id 精确匹配
 * 4. 缓存结果到 Redis
 */
export async function getNewApiUserId(linuxdoId: number): Promise<number | null> {
  const cacheKey = `${MAPPING_PREFIX}${linuxdoId}`;

  // 1. 查缓存
  const cached = await kv.get<UserMapping>(cacheKey);
  if (cached && typeof cached.cachedAt === 'number') {
    const age = Date.now() - (cached.cachedAt || 0);
    if (age < MAPPING_TTL_SECONDS * 1000) {
      if (cached.found === false) return null;
      if (typeof cached.newApiUserId === 'number' && cached.newApiUserId > 0) {
        return cached.newApiUserId;
      }
    }
  }

  // 2. 先用常见用户名规则尝试（兼容历史实例）
  const usernameCandidates = [`linuxdo_${linuxdoId}`, `linuxdo${linuxdoId}`];
  let user = null;
  for (const candidate of usernameCandidates) {
    user = await searchUserByUsername(candidate);
    if (user) break;
  }

  // 3. 若用户名规则未命中，按 linuxdo_id 精确匹配（可靠）
  if (!user) {
    user = await findUserByLinuxDoId(linuxdoId);
  }

  if (!user) {
    await kv.set(cacheKey, {
      newApiUserId: null,
      cachedAt: Date.now(),
      found: false,
    }, { ex: MAPPING_MISS_TTL_SECONDS });
    return null;
  }

  // 4. 缓存映射
  const mapping: UserMapping = {
    newApiUserId: user.id,
    cachedAt: Date.now(),
    found: true,
  };
  await kv.set(cacheKey, mapping, { ex: MAPPING_TTL_SECONDS });

  return user.id;
}

/**
 * 清除用户映射缓存
 */
export async function clearUserMapping(linuxdoId: number): Promise<void> {
  const cacheKey = `${MAPPING_PREFIX}${linuxdoId}`;
  await kv.del(cacheKey);
}
