'use client';
import { useState, useEffect } from 'react';

type Integration = {
  id: string;
  provider: string;
  status: string;
};

const AVAILABLE = [
  { name: 'Stripe', color: '#635bff' },
  { name: 'Supabase', color: '#3ecf8e' },
  { name: 'Slack', color: '#4a154b' },
  { name: 'GitHub', color: '#333333' },
  { name: 'Resend', color: '#000000' },
  { name: 'Cloudflare', color: '#f38020' },
  { name: 'Google Business', color: '#4285f4' },
];

export default function IntegrationsCanvas() {
  const [connected, setConnected] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadIntegrations() {
    const res = await fetch('/api/integrations');
    const data = await res.json();
    setConnected(data.integrations || []);
  }

  useEffect(() => {
    loadIntegrations();
  }, []);

  async function connect(provider: string) {
    setLoading(true);
    await fetch('/api/integrations', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
    await loadIntegrations();
    setLoading(false);
  }

  async function disconnect(id: string) {
    await fetch('/api/integrations', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
    await loadIntegrations();
  }

  const isConnected = (name: string) =>
    connected.find((c) => c.provider === name);

  return (
    <div className="border border-white/10 rounded-lg p-6 bg-black/20 space-y-6">
      <h2 className="text-xl font-bold">Integrations</h2>
      <p className="text-sm text-white/40">
        Tap a service to connect it to your project.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {AVAILABLE.map((item) => {
          const existing = isConnected(item.name);
          return (
            <button
              key={item.name}
              onClick={() =>
                existing ? disconnect(existing.id) : connect(item.name)
              }
              disabled={loading}
              className={`rounded-lg p-4 text-left border transition ${
                existing
                  ? 'border-cyan-400 bg-cyan-400/10'
                  : 'border-white/10 bg-white/5 hover:bg-white/10'
              }`}
            >
              <div className="font-semibold text-sm">{item.name}</div>
              <div className="text-xs mt-1 text-white/40">
                {existing ? '✓ Connected' : 'Tap to connect'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
