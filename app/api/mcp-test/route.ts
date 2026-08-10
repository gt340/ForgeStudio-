import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST() {
  try {
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

    if (!projectsRes.ok) {
      return NextResponse.json(
        { error: `Could not list Supabase projects (status ${projectsRes.status})` },
        { status: 500 }
      );
    }

    const projects = await projectsRes.json();
    if (!Array.isArray(projects) || projects.length === 0) {
      return NextResponse.json({ error: 'No Supabase project found' }, { status: 400 });
    }

    const ref = projects[0].id;

    const response = await anthropic.beta.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: 'List the tables in this Supabase project. Just give me a short plain list of table names.',
        },
      ],
      mcp_servers: [
        {
          type: 'url',
          url: `https://mcp.supabase.com/mcp?project_ref=${ref}&read_only=true`,
          name: 'supabase',
          authorization_token: token,
        },
      ],
      betas: ['mcp-client-2025-04-04'],
    });

    return NextResponse.json({ content: response.content, projectRef: ref });
  } catch (e: any) {
    console.error('MCP test failed:', e);
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
            }
