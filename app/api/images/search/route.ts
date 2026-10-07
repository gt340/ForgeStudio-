import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/supabase-server";

const PEXELS_PHOTO_URL = "https://api.pexels.com/v1/search";
const PEXELS_VIDEO_URL = "https://api.pexels.com/videos/search";
const MAX_QUERY_LENGTH = 200;

// Requires a signed-in user: this route spends the site's shared Pexels API quota, so it must not be
// callable anonymously. (Per-user rate limiting is intentionally NOT added here — see the Phase 7 report.)
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { query, type } = await req.json(); // type: "photo" | "video"

    if (!query || typeof query !== "string" || !query.trim()) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return NextResponse.json({ error: "Query too long" }, { status: 400 });
    }

    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Image search is not configured" }, { status: 500 });
    }

    if (type === "video") {
      const res = await fetch(
        `${PEXELS_VIDEO_URL}?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
        { headers: { Authorization: apiKey } }
      );
      const data = await res.json();
      const video = data.videos?.[0];
      const file =
        video?.video_files?.find((f: any) => f.quality === "hd") ||
        video?.video_files?.[0];

      return NextResponse.json({
        url: file?.link || null,
        thumbnail: video?.image || null,
      });
    }

    // default: photo
    const res = await fetch(
      `${PEXELS_PHOTO_URL}?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: apiKey } }
    );
    const data = await res.json();
    const photo = data.photos?.[0];

    return NextResponse.json({
      url: photo?.src?.large || null,
      thumbnail: photo?.src?.medium || null,
    });
  } catch (err) {
    console.error("Pexels search error:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Image search failed" }, { status: 500 });
  }
}
