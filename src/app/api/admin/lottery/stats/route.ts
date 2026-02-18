import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { getLotteryStats, getLotteryConfig, getLotteryRecords, getPendingRecordCount, reconcilePendingRecords } from "@/lib/lottery";

export async function GET() {
  const user = await getAuthUser();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ success: false, message: "无权限" }, { status: 403 });
  }

  try {
    const [stats, config, recentRecords, pendingCount] = await Promise.all([
      getLotteryStats(),
      getLotteryConfig(),
      getLotteryRecords(20),
      getPendingRecordCount(),
    ]);

    // 有 pending 记录时自动触发对账（非阻塞）
    let reconcileResult = null;
    if (pendingCount > 0) {
      try {
        reconcileResult = await reconcilePendingRecords();
      } catch (e) {
        console.error("Auto reconcile failed:", e);
      }
    }

    return NextResponse.json({
      success: true,
      stats: {
        todayDirectTotal: stats.todayDirectTotal,
        dailyDirectLimit: config.dailyDirectLimit,
        todayUsers: stats.todayUsers,
        todaySpins: stats.todaySpins,
        totalRecords: stats.totalRecords,
        enabled: config.enabled,
        pendingRecords: pendingCount,
        ...(reconcileResult ? { reconcileResult } : {}),
      },
      recentRecords: recentRecords.slice(0, 10),
    });
  } catch (error) {
    console.error("Get lottery stats error:", error);
    return NextResponse.json({ success: false, message: "获取统计失败" }, { status: 500 });
  }
}
