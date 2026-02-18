import { kv } from "./redis";
import { getChinaDayStartTimestamp, getTodayDateString, getSecondsUntilMidnight } from "./time";

export interface LotteryTier {
  id: string;
  name: string;
  value: number;
  probability: number;
  color: string;
}

export interface LotteryRecord {
  id: string;
  linuxdoId: string;
  username: string;
  tierId: string;
  tierName: string;
  tierValue: number;
  directCredit: boolean;
  creditedQuota?: number;
  createdAt: number;
}

interface StoredLotteryRecord extends Partial<LotteryRecord> {
  oderId?: string;
}

export interface LotteryConfig {
  enabled: boolean;
  dailyDirectLimit: number;
  tiers: LotteryTier[];
}

const DEFAULT_TIERS: LotteryTier[] = [
  { id: "tier_1", name: "1刀福利", value: 1, probability: 40, color: "#22c55e" },
  { id: "tier_3", name: "3刀福利", value: 3, probability: 30, color: "#3b82f6" },
  { id: "tier_5", name: "5刀福利", value: 5, probability: 18, color: "#f59e0b" },
  { id: "tier_10", name: "10刀福利", value: 10, probability: 8, color: "#ec4899" },
  { id: "tier_15", name: "15刀福利", value: 15, probability: 3, color: "#8b5cf6" },
  { id: "tier_20", name: "20刀福利", value: 20, probability: 1, color: "#ef4444" },
];

const DEFAULT_CONFIG: LotteryConfig = {
  enabled: true,
  dailyDirectLimit: 2000,
  tiers: DEFAULT_TIERS,
};

const LOTTERY_CONFIG_KEY = "lottery:config";
const LOTTERY_RECORDS_KEY = "lottery:records"; // 兼容旧数据读取
const LOTTERY_RECORDS_RECENT_KEY = "lottery:records:recent";
const LOTTERY_RECORDS_DAY_PREFIX = "lottery:records:day:";
const LOTTERY_RECORDS_TOTAL_KEY = "lottery:records:total";
const LOTTERY_RECORDS_LEGACY_FALLBACK_CHECK_PREFIX = "lottery:records:legacy-fallback-checked:";
const LOTTERY_USER_RECORDS_PREFIX = "lottery:user:records:";
const LOTTERY_DAILY_PREFIX = "lottery:daily:";
const LOTTERY_DAILY_DIRECT_KEY = "lottery:daily_direct:";
const DIRECT_AMOUNT_SCALE = 100;
const TODAY_RECORDS_SCAN_BATCH = 200;
const TODAY_RECORDS_MAX_SCAN = 20000;
const RECORDS_RECENT_MAX_LENGTH = 5000;
const USER_RECORDS_MAX_LENGTH = 200;
const RECORDS_DAY_ARCHIVE_TTL_SECONDS = 400 * 24 * 60 * 60;
const RECORDS_MIGRATION_CHUNK_SIZE = 500;
const LOTTERY_CONFIG_MAX_DAILY_LIMIT = 1_000_000;
const LOTTERY_CONFIG_MAX_TIER_VALUE = 100_000;

const LOTTERY_PENDING_RECORDS_KEY = "lottery:pending_records";
const PENDING_RECORDS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 超过 24h 的 pending 视为过期

export interface PendingLotteryRecord {
  record: LotteryRecord;
  newApiUserId: number;
  expectedQuota: number;
  reservationDay: string;
  storedAt: number;
}

let totalRecordsInitPromise: Promise<void> | null = null;

function cloneDefaultLotteryConfig(): LotteryConfig {
  return { ...DEFAULT_CONFIG, tiers: DEFAULT_TIERS.map((tier) => ({ ...tier })) };
}

function sanitizeLotteryConfig(config: Partial<LotteryConfig>): LotteryConfig {
  const fallback = cloneDefaultLotteryConfig();

  const tiers = Array.isArray(config.tiers) && config.tiers.length > 0
    ? config.tiers.map((tier, index) => {
        const base = fallback.tiers[index] ?? fallback.tiers[fallback.tiers.length - 1];
        return {
          id: typeof tier?.id === "string" && tier.id.trim() ? tier.id : base.id,
          name: typeof tier?.name === "string" && tier.name.trim() ? tier.name : base.name,
          value: typeof tier?.value === "number" && Number.isFinite(tier.value) && tier.value > 0
            ? Math.min(tier.value, LOTTERY_CONFIG_MAX_TIER_VALUE)
            : base.value,
          probability: typeof tier?.probability === "number" && Number.isFinite(tier.probability) && tier.probability >= 0
            ? tier.probability
            : base.probability,
          color: typeof tier?.color === "string" && tier.color.trim() ? tier.color : base.color,
        };
      })
    : fallback.tiers;

  return {
    enabled: typeof config.enabled === "boolean" ? config.enabled : fallback.enabled,
    dailyDirectLimit: typeof config.dailyDirectLimit === "number" && Number.isFinite(config.dailyDirectLimit) && config.dailyDirectLimit >= 0
      ? Math.min(config.dailyDirectLimit, LOTTERY_CONFIG_MAX_DAILY_LIMIT)
      : fallback.dailyDirectLimit,
    tiers,
  };
}

function fallbackTierId(tierValue: number): string {
  const matched = DEFAULT_TIERS.find((tier) => tier.value === tierValue);
  if (matched) return matched.id;
  return `tier_${Math.max(1, Math.floor(tierValue))}`;
}

function normalizeLotteryRecord(rawRecord: StoredLotteryRecord): LotteryRecord | null {
  const id = typeof rawRecord.id === "string" ? rawRecord.id.trim() : "";
  const linuxdoIdRaw = typeof rawRecord.linuxdoId === "string"
    ? rawRecord.linuxdoId
    : typeof rawRecord.oderId === "string"
      ? rawRecord.oderId
      : "";
  const linuxdoId = linuxdoIdRaw.trim();
  const username = typeof rawRecord.username === "string" ? rawRecord.username : "";
  const tierName = typeof rawRecord.tierName === "string" ? rawRecord.tierName : "";
  const tierValue = Number(rawRecord.tierValue);
  const createdAt = Number(rawRecord.createdAt);

  if (!id || !linuxdoId || !tierName) return null;
  if (!Number.isFinite(tierValue) || !Number.isFinite(createdAt)) return null;

  const tierId = typeof rawRecord.tierId === "string" && rawRecord.tierId.trim()
    ? rawRecord.tierId
    : fallbackTierId(tierValue);
  const directCredit = typeof rawRecord.directCredit === "boolean" ? rawRecord.directCredit : false;
  const creditedQuota = Number(rawRecord.creditedQuota);

  return {
    id,
    linuxdoId,
    username,
    tierId,
    tierName,
    tierValue,
    directCredit,
    creditedQuota: Number.isFinite(creditedQuota) ? creditedQuota : undefined,
    createdAt,
  };
}

function normalizeLotteryRecords(records: StoredLotteryRecord[]): LotteryRecord[] {
  const normalized: LotteryRecord[] = [];
  for (const record of records) {
    const parsed = normalizeLotteryRecord(record);
    if (parsed) normalized.push(parsed);
  }
  return normalized;
}

function getTodayRecordsDayKey(): string {
  return `${LOTTERY_RECORDS_DAY_PREFIX}${getTodayDateString()}`;
}

function toSafePositiveNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

async function ensureTotalRecordsCounterInitialized(): Promise<void> {
  if (!totalRecordsInitPromise) {
    totalRecordsInitPromise = (async () => {
      const current = await kv.get<number>(LOTTERY_RECORDS_TOTAL_KEY);
      if (toSafePositiveNumber(current) !== null) return;
      const legacyTotal = await kv.llen(LOTTERY_RECORDS_KEY);
      await kv.set(LOTTERY_RECORDS_TOTAL_KEY, legacyTotal, { nx: true });
    })().catch((error) => {
      totalRecordsInitPromise = null;
      throw error;
    });
  }
  await totalRecordsInitPromise;
}

async function incrementTotalRecordsCounter(): Promise<void> {
  await ensureTotalRecordsCounterInitialized();
  await kv.incr(LOTTERY_RECORDS_TOTAL_KEY);
}

async function appendLotteryRecord(record: LotteryRecord, linuxdoId: number): Promise<void> {
  const userRecordsKey = `${LOTTERY_USER_RECORDS_PREFIX}${linuxdoId}`;
  const dayKey = getTodayRecordsDayKey();

  try {
    await kv.lpush(LOTTERY_RECORDS_RECENT_KEY, record);
    await kv.ltrim(LOTTERY_RECORDS_RECENT_KEY, 0, RECORDS_RECENT_MAX_LENGTH - 1);
  } catch {
    // ignore
  }

  try {
    await kv.lpush(dayKey, record);
    await kv.expire(dayKey, RECORDS_DAY_ARCHIVE_TTL_SECONDS);
  } catch {
    // ignore
  }

  try {
    await kv.lpush(userRecordsKey, record);
    await kv.ltrim(userRecordsKey, 0, USER_RECORDS_MAX_LENGTH - 1);
  } catch {
    // ignore
  }

  try {
    await incrementTotalRecordsCounter();
  } catch {
    // ignore
  }
}

async function getLegacyTodayLotteryRecords(maxScan: number): Promise<LotteryRecord[]> {
  const todayStart = getChinaDayStartTimestamp();
  const todayRecords: LotteryRecord[] = [];
  let offset = 0;

  while (offset < maxScan) {
    const batchRaw = await kv.lrange<StoredLotteryRecord>(
      LOTTERY_RECORDS_KEY,
      offset,
      offset + TODAY_RECORDS_SCAN_BATCH - 1
    );
    if (batchRaw.length === 0) break;

    const batchRecords = normalizeLotteryRecords(batchRaw);
    for (const record of batchRecords) {
      if (record.createdAt < todayStart) {
        return todayRecords;
      }
      todayRecords.push(record);
    }

    offset += batchRaw.length;
    if (batchRaw.length < TODAY_RECORDS_SCAN_BATCH) break;
  }

  return todayRecords;
}

async function migrateLegacyTodayRecords(dayKey: string, records: LotteryRecord[]): Promise<void> {
  if (records.length === 0) return;

  // 旧列表是“最新在前”，迁移到新列表时倒序 lpush 才能保持同样顺序。
  const reversed = [...records].reverse();
  for (let index = 0; index < reversed.length; index += RECORDS_MIGRATION_CHUNK_SIZE) {
    const chunk = reversed.slice(index, index + RECORDS_MIGRATION_CHUNK_SIZE);
    await kv.lpush(dayKey, ...chunk);
  }
  await kv.expire(dayKey, RECORDS_DAY_ARCHIVE_TTL_SECONDS);
}

async function getTotalRecordsCount(): Promise<number> {
  try {
    await ensureTotalRecordsCounterInitialized();
    const total = await kv.get<number>(LOTTERY_RECORDS_TOTAL_KEY);
    const safe = toSafePositiveNumber(total);
    if (safe !== null) return safe;
  } catch {
    // ignore
  }

  try {
    return await kv.llen(LOTTERY_RECORDS_RECENT_KEY);
  } catch {
    return 0;
  }
}

export async function getLotteryConfig(): Promise<LotteryConfig> {
  const fallback = cloneDefaultLotteryConfig();
  try {
    const config = await kv.get<Partial<LotteryConfig>>(LOTTERY_CONFIG_KEY);
    if (!config) {
      try {
        await kv.set(LOTTERY_CONFIG_KEY, fallback);
      } catch {
        // ignore
      }
      return fallback;
    }
    return sanitizeLotteryConfig(config);
  } catch {
    return fallback;
  }
}

export async function updateLotteryConfig(config: Partial<LotteryConfig>): Promise<void> {
  const lockKey = `${LOTTERY_CONFIG_KEY}:lock`;
  const lockToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const locked = await kv.set(lockKey, lockToken, { nx: true, ex: 5 });
  if (locked !== "OK") {
    throw new Error("配置更新冲突，请稍后重试");
  }

  try {
    const current = await getLotteryConfig();
    await kv.set(LOTTERY_CONFIG_KEY, { ...current, ...config });
  } finally {
    const releaseLua = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    try {
      await kv.eval(releaseLua, [lockKey], [lockToken]);
    } catch {
      // ignore
    }
  }
}

export async function tryClaimDailyFree(linuxdoId: number, today?: string): Promise<boolean> {
  const day = today ?? getTodayDateString();
  const key = `${LOTTERY_DAILY_PREFIX}${linuxdoId}:${day}`;
  const ttl = getSecondsUntilMidnight();
  const result = await kv.set(key, "1", { nx: true, ex: ttl });
  return result === "OK";
}

export async function releaseDailyFree(linuxdoId: number, today?: string): Promise<void> {
  const day = today ?? getTodayDateString();
  const key = `${LOTTERY_DAILY_PREFIX}${linuxdoId}:${day}`;
  await kv.del(key);
}

export async function checkDailyLimit(linuxdoId: number): Promise<boolean> {
  const today = getTodayDateString();
  const key = `${LOTTERY_DAILY_PREFIX}${linuxdoId}:${today}`;
  const result = await kv.get(key);
  return result !== null;
}

export async function getTodayDirectTotal(): Promise<number> {
  const today = getTodayDateString();
  const totalCents = await kv.get<number>(`${LOTTERY_DAILY_DIRECT_KEY}${today}`);
  return (totalCents || 0) / DIRECT_AMOUNT_SCALE;
}

export async function reserveDailyDirectQuota(dollars: number, today?: string): Promise<{ success: boolean; newTotal: number }> {
  const config = await getLotteryConfig();
  const day = today ?? getTodayDateString();
  const key = `${LOTTERY_DAILY_DIRECT_KEY}${day}`;
  const ttl = getSecondsUntilMidnight() + 3600;
  const cents = Math.round(dollars * DIRECT_AMOUNT_SCALE);
  const limitCents = Math.round(config.dailyDirectLimit * DIRECT_AMOUNT_SCALE);

  if (cents <= 0) {
    return { success: false, newTotal: await getTodayDirectTotal() };
  }

  const luaScript = `
    local key = KEYS[1]
    local cents = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local ttl = tonumber(ARGV[3])
    local newTotal = redis.call('INCRBY', key, cents)
    if redis.call('TTL', key) == -1 then
      redis.call('EXPIRE', key, ttl)
    end
    if newTotal > limit then
      redis.call('DECRBY', key, cents)
      return {0, newTotal - cents}
    end
    return {1, newTotal}
  `;

  const result = await kv.eval(luaScript, [key], [cents, limitCents, ttl]) as [number, number];
  const [success, newTotalCents] = result;
  return { success: success === 1, newTotal: (newTotalCents || 0) / DIRECT_AMOUNT_SCALE };
}

export async function rollbackDailyDirectQuota(dollars: number, today?: string): Promise<void> {
  const day = today ?? getTodayDateString();
  const key = `${LOTTERY_DAILY_DIRECT_KEY}${day}`;
  const cents = Math.round(dollars * DIRECT_AMOUNT_SCALE);
  if (cents <= 0) return;
  await kv.decrby(key, cents);
}

function weightedRandomSelect(tiers: LotteryTier[]): LotteryTier | null {
  const totalWeight = tiers.reduce((sum, tier) => sum + tier.probability, 0);
  if (totalWeight <= 0) return null;
  let random = Math.random() * totalWeight;
  for (const tier of tiers) {
    random -= tier.probability;
    if (random <= 0) return tier;
  }
  return tiers[tiers.length - 1];
}

export async function spinLotteryDirect(
  linuxdoId: number,
  username: string,
  newApiUserId: number
): Promise<{ success: boolean; record?: LotteryRecord; message: string; uncertain?: boolean }> {
  const { creditQuotaToUser } = await import("./new-api");

  // 在开头锁定日期，确保回滚操作使用与预留相同的 day key
  const today = getTodayDateString();

  let usedDailyFree = false;
  try {
    const dailyResult = await tryClaimDailyFree(linuxdoId, today);
    if (!dailyResult) {
      return { success: false, message: "今日免费次数已用完，明天再来吧" };
    }
    usedDailyFree = true;
  } catch {
    return { success: false, message: "系统繁忙，请稍后再试" };
  }

  const rollbackSpinCount = async () => {
    if (usedDailyFree) {
      try {
        await releaseDailyFree(linuxdoId, today);
      } catch {
        // ignore
      }
    }
  };

  let reservedDollars = 0;

  try {
    const config = await getLotteryConfig();
    if (!config.enabled) {
      await rollbackSpinCount();
      return { success: false, message: "抽奖活动暂未开放" };
    }

    const todayTotal = await getTodayDirectTotal();
    const remainingQuota = config.dailyDirectLimit - todayTotal;
    const affordableTiers = config.tiers.filter((tier) => tier.probability > 0 && tier.value <= remainingQuota);

    if (affordableTiers.length === 0) {
      await rollbackSpinCount();
      return { success: false, message: "今日发放额度已达上限，请明日再试" };
    }

    const selectedTier = weightedRandomSelect(affordableTiers);
    if (!selectedTier) {
      await rollbackSpinCount();
      return { success: false, message: "抽奖配置异常，请联系管理员" };
    }

    const reserveResult = await reserveDailyDirectQuota(selectedTier.value, today);
    if (!reserveResult.success) {
      await rollbackSpinCount();
      return { success: false, message: "今日发放额度已达上限，请明日再试" };
    }
    reservedDollars = selectedTier.value;

    const creditResult = await creditQuotaToUser(newApiUserId, selectedTier.value);

    if (creditResult.uncertain) {
      console.warn("直充结果不确定，不回滚:", creditResult.message);
      const pendingRecord: LotteryRecord = {
        id: `lottery_pending_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        linuxdoId: String(linuxdoId),
        username,
        tierId: selectedTier.id,
        tierName: `[待确认] ${selectedTier.name}`,
        tierValue: selectedTier.value,
        directCredit: true,
        createdAt: Date.now(),
      };
      try {
        await appendLotteryRecord(pendingRecord, linuxdoId);
      } catch {
        // ignore
      }
      // 存储到 pending 队列，供后续对账验证
      await storePendingRecord({
        record: pendingRecord,
        newApiUserId,
        expectedQuota: creditResult.newQuota ?? 0,
        reservationDay: today,
        storedAt: Date.now(),
      });
      return { success: false, message: "充值结果不确定，请稍后检查余额", uncertain: true };
    }

    if (!creditResult.success) {
      await rollbackDailyDirectQuota(reservedDollars, today);
      await rollbackSpinCount();
      return { success: false, message: "充值失败，请稍后重试" };
    }

    const record: LotteryRecord = {
      id: `lottery_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      linuxdoId: String(linuxdoId),
      username,
      tierId: selectedTier.id,
      tierName: selectedTier.name,
      tierValue: selectedTier.value,
      directCredit: true,
      creditedQuota: creditResult.newQuota,
      createdAt: Date.now(),
    };

    try {
      await appendLotteryRecord(record, linuxdoId);
    } catch {
      // ignore
    }

    return {
      success: true,
      record,
      message: `恭喜获得 ${selectedTier.name}！已直接充值到您的账户`,
    };
  } catch (error) {
    console.error("spinLotteryDirect 异常:", error);
    if (reservedDollars > 0) {
      await rollbackDailyDirectQuota(reservedDollars, today);
    }
    await rollbackSpinCount();
    return { success: false, message: "系统错误，请稍后再试" };
  }
}

export async function getLotteryRecords(limit: number = 50, offset: number = 0): Promise<LotteryRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const safeOffset = Math.max(0, offset);
  const latestRaw = await kv.lrange<StoredLotteryRecord>(
    LOTTERY_RECORDS_RECENT_KEY,
    safeOffset,
    safeOffset + safeLimit - 1
  );
  if (latestRaw.length > 0) {
    return normalizeLotteryRecords(latestRaw);
  }

  // 兼容旧版本数据（仍在 lottery:records）
  const legacyRaw = await kv.lrange<StoredLotteryRecord>(
    LOTTERY_RECORDS_KEY,
    safeOffset,
    safeOffset + safeLimit - 1
  );
  return normalizeLotteryRecords(legacyRaw);
}

export async function getUserLotteryRecords(linuxdoId: number, limit: number = 20): Promise<LotteryRecord[]> {
  const rawRecords = await kv.lrange<StoredLotteryRecord>(`${LOTTERY_USER_RECORDS_PREFIX}${linuxdoId}`, 0, limit - 1);
  return normalizeLotteryRecords(rawRecords);
}

export async function getTodayLotteryRecords(options?: {
  includePending?: boolean;
  maxScan?: number;
}): Promise<LotteryRecord[]> {
  const includePending = options?.includePending ?? true;
  const maxScan = Math.max(TODAY_RECORDS_SCAN_BATCH, options?.maxScan ?? TODAY_RECORDS_MAX_SCAN);
  const dayKey = getTodayRecordsDayKey();
  const todayRaw = await kv.lrange<StoredLotteryRecord>(dayKey, 0, maxScan - 1);
  let todayRecords = normalizeLotteryRecords(todayRaw);

  // 兼容旧版本：当天分桶为空时，最多回退扫描一次旧 key，避免每次请求都全量扫描。
  if (todayRecords.length === 0) {
    const today = getTodayDateString();
    const fallbackCheckedKey = `${LOTTERY_RECORDS_LEGACY_FALLBACK_CHECK_PREFIX}${today}`;
    const checked = await kv.get<string>(fallbackCheckedKey);
    if (!checked) {
      todayRecords = await getLegacyTodayLotteryRecords(maxScan);
      if (todayRecords.length > 0) {
        try {
          await migrateLegacyTodayRecords(dayKey, todayRecords);
        } catch {
          // ignore
        }
      }
      try {
        await kv.set(fallbackCheckedKey, "1", { ex: getSecondsUntilMidnight() + 3600 });
      } catch {
        // ignore
      }
    }
  }

  if (!includePending) {
    return todayRecords.filter((record) => !record.tierName.startsWith("[待确认]"));
  }

  return todayRecords;
}

export async function getLotteryStats(): Promise<{
  todayDirectTotal: number;
  todayUsers: number;
  todaySpins: number;
  totalRecords: number;
}> {
  const [todayDirectTotal, totalRecords, todayRecords] = await Promise.all([
    getTodayDirectTotal(),
    getTotalRecordsCount(),
    getTodayLotteryRecords({ includePending: false }),
  ]);

  return {
    todayDirectTotal,
    todayUsers: new Set(todayRecords.map((record) => record.linuxdoId)).size,
    todaySpins: todayRecords.length,
    totalRecords,
  };
}

// ─── Pending records 对账 ───

async function storePendingRecord(pending: PendingLotteryRecord): Promise<void> {
  try {
    await kv.lpush(LOTTERY_PENDING_RECORDS_KEY, pending);
    await kv.ltrim(LOTTERY_PENDING_RECORDS_KEY, 0, 99);
  } catch {
    // ignore
  }
}

export async function getPendingRecordCount(): Promise<number> {
  try {
    return await kv.llen(LOTTERY_PENDING_RECORDS_KEY);
  } catch {
    return 0;
  }
}

/**
 * 对账：验证所有 pending 记录的充值是否到账。
 * - 已确认到账：从 pending 列表移除
 * - 确认失败：回滚日额度和每日免费次数，从 pending 列表移除
 * - 仍不确定或查询失败：保留在 pending 列表
 * - 超过 24 小时：视为过期移除（避免无限堆积）
 */
export async function reconcilePendingRecords(): Promise<{
  processed: number;
  confirmed: number;
  failed: number;
  expired: number;
  stillPending: number;
}> {
  const { checkUserQuota } = await import("./new-api");

  const allPending = await kv.lrange<PendingLotteryRecord>(LOTTERY_PENDING_RECORDS_KEY, 0, -1);
  if (allPending.length === 0) {
    return { processed: 0, confirmed: 0, failed: 0, expired: 0, stillPending: 0 };
  }

  const now = Date.now();
  let confirmed = 0;
  let failed = 0;
  let expired = 0;
  const remaining: PendingLotteryRecord[] = [];

  for (const pending of allPending) {
    if (!pending || !pending.record || typeof pending.newApiUserId !== "number") {
      expired++;
      continue;
    }

    // 超过 24h 视为过期
    if (now - (pending.storedAt || 0) > PENDING_RECORDS_MAX_AGE_MS) {
      expired++;
      console.warn("[reconcile] 过期 pending 记录:", pending.record.id);
      continue;
    }

    try {
      const quotaResult = await checkUserQuota(pending.newApiUserId);
      if (!quotaResult.success) {
        remaining.push(pending);
        continue;
      }

      if (typeof quotaResult.quota === "number" && quotaResult.quota >= pending.expectedQuota) {
        confirmed++;
        console.log("[reconcile] 已确认到账:", pending.record.id);
      } else {
        failed++;
        console.log("[reconcile] 确认未到账，回滚:", pending.record.id);
        try {
          await rollbackDailyDirectQuota(pending.record.tierValue, pending.reservationDay);
        } catch {
          // ignore
        }
        try {
          await releaseDailyFree(Number(pending.record.linuxdoId), pending.reservationDay);
        } catch {
          // ignore
        }
      }
    } catch {
      remaining.push(pending);
    }
  }

  // 用未解决的记录替换原列表
  try {
    await kv.del(LOTTERY_PENDING_RECORDS_KEY);
    if (remaining.length > 0) {
      for (const item of remaining) {
        await kv.lpush(LOTTERY_PENDING_RECORDS_KEY, item);
      }
    }
  } catch {
    // ignore
  }

  return {
    processed: allPending.length,
    confirmed,
    failed,
    expired,
    stillPending: remaining.length,
  };
}
