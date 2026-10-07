// Turns a project's saved source into the exact page code that gets pushed to GitHub / deployed.
// This mirrors what the live sandbox preview does client-side (resolve {{IMG}}/{{VIDEO}} placeholders,
// ensure the 'use client' directive) so the deployed site matches what the user saw in the preview.

const PLACEHOLDER_PATTERN = /\{\{(IMG|VIDEO):([^}]+)\}\}/g;
const FALLBACK_URL = 'https://via.placeholder.com/1200x800?text=Image';

export function ensureUseClient(code: string): string {
  return /^\s*['"]use client['"]/.test(code) ? code : `'use client';\n${code}`;
}

async function lookupMedia(kind: string, query: string, apiKey: string): Promise<string | null> {
  try {
    const isVideo = kind === 'VIDEO';
    const base = isVideo ? 'https://api.pexels.com/videos/search' : 'https://api.pexels.com/v1/search';
    const res = await fetch(`${base}?query=${encodeURIComponent(query.trim())}&per_page=1&orientation=landscape`, {
      headers: { Authorization: apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (isVideo) {
      const video = data.videos?.[0];
      const file = video?.video_files?.find((f: any) => f.quality === 'hd') || video?.video_files?.[0];
      return file?.link || null;
    }
    return data.photos?.[0]?.src?.large || null;
  } catch {
    return null;
  }
}

export async function resolveMediaPlaceholders(code: string): Promise<string> {
  const matches = [...code.matchAll(PLACEHOLDER_PATTERN)];
  if (matches.length === 0) return code;

  const unique = Array.from(new Map(matches.map((m) => [m[0], m])).values());
  const apiKey = process.env.PEXELS_API_KEY;

  const resolved = await Promise.all(
    unique.map(async ([full, kind, query]) => {
      const url = apiKey ? await lookupMedia(kind, query, apiKey) : null;
      return [full, url || FALLBACK_URL] as const;
    })
  );

  let result = code;
  for (const [full, url] of resolved) {
    result = result.split(full).join(url);
  }
  return result;
}

/** Server-side equivalent of the sandbox's buildSandboxFiles page transform. */
export async function prepareDeployableCode(code: string): Promise<string> {
  return ensureUseClient(await resolveMediaPlaceholders(code));
}
