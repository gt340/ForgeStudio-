import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

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

  const projectsRes = await fetch('https://api.supabase.com/v1/projects', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const projects = await projectsRes.json();

  if (!Array.isArray(projects) || projects.length === 0) {
    return NextResponse.json({ error: 'No Supabase project found' }, { status: 400 });
  }

  const project = projects[0];
  const ref = project.id;

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

  const sqlRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!sqlRes.ok) {
    const errText = await sqlRes.text();
    console.error('SQL setup failed:', errText);
    return NextResponse.json({ error: 'Failed to set up table' }, { status: 500 });
  }

  const keysRes = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const keys = await keysRes.json();
  const anonKey = Array.isArray(keys) ? keys.find((k: any) => k.name === 'anon')?.api_key : null;

  return NextResponse.json({
    projectUrl: `https://${ref}.supabase.co`,
    anonKey,
    tableName: 'forgestudio_leads',
  });
    }
