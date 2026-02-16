import { NextResponse } from "next/server";
import { getAuthUser, isAdmin } from "@/lib/auth";
import { db } from "@/lib/mysql";

export async function GET() {
  const user = await getAuthUser();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ success: false, message: "无权限" }, { status: 403 });
  }

  try {
    const columns = await db.query<{ Field: string; Type: string }>(
      "DESCRIBE users"
    );
    return NextResponse.json({ success: true, columns });
  } catch (error) {
    return NextResponse.json({ success: false, message: String(error) }, { status: 500 });
  }
}
