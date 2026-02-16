import { kv } from './redis';
import { db } from './mysql';

const MAPPING_PREFIX = 'mapping:linuxdo:';
const MAPPING_TTL_SECONDS = 24 * 60 * 60; // 24 小时
const MAPPING_MISS_TTL_SECONDS = 10 * 60; // 未命中缓存 10 分钟

interface UserMapping {
  newApiUserId: number | null;
  cachedAt: number;
  found?: boolean;
}

/**
 * 根据 LinuxDo ID 查找 newapi userId
 * 直接查 NewAPI 的 MySQL 数据库：SELECT id FROM users WHERE linuxdo_id = ?
 *
 * 1. 先查 Redis 缓存
 * 2. 缓存未命中时直接查 MySQL
 * 3. 缓存结果到 Redis
 */
export async function getNewApiUserId(linuxdoId: number, _linuxdoUsername?: string): Promise<number | null> {
  const cacheKey = `${MAPPING_PREFIX}${linuxdoId}`;

  // 1. 查缓存
  const cached = await kv.get<UserMapping>(cacheKey);
  if (cached && typeof cached.cachedAt === 'number') {
    const age = Date.now() - cached.cachedAt;
    if (age < MAPPING_TTL_SECONDS * 1000) {
      if (cached.found === false) return null;
      if (typeof cached.newApiUserId === 'number' && cached.newApiUserId > 0) {
        return cached.newApiUserId;
      }
    }
  }

  // 2. 直接查 NewAPI 的 MySQL
  try {
    const row = await db.queryOne<{ id: number }>(
      'SELECT id FROM users WHERE linux_do_id = ? LIMIT 1',
      [String(linuxdoId)]
    );

    if (row && row.id > 0) {
      // 命中：缓存映射
      console.log('[user-mapping] found via MySQL', { linuxdoId, newApiUserId: row.id });
      await kv.set(cacheKey, {
        newApiUserId: row.id,
        cachedAt: Date.now(),
        found: true,
      } satisfies UserMapping, { ex: MAPPING_TTL_SECONDS });
      return row.id;
    }

    // 未找到：缓存未命中结果，避免频繁查库
    console.warn('[user-mapping] not found in MySQL', { linuxdoId });
    await kv.set(cacheKey, {
      newApiUserId: null,
      cachedAt: Date.now(),
      found: false,
    } satisfies UserMapping, { ex: MAPPING_MISS_TTL_SECONDS });
    return null;
  } catch (error) {
    console.error('[user-mapping] MySQL query error:', error);
    return null;
  }
}

/**
 * 清除用户映射缓存
 */
export async function clearUserMapping(linuxdoId: number): Promise<void> {
  const cacheKey = `${MAPPING_PREFIX}${linuxdoId}`;
  await kv.del(cacheKey);
}
