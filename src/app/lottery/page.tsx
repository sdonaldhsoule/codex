'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Gift, Loader2, Sparkles, History,
  User as UserIcon, LogOut, Trophy, AlertCircle, Crown, Star, Zap, ChevronRight
} from 'lucide-react';

const TIER_ICONS = ['🌱', '💧', '🔥', '🌸', '🔮', '💎', '🎁', '🎉', '✨'];

const RANKING_POLL_INTERVAL_MS = 15000;
const RANKING_MAX_BACKOFF_MS = 120000;

interface UserData {
  linuxdoId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  isAdmin: boolean;
}

interface LotteryRecord {
  id: string;
  tierId?: string;
  tierName: string;
  tierValue: number;
  directCredit?: boolean;
  createdAt: number;
}

interface LotteryTier {
  id: string;
  name: string;
  value: number;
  probability: number;
  color: string;
}

interface WheelTier extends LotteryTier {
  startAngle: number;
  endAngle: number;
}

interface RankingUser {
  rank: number;
  userId: string;
  username: string;
  totalValue: number;
  bestPrize: string;
  count: number;
}

export default function LotteryPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<LotteryRecord[]>([]);
  const [canSpin, setCanSpin] = useState(false);
  const [hasSpunToday, setHasSpunToday] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState<{ name: string; value?: number } | null>(null);
  const [showResultModal, setShowResultModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ranking, setRanking] = useState<RankingUser[]>([]);
  const [rankingLoading, setRankingLoading] = useState(true);
  const [tiers, setTiers] = useState<LotteryTier[]>([]);

  const wheelTiers = useMemo<WheelTier[]>(() => {
    if (tiers.length === 0) return [];
    const totalWeight = tiers.reduce((sum, tier) => sum + Math.max(0, Number(tier.probability) || 0), 0);
    const safeTotalWeight = totalWeight > 0 ? totalWeight : tiers.length;
    let currentAngle = 0;

    return tiers.map((tier, index) => {
      const weight = totalWeight > 0 ? Math.max(0, Number(tier.probability) || 0) : 1;
      const slice = index === tiers.length - 1 ? 360 - currentAngle : (weight / safeTotalWeight) * 360;
      const startAngle = currentAngle;
      const endAngle = startAngle + slice;
      currentAngle = endAngle;
      return { ...tier, startAngle, endAngle };
    });
  }, [tiers]);

  const tierVisualMap = useMemo(() => {
    const map = new Map<string, { icon: string; textClass: string; color: string }>();
    wheelTiers.forEach((tier, index) => {
      const textClass = tier.value >= 15
        ? 'text-red-700'
        : tier.value >= 10
          ? 'text-pink-700'
          : tier.value >= 5
            ? 'text-amber-700'
            : tier.value >= 3
              ? 'text-blue-700'
              : 'text-green-700';
      map.set(tier.id, {
        icon: TIER_ICONS[index % TIER_ICONS.length],
        textClass,
        color: tier.color,
      });
    });
    return map;
  }, [wheelTiers]);

  const getTierVisual = useCallback((tierId?: string, tierValue?: number) => {
    if (tierId && tierVisualMap.has(tierId)) {
      return tierVisualMap.get(tierId)!;
    }
    if (tierValue !== undefined) {
      const tierByValue = wheelTiers.find((tier) => tier.value === tierValue);
      if (tierByValue && tierVisualMap.has(tierByValue.id)) {
        return tierVisualMap.get(tierByValue.id)!;
      }
    }
    return { icon: '🎁', textClass: 'text-stone-700', color: '#a8a29e' };
  }, [tierVisualMap, wheelTiers]);

  const spinTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const confettiFrameRef = useRef<number | null>(null);
  const confettiEndTimeRef = useRef<number>(0);
  const rankingPollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rankingInFlightRef = useRef(false);
  const rankingFailCountRef = useRef(0);
  const rankingUnmountedRef = useRef(false);

  useEffect(() => {
    rankingUnmountedRef.current = false;
    return () => {
      rankingUnmountedRef.current = true;
      rankingInFlightRef.current = false;
      if (spinTimeoutRef.current) { clearTimeout(spinTimeoutRef.current); spinTimeoutRef.current = null; }
      if (confettiFrameRef.current) { cancelAnimationFrame(confettiFrameRef.current); confettiFrameRef.current = null; }
      if (rankingPollTimeoutRef.current) { clearTimeout(rankingPollTimeoutRef.current); rankingPollTimeoutRef.current = null; }
    };
  }, []);

  const clearRankingPollTimer = useCallback(() => {
    if (rankingPollTimeoutRef.current) {
      clearTimeout(rankingPollTimeoutRef.current);
      rankingPollTimeoutRef.current = null;
    }
  }, []);

  const getRankingBackoffDelay = useCallback((failCount: number) => {
    const level = Math.min(Math.max(failCount, 0), 3);
    return Math.min(RANKING_POLL_INTERVAL_MS * (2 ** level), RANKING_MAX_BACKOFF_MS);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const userRes = await fetch('/api/auth/me');
      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData.success) {
          setUser(userData.user);
          const recordsRes = await fetch('/api/lottery/records');
          if (recordsRes.ok) {
            const recordsData = await recordsRes.json();
            if (recordsData.success) setRecords(recordsData.records || []);
          }
        } else {
          router.push('/login');
          return;
        }
      } else {
        router.push('/login');
        return;
      }

      const lotteryRes = await fetch('/api/lottery');
      if (lotteryRes.ok) {
        const data = await lotteryRes.json();
        if (data.success) {
          setCanSpin(data.canSpin);
          setHasSpunToday(data.hasSpunToday || false);
          setTiers(Array.isArray(data.tiers) ? data.tiers : []);
        }
      }
    } catch (err) {
      console.error('加载失败', err);
      setError('网络连接失败');
    } finally {
      setLoading(false);
    }
  }, [router]);

  const fetchRanking = useCallback(async () => {
    if (rankingUnmountedRef.current || rankingInFlightRef.current) return;
    rankingInFlightRef.current = true;
    let fetchOk = false;

    try {
      const res = await fetch('/api/lottery/ranking?limit=10', { cache: 'no-store' });
      if (!res.ok) throw new Error('排行榜请求失败');
      const data = await res.json();
      if (!data.success) throw new Error(data.message || '排行榜失败');
      if (!rankingUnmountedRef.current) setRanking(data.ranking || []);
      rankingFailCountRef.current = 0;
      fetchOk = true;
    } catch (err) {
      rankingFailCountRef.current += 1;
      console.error('获取排行榜失败', err);
    } finally {
      rankingInFlightRef.current = false;
      if (!rankingUnmountedRef.current) setRankingLoading(false);
      clearRankingPollTimer();
      if (!rankingUnmountedRef.current && document.visibilityState === 'visible') {
        const nextDelay = fetchOk ? RANKING_POLL_INTERVAL_MS : getRankingBackoffDelay(rankingFailCountRef.current);
        rankingPollTimeoutRef.current = setTimeout(() => {
          if (!rankingUnmountedRef.current) void fetchRanking();
        }, nextDelay);
      }
    }
  }, [clearRankingPollTimer, getRankingBackoffDelay]);

  useEffect(() => {
    void fetchData();
    void fetchRanking();
    const onVisibilityChange = () => {
      if (rankingUnmountedRef.current) return;
      if (document.visibilityState === 'visible') {
        rankingFailCountRef.current = 0;
        clearRankingPollTimer();
        void fetchRanking();
      } else {
        clearRankingPollTimer();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearRankingPollTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [clearRankingPollTimer, fetchData, fetchRanking]);

  const handleSpin = async () => {
    if (!canSpin || wheelTiers.length === 0 || spinning) return;
    setSpinning(true);
    setError(null);

    try {
      const res = await fetch('/api/lottery/spin', { method: 'POST' });
      const data = await res.json();

      if (data.success) {
        const prize = wheelTiers.find((tier) => tier.id === data.record.tierId)
          || wheelTiers.find((tier) => tier.value === Number(data.record.tierValue));
        if (prize) {
          const normalize = (deg: number) => ((deg % 360) + 360) % 360;
          const centerAngle = (prize.startAngle + prize.endAngle) / 2;
          const targetAngle = normalize(360 - centerAngle);

          setRotation(prev => {
            const current = normalize(prev);
            const desired = targetAngle;
            const delta = normalize(desired - current);
            return prev + 360 * 12 + delta;
          });

          spinTimeoutRef.current = setTimeout(async () => {
            setSpinning(false);
            setResult({ name: data.record.tierName, value: data.record.tierValue });
            setShowResultModal(true);

            try {
              const lotteryRes = await fetch('/api/lottery');
              if (lotteryRes.ok) {
                const lotteryData = await lotteryRes.json();
                if (lotteryData.success) {
                  setCanSpin(lotteryData.canSpin);
                  setHasSpunToday(lotteryData.hasSpunToday || false);
                  setTiers(Array.isArray(lotteryData.tiers) ? lotteryData.tiers : []);
                }
              }
              const recordsRes = await fetch('/api/lottery/records');
              if (recordsRes.ok) {
                const recordsData = await recordsRes.json();
                if (recordsData.success) setRecords(recordsData.records || []);
              }
              await fetchRanking();
            } catch (err) {
              console.error('刷新状态失败', err);
            }

            import('canvas-confetti').then(({ default: confetti }) => {
              const duration = 2500;
              confettiEndTimeRef.current = Date.now() + duration;
              let lastFrame = 0;
              const throttleMs = 80;
              const frame = (timestamp: number) => {
                if (timestamp - lastFrame >= throttleMs) {
                  lastFrame = timestamp;
                  confetti({ particleCount: 6, angle: 60, spread: 55, origin: { x: 0 }, shapes: ['circle'], colors: ['#fbbf24', '#f97316', '#ec4899', '#a78bfa', '#34d399', '#60a5fa'], disableForReducedMotion: true, drift: 0, ticks: 150 });
                  confetti({ particleCount: 6, angle: 120, spread: 55, origin: { x: 1 }, shapes: ['circle'], colors: ['#fbbf24', '#f97316', '#ec4899', '#a78bfa', '#34d399', '#60a5fa'], disableForReducedMotion: true, drift: 0, ticks: 150 });
                }
                if (Date.now() < confettiEndTimeRef.current) {
                  confettiFrameRef.current = requestAnimationFrame(frame);
                }
              };
              confettiFrameRef.current = requestAnimationFrame(frame);
            });
          }, 6000);
        } else {
          setSpinning(false);
          setError('系统错误：未知奖品');
        }
      } else {
        setError(data.message || '抽奖失败');
        setSpinning(false);
        // 刷新抽奖状态，避免按钮和实际状态不同步
        try {
          const lotteryRes = await fetch('/api/lottery');
          if (lotteryRes.ok) {
            const lotteryData = await lotteryRes.json();
            if (lotteryData.success) {
              setCanSpin(lotteryData.canSpin);
              setHasSpunToday(lotteryData.hasSpunToday || false);
              setTiers(Array.isArray(lotteryData.tiers) ? lotteryData.tiers : []);
            }
          }
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.error(err);
      setError('抽奖请求失败，请稍后重试');
      setSpinning(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  };

  const getConicGradient = () => {
    if (wheelTiers.length === 0) {
      return 'conic-gradient(#e7e5e4 0deg 360deg)';
    }
    let stops = '';
    wheelTiers.forEach((tier, index) => {
      stops += `${tier.color} ${tier.startAngle}deg ${tier.endAngle}deg${index < wheelTiers.length - 1 ? ', ' : ''}`;
    });
    return `conic-gradient(${stops})`;
  };

  const canSpinNow = canSpin && wheelTiers.length > 0;
  const spinButtonText = spinning ? 'WISHING...' : canSpinNow ? 'GO LUCKY' : (canSpin ? '配置中' : '明日再来');
  const spinHintText = canSpinNow ? '点击按钮开始抽奖' : (canSpin ? '奖池配置中，请稍后刷新' : '今日机会已用完，明天再来');

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#fdfcf8] gap-4">
        <Loader2 className="w-12 h-12 animate-spin text-orange-500" />
        <p className="text-stone-400 font-medium animate-pulse">正在准备惊喜...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fdfcf8] overflow-x-hidden pb-20">
      {/* 导航栏 */}
      <nav className="sticky top-0 z-40 glass border-b border-white/40 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex justify-between items-center h-[72px]">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-gradient-to-br from-orange-100 to-amber-50 rounded-xl shadow-glow-gold border border-orange-100">
                <Sparkles className="w-5 h-5 text-orange-500 fill-orange-500" />
              </div>
              <span className="font-black text-stone-700 text-lg tracking-tight">Codex 福利站</span>
            </div>

            {user && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-1.5 py-1.5 pr-4 bg-white/60 rounded-full border border-white/60 shadow-sm">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white shadow-inner">
                    <UserIcon className="w-4 h-4" />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-bold text-stone-700 text-xs leading-none mb-0.5">{user.displayName}</span>
                    <span className="text-[10px] text-stone-400 font-medium leading-none">@{user.username}</span>
                  </div>
                </div>
                {user.isAdmin && (
                  <a href="/admin" className="px-3 py-1.5 bg-violet-50 text-violet-700 rounded-full text-xs font-bold border border-violet-200 hover:bg-violet-100 transition-colors">
                    管理
                  </a>
                )}
                <button onClick={handleLogout} className="p-2.5 text-stone-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all" title="退出登录">
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* 标题区 */}
        <div className="text-center mb-12 animate-fade-in relative">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[100px] bg-orange-300/20 blur-[60px] -z-10"></div>
          <div className="inline-flex items-center justify-center p-3 bg-gradient-to-br from-orange-100 to-amber-50 rounded-2xl mb-4 shadow-glow-gold rotate-3 border border-orange-100">
            <Sparkles className="w-8 h-8 text-orange-500 fill-orange-500 animate-pulse" />
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-black text-stone-700 tracking-tight mb-4 drop-shadow-sm">
            每日<span className="text-gradient-primary relative inline-block">
              幸运抽奖
              <svg className="absolute -bottom-2 left-0 w-full h-3 text-orange-400 opacity-50" viewBox="0 0 100 10" preserveAspectRatio="none">
                <path d="M0 5 Q 50 10 100 5" stroke="currentColor" strokeWidth="3" fill="none" />
              </svg>
            </span>
          </h1>
          <p className="text-lg text-stone-500 max-w-lg mx-auto font-medium">
            赢取最高 <span className="text-red-500 font-bold bg-red-50 px-1 rounded">$20</span> API 额度直充，
            <span className="text-orange-600 font-bold">100% 中奖概率</span>
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_320px] gap-8 lg:gap-10 items-start">

          {/* 左侧：排行榜 */}
          <div className="order-2 lg:order-1 space-y-6">
            <div className="glass-card rounded-3xl p-6 w-full animate-fade-in" style={{ animationDelay: '0.1s' }}>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 bg-yellow-100 rounded-xl text-yellow-600 shadow-inner">
                    <Crown className="w-5 h-5 fill-yellow-600" />
                  </div>
                  <h2 className="text-lg font-bold text-stone-700">今日欧皇榜</h2>
                </div>
                <div className="px-2 py-0.5 bg-green-100 text-green-700 text-[10px] font-bold rounded-full uppercase tracking-wider">Live</div>
              </div>

              {rankingLoading ? (
                <div className="flex flex-col items-center justify-center py-10 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
                  <span className="text-xs text-stone-400">正在同步数据...</span>
                </div>
              ) : ranking.length === 0 ? (
                <div className="text-center py-12 text-stone-400 bg-stone-50/50 rounded-2xl border border-stone-100 border-dashed">
                  <Trophy className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm font-medium">虚位以待</p>
                </div>
              ) : (
                <div className="space-y-3 relative">
                  <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-stone-100 -z-10"></div>
                  {ranking.map((u, index) => (
                    <div key={u.userId} className={`flex items-center gap-3 p-3 rounded-2xl transition-all hover:scale-[1.02] ${
                      index === 0 ? 'bg-gradient-to-r from-yellow-50 to-amber-50 border border-yellow-200 shadow-sm' :
                      index === 1 ? 'bg-gradient-to-r from-stone-50 to-gray-50 border border-stone-200' :
                      index === 2 ? 'bg-gradient-to-r from-orange-50 to-red-50 border border-orange-200' :
                      'bg-white border border-transparent hover:border-stone-100 hover:bg-stone-50'
                    }`}>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-black shrink-0 shadow-sm border-2 border-white ${
                        index === 0 ? 'bg-yellow-400 text-white' :
                        index === 1 ? 'bg-stone-400 text-white' :
                        index === 2 ? 'bg-orange-400 text-white' :
                        'bg-stone-100 text-stone-400'
                      }`}>{u.rank}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="font-bold text-stone-700 text-sm truncate pr-2">{u.username}</div>
                          {index === 0 && <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />}
                        </div>
                        <div className="text-xs text-stone-400 flex items-center gap-1">
                          <Zap className="w-3 h-3" />{u.count}次
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`font-black text-sm ${
                          index === 0 ? 'text-yellow-600' : index === 1 ? 'text-stone-600' : index === 2 ? 'text-orange-600' : 'text-stone-500'
                        }`}>${u.totalValue}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 中间：转盘 */}
          <div className="flex flex-col items-center order-1 lg:order-2 animate-scale-in">
            <div className="relative group perspective-1000">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] bg-orange-500/10 blur-[80px] rounded-full animate-pulse-glow -z-10"></div>

              <div className="relative w-[340px] h-[340px] sm:w-[400px] sm:h-[400px] md:w-[440px] md:h-[440px]">
                {/* 外圈花瓣装饰 */}
                <div
                  className="absolute inset-0 bg-gradient-to-br from-white to-pink-50 drop-shadow-xl will-change-auto"
                  style={{
                    clipPath: 'polygon(50% 0%, 61% 5%, 65% 15%, 75% 10%, 80% 20%, 90% 15%, 93% 25%, 100% 25%, 98% 38%, 100% 50%, 98% 62%, 100% 75%, 93% 75%, 90% 85%, 80% 80%, 75% 90%, 65% 85%, 61% 95%, 50% 100%, 39% 95%, 35% 85%, 25% 90%, 20% 80%, 10% 85%, 7% 75%, 0% 75%, 2% 62%, 0% 50%, 2% 38%, 0% 25%, 7% 25%, 10% 15%, 20% 20%, 25% 10%, 35% 15%, 39% 5%)',
                    transform: 'translateZ(0)'
                  }}
                ></div>

                {/* 内圈边框 */}
                <div className="absolute inset-3 rounded-full bg-gradient-to-tr from-orange-400 to-amber-300 shadow-inner p-1">
                  <div className="w-full h-full rounded-full bg-gradient-to-br from-pink-200 via-orange-100 to-amber-200 shadow-[inset_0_4px_12px_rgba(251,146,60,0.2)]"></div>
                </div>

                {/* 转盘主体 */}
                <div
                  className="absolute inset-[20px] rounded-full overflow-hidden border-4 border-white/20 will-change-transform"
                  style={{
                    background: getConicGradient(),
                    transform: `rotate(${rotation}deg) translateZ(0)`,
                    transition: spinning ? 'transform 6s cubic-bezier(0.25, 0.1, 0.25, 1)' : 'none',
                    boxShadow: 'inset 0 0 40px rgba(0,0,0,0.2)',
                    backfaceVisibility: 'hidden'
                  }}
                >
                  <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_50%_50%,transparent_30%,rgba(0,0,0,0.1)_100%)]"></div>
                  {wheelTiers.map((tier) => (
                    <div key={tier.id} className="absolute w-full h-full top-0 left-0"
                      style={{ transform: `rotate(${tier.startAngle + (tier.endAngle - tier.startAngle) / 2}deg)` }}>
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 h-1/2 w-0.5 bg-white/40 origin-bottom"
                        style={{ transform: `rotate(${-((tier.endAngle - tier.startAngle) / 2)}deg)` }}></div>
                      <div className="absolute top-8 left-1/2 -translate-x-1/2 text-center">
                        <div className="text-2xl mb-1 filter drop-shadow-md">{getTierVisual(tier.id, tier.value).icon}</div>
                        <div className="text-white font-black text-sm sm:text-base drop-shadow-md whitespace-nowrap tracking-wide">${tier.value}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 中心盖 */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-20 bg-white rounded-full shadow-[0_10px_25px_rgba(0,0,0,0.2)] flex items-center justify-center border-[6px] border-stone-100 z-10 group-hover:scale-105 transition-transform duration-300">
                  <div className="w-full h-full rounded-full bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-inner relative overflow-hidden">
                    <span className="text-white font-black text-sm tracking-widest relative z-10">LUCKY</span>
                  </div>
                </div>

                {/* 指针 */}
                <div className={`absolute -top-6 left-1/2 z-20 filter drop-shadow-[0_4px_6px_rgba(0,0,0,0.3)] transition-all duration-300 ${!spinning ? 'animate-pointer-wobble' : '-translate-x-1/2'}`}>
                  <div className="relative">
                    <div className="w-12 h-16 bg-gradient-to-b from-pink-400 to-orange-400 clip-path-pointer flex items-center justify-center">
                      <div className="w-4 h-4 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)] animate-pulse mt-[-20px]"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 控制区 */}
            <div className="mt-12 w-full max-w-sm text-center space-y-5">
              {error && (
                <div className="animate-fade-in flex items-center justify-center gap-2 text-red-600 text-sm bg-red-50 border border-red-100 py-3 px-4 rounded-xl shadow-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}

              <div className="flex items-center justify-center gap-4 text-sm">
                <div className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-all ${
                  hasSpunToday ? 'bg-stone-100 text-stone-400 border-transparent' : 'bg-green-50 text-green-700 border-green-200 shadow-sm'
                }`}>
                  <span className="font-bold">每日:</span>
                  <span className="font-black text-base">{hasSpunToday ? '0' : '1'}</span>
                </div>
              </div>

              <button
                onClick={handleSpin}
                disabled={!canSpinNow || spinning}
                className={`group relative w-full py-5 rounded-2xl text-xl font-black text-white shadow-[0_10px_30px_rgba(249,115,22,0.4)] transition-all transform overflow-hidden
                  ${canSpinNow && !spinning
                    ? 'gradient-warm hover:shadow-[0_15px_40px_rgba(249,115,22,0.6)] hover:-translate-y-1 active:scale-95 active:shadow-inner'
                    : 'bg-stone-300 cursor-not-allowed shadow-none grayscale'}`}
              >
                {canSpinNow && !spinning && <div className="absolute inset-0 bg-white/20 translate-y-full skew-y-12 group-hover:translate-y-[-200%] transition-transform duration-700 ease-in-out"></div>}
                {spinning ? (
                  <span className="flex items-center justify-center gap-3">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <span className="tracking-widest">{spinButtonText}</span>
                  </span>
                ) : canSpinNow ? (
                  <span className="flex items-center justify-center gap-2 tracking-widest">
                    <Sparkles className="w-5 h-5 fill-white animate-pulse" />
                    {spinButtonText}
                    <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </span>
                ) : spinButtonText}
              </button>

              <p className="text-xs text-stone-400 font-medium tracking-wide uppercase">
                {spinHintText}
              </p>
            </div>
          </div>

          {/* 右侧：中奖记录 */}
          <div className="order-3 space-y-6">
            <div className="glass-card rounded-3xl p-6 w-full animate-fade-in" style={{ animationDelay: '0.2s' }}>
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-orange-100 rounded-xl text-orange-600 shadow-inner">
                  <History className="w-5 h-5" />
                </div>
                <h2 className="text-lg font-bold text-stone-700">我的宝藏</h2>
              </div>

              <div className="space-y-3 max-h-[500px] overflow-y-auto scrollbar-hide pr-1">
                {records.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-stone-400 bg-stone-50/50 rounded-2xl border border-stone-100 border-dashed">
                    <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center mb-3">
                      <Gift className="w-8 h-8 opacity-20" />
                    </div>
                    <p className="text-sm font-medium">暂无战利品</p>
                    <p className="text-xs mt-1">快去试试手气吧！</p>
                  </div>
                ) : (
                  records.map((record) => (
                    <div key={record.id} className="group relative bg-white rounded-xl border border-stone-100 p-3 shadow-sm hover:shadow-md transition-all hover:border-orange-200 overflow-hidden">
                      <div className="absolute right-0 top-0 w-16 h-16 bg-gradient-to-bl from-orange-50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-tr-xl"></div>
                      <div className="flex items-center justify-between mb-2 relative z-10">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{getTierVisual(record.tierId, record.tierValue).icon}</span>
                          <span className={`font-bold text-sm ${getTierVisual(record.tierId, record.tierValue).textClass}`}>
                            {record.tierName}
                          </span>
                          {record.directCredit && (
                            <span className="text-[9px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-bold">已直充</span>
                          )}
                        </div>
                        <span className="text-[10px] text-stone-400 font-mono bg-stone-50 px-1.5 py-0.5 rounded">
                          {new Date(record.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="relative bg-green-50 rounded-lg p-2 border border-green-200 flex items-center justify-center">
                        <span className="text-sm font-bold text-green-700">${record.tierValue} 已充值到账户</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* 中奖弹窗 */}
      {showResultModal && result && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-pink-900/40 backdrop-blur-sm transition-opacity" onClick={() => setShowResultModal(false)} />

          <div className="relative w-full max-w-sm bg-gradient-to-br from-pink-50 via-orange-50 to-amber-50 rounded-[2.5rem] shadow-[0_20px_60px_rgba(251,146,60,0.3)] p-8 text-center animate-scale-in overflow-hidden border-4 border-white/80">
            <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-b from-orange-50 to-transparent -z-10"></div>
            <div className="absolute -top-10 -right-10 w-40 h-40 bg-pink-200 rounded-full blur-3xl opacity-40"></div>
            <div className="absolute -top-10 -left-10 w-40 h-40 bg-amber-200 rounded-full blur-3xl opacity-40"></div>

            <button onClick={() => setShowResultModal(false)} className="absolute top-4 right-4 p-2 bg-stone-50 rounded-full hover:bg-stone-100 transition-colors z-20">
              <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <div className="relative mx-auto mb-6 w-24 h-24">
              <div className="absolute inset-0 bg-orange-200 rounded-full animate-ping opacity-20"></div>
              <div className="relative w-24 h-24 bg-gradient-to-br from-orange-100 to-yellow-50 rounded-full flex items-center justify-center shadow-lg border-4 border-white">
                <Trophy className="w-12 h-12 text-orange-500 fill-orange-500 animate-[bounce_2s_infinite]" />
              </div>
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-sm whitespace-nowrap">WINNER</div>
            </div>

            <h3 className="text-3xl font-black text-stone-700 mb-2 tracking-tight">恭喜中奖！</h3>
            <p className="text-stone-500 mb-8 font-medium">
              运气爆棚！您获得了 <br />
              <span className="text-2xl text-transparent bg-clip-text bg-gradient-to-r from-orange-600 to-red-600 font-black mt-2 inline-block">{result.name}</span>
              <span className="block text-sm text-green-600 mt-2 font-bold">已直接充值到您的账户</span>
            </p>

            <div className="bg-gradient-to-br from-green-50 to-emerald-50 border-2 border-green-200 rounded-2xl p-6 mb-8">
              <div className="text-center">
                <p className="text-sm text-green-600 mb-2 font-medium">充值金额</p>
                <p className="text-4xl font-black text-green-700">${result.value}</p>
                <p className="text-xs text-green-500 mt-2">已添加到您的 API 账户余额</p>
              </div>
            </div>

            <button onClick={() => setShowResultModal(false)} className="w-full py-4 gradient-warm text-white rounded-2xl font-bold text-lg shadow-xl shadow-orange-500/20 hover:shadow-orange-500/30 active:scale-95 transition-all">
              收入囊中
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
