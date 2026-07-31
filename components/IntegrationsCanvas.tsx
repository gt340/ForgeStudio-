'use client'
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
  { name: 'Paystack', color: '#00c3f7' },
  { name: 'Google Business', color: '#4285f4' },
];

export default function IntegrationsCanvas() {
  const [connected, setConnected] = useState<Integration[]>([]);
  const [paystackKey, setPaystackKey] = useState('');
  const [showPaystackForm, setShowPaystackForm] = useState(false);
  const [resendKey, setResendKey] = useState('');
  const [showResendForm, setShowResendForm] = useState(false);
  const [loading, setLoading] = useState(false);

  async function loadIntegrations() {
    const res = await fetch('/api/integrations');
    const data = await res.json();
    setConnected(data.integrations || []);
  }

  useEffect(() => {
    loadIntegrations();
  }, []);

  async function submitPaystackKey() {
    setLoading(true);
    await fetch('/api/integrations/paystack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretKey: paystackKey }),
    });
    setShowPaystackForm(false);
    setPaystackKey('');
    await loadIntegrations();
    setLoading(false);
  }

  async function submitResendKey() {
    setLoading(true);
    await fetch('/api/integrations/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: resendKey }),
    });
    setShowResendForm(false);
    setResendKey('');
    await loadIntegrations();
    setLoading(false);
  }

  async function connect(provider: string) {
    if (provider === 'Paystack') {
      setShowPaystackForm(true);
      return;
    }
    if (provider === 'Resend') {
      setShowResendForm(true);
      return;
    }
    if (provider === 'Slack') {
      window.location.href = '/api/auth/slack/start';
      return;
    }
    if (provider === 'Supabase') {
      window.location.href = '/api/auth/supabase/start';
      return;
    }
    if (provider === 'Supabase') {
      window.location.href = '/api/auth/supabase/start';
      return;
    }
    if (provider === 'GitHub') {
      window.location.href = '/api/auth/github/start';
      return;
    }
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
        {showPaystackForm && (
          <div className="mt-4 p-4 border border-white/10 rounded-lg bg-white/5">
            <label className="text-sm block mb-2">Paystack Secret Key</label>
            <input
              type="password"
              value={paystackKey}
              onChange={(e) => setPaystackKey(e.target.value)}
              placeholder="sk_live_..."
              className="w-full p-2 rounded bg-black/30 border border-white/10 text-sm mb-2"
            />
            <button
              onClick={submitPaystackKey}
              disabled={loading}
              className="px-4 py-2 bg-cyan-500 rounded text-sm"
            >
              Save Key
            </button>
          </div>
        )}
        {showResendForm && (
          <div className="mt-4 p-4 border border-white/10 rounded-lg bg-white/5">
            <label className="text-sm block mb-2">Resend API Key</label>
            <input
              type="text"
              value={resendKey}
              onChange={(e) => setResendKey(e.target.value)}
              placeholder="re_..."
              className="w-full p-2 rounded bg-black/30 border border-white/10 text-sm mb-2"
            />
            <button
              onClick={submitResendKey}
              disabled={loading}
              className="px-4 py-2 bg-cyan-500 rounded text-sm"
            >
              Save Key
            </button>
          </div>
        )}
        {AVAILABLE.map((item) => {
          const existing = isConnected(item.name);
          return (
            <button
              key={item.name}
              onClick={() =>
                  existing ? disconnect(existing.id) : item.name === 'Google Business' ? (window.location.href = '/api/auth/google') : connect(item.name)
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
