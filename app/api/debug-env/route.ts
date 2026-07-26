import { NextResponse } from "next/server";

export async function GET() {
  const id = process.env.GOOGLE_CLIENT_ID || "MISSING";
  return NextResponse.json({
    length: id.length,
    startsWith: id.slice(0, 15),
    endsWith: id.slice(-25),
  });
}
