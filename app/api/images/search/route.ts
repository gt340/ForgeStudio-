import { NextRequest, NextResponse } from "next/server";

const PEXELS_PHOTO_URL = "https://api.pexels.com/v1/search";
const PEXELS_VIDEO_URL = "https://api.pexels.com/videos/search";

export async function POST(req: NextRequest) {
  try {
    const { query, type } = await req.json(); // type: "photo" | "video"

    if (!query) {
      return NextResponse.json({ error: "Missing query" }, { status: 400 });
    }

    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "PEXELS_API_KEY not set" }, { status: 500 });
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
    console.error("Pexels search error:", err);
    return NextResponse.json({ error: "Image search failed" }, { status: 500 });
  }
        }
