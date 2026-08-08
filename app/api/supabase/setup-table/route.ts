import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

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

export async function POST() {
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

    const sql = `
      CREATE TABLE IF NOT EXISTS forgestudio_leads (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz default now(),
        source text,
        name text,
        email text,
        phone text,
        message text
      );
      ALTER TABLE forgestudio_leads ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Allow anon insert" ON forgestudio_leads;
      CREATE POLICY "Allow anon insert" ON forgestudio_leads FOR INSERT TO anon WITH CHECK (true);
    `;

    const sqlRes = await fetchWithTimeout(
      `https://api.supabase.com/v1/projects/${ref}/database/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      },
      20000
    );

    if (!sqlRes.ok) {
      const errText = await sqlRes.text();
      console.error('SQL setup failed:', sqlRes.status, errText);
      return NextResponse.json(
        { error: `Could not create table (status ${sqlRes.status}): ${errText.slice(0, 200)}` },
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
      tableName: 'forgestudio_leads',
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
