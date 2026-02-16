import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { spinLotteryDirect } from "@/lib/lottery";
import { getNewApiUserId } from "@/lib/user-mapping";

export async function POST() {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ success: false, message: "未登录" }, { status: 401 });
  }

  try {
    // 用 linuxdoId 查找 newapi userId（优先按 linuxdo_id 精确匹配）
    const newApiUserId = await getNewApiUserId(user.linuxdoId);
    if (!newApiUserId) {
      return NextResponse.json({
        success: false,
        message: "未找到对应的 API 账户，请先用 LinuxDo 登录 API 平台完成注册",
      }, { status: 400 });
    }

    // 执行直充抽奖
    const result = await spinLotteryDirect(user.linuxdoId, user.username, newApiUserId);

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: result.message,
        record: result.record,
      });
    }

    return NextResponse.json({
      success: false,
      message: result.message,
      uncertain: result.uncertain,
    }, { status: result.uncertain ? 202 : 400 });
  } catch (error) {
    console.error("Spin lottery error:", error);
    return NextResponse.json({ success: false, message: "抽奖失败，请稍后重试" }, { status: 500 });
  }
}
