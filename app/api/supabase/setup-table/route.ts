import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function fetchWithTimeout(url: string, options: RequestInit, ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export async function POST(req: Request) {
  const { feature, description } = await req.json().catch(() => ({}));

  if (!feature) {
    return NextResponse.json({ error: 'Missing feature name' }, { status: 400 });
  }

  const { data: integration } = await supabase
    .from('integrations')
    .select('access_token')
    .eq('provider', 'Supabase')
    .single();

  if (!integration?.access_token) {
    return NextResponse.json({ error: 'Supabase not connected' }, { status: 400 });
  }

  const token = integration.access_token;

  try {
    const projectsRes = await fetchWithTimeout(
      'https://api.supabase.com/v1/projects',
      { headers: { Authorization: `Bearer ${token}` } },
      15000
    );

    if (!projectsRes.ok) {
      const errText = await projectsRes.text();
      console.error('List projects failed:', projectsRes.status, errText);
      return NextResponse.json(
        { error: `Could not list Supabase projects (status ${projectsRes.status}) — your Supabase connection may have expired, try reconnecting it` },
        { status: 500 }
      );
    }

    const projects = await projectsRes.json();
    if (!Array.isArray(projects) || projects.length === 0) {
      return NextResponse.json({ error: 'No Supabase project found on this account' }, { status: 400 });
    }

    const ref = projects[0].id;

    const mcpPrompt = `You are setting up a Supabase table to support this feature for a generated website: "${feature}"${description ? ` — ${description}` : ''}.

Design and create ONE new table in the "public" schema that fits this feature well. Requirements:
1. Pick a clear, snake_case table name prefixed with "forgestudio_" (e.g. forgestudio_bookings, forgestudio_newsletter_signups).
2. Include "id uuid primary key default gen_random_uuid()" and "created_at timestamptz default now()" plus whatever columns the feature actually needs (use "text" for most fields, "boolean"/"numeric"/"date" where clearly appropriate).
3. Enable Row Level Security on the table.
4. Create an RLS policy allowing the "anon" role to INSERT (and SELECT if the feature reasonably needs to read its own data back, e.g. a booking confirmation).
5. IMPORTANT: RLS policies alone are not sufficient on this project — you must also run "grant select, insert on <table_name> to anon, authenticated;" or all inserts will fail with "permission denied for table" even though RLS looks correct.
6. Use "CREATE TABLE IF NOT EXISTS" so this is safe to re-run.

Use the available Supabase tools to actually execute this SQL against the connected project (do not just describe it).

After creating the table, respond with ONLY a JSON object on the final line, no other text, in this exact shape:
{"tableName": "the_table_name", "columns": [{"name": "col_name", "type": "text"}, ...]}
Only include the feature-specific columns in "columns" (omit id/created_at).`;

    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: mcpPrompt }],
      mcp_servers: [
        {
          type: 'url',
          url: `https://mcp.supabase.com/mcp?project_ref=${ref}`,
          name: 'supabase',
          authorization_token: token,
        },
      ],
      betas: ['mcp-client-2025-04-04'],
    });

    const textBlocks = response.content.filter((b: any) => b.type === 'text');
    const lastText = textBlocks[textBlocks.length - 1];
    let parsed: { tableName: string; columns: { name: string; type: string }[] } | null = null;

    if (lastText && 'text' in lastText) {
      try {
        const match = lastText.text.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
      } catch (e) {
        console.error('Failed to parse MCP table result JSON:', lastText.text);
      }
    }

    if (!parsed?.tableName) {
      return NextResponse.json(
        { error: 'Table setup ran but Claude did not return a valid table summary', raw: response.content },
        { status: 500 }
      );
    }

    const keysRes = await fetchWithTimeout(
      `https://api.supabase.com/v1/projects/${ref}/api-keys`,
      { headers: { Authorization: `Bearer ${token}` } },
      15000
    );

    if (!keysRes.ok) {
      const errText = await keysRes.text();
      console.error('Fetch keys failed:', keysRes.status, errText);
      return NextResponse.json(
        { error: `Table was created, but could not fetch API keys (status ${keysRes.status})` },
        { status: 500 }
      );
    }

    const keys = await keysRes.json();
    const anonKey = Array.isArray(keys) ? keys.find((k: any) => k.name === 'anon')?.api_key : null;

    if (!anonKey) {
      return NextResponse.json({ error: 'Table was created, but no anon key was found' }, { status: 500 });
    }

    return NextResponse.json({
      projectUrl: `https://${ref}.supabase.co`,
      anonKey,
      tableName: parsed.tableName,
      columns: parsed.columns || [],
    });
  } catch (e: any) {
    console.error('Setup table error:', e);
    const isTimeout = e?.name === 'AbortError';
    return NextResponse.json(
      { error: isTimeout ? 'Supabase took too long to respond, try again' : `Unexpected error: ${e?.message || e}` },
      { status: 500 }
    );
  }
      }
