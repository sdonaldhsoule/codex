import { kv } from './redis';
import { searchUserByUsername } from './new-api';

const MAPPING_PREFIX = 'mapping:linuxdo:';
const MAPPING_TTL_SECONDS = 24 * 60 * 60; // 24 小时

interface UserMapping {
  newApiUserId: number;
  cachedAt: number;
}

/**
 * 根据 LinuxDo ID 查找 newapi userId
 * NewAPI 用 LinuxDo 登录后，用户名格式为 linuxdo{linuxdoId}（如 linuxdo66994）
 *
 * 1. 先查 Redis 缓存
 * 2. 缓存未命中或过期时，用 "linuxdo{linuxdoId}" 搜索 newapi
 * 3. 缓存结果到 Redis
 */
export async function getNewApiUserId(linuxdoId: number): Promise<number | null> {
  const cacheKey = `${MAPPING_PREFIX}${linuxdoId}`;

  // 1. 查缓存
  const cached = await kv.get<UserMapping>(cacheKey);
  if (cached && cached.newApiUserId) {
    const age = Date.now() - (cached.cachedAt || 0);
    if (age < MAPPING_TTL_SECONDS * 1000) {
      return cached.newApiUserId;
    }
  }

  // 2. NewAPI 中 LinuxDo 登录用户的用户名格式: linuxdo{linuxdoId}
  const newApiUsername = `linuxdo${linuxdoId}`;
  const user = await searchUserByUsername(newApiUsername);
  if (!user) {
    return null;
  }

  // 3. 缓存映射
  const mapping: UserMapping = {
    newApiUserId: user.id,
    cachedAt: Date.now(),
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
