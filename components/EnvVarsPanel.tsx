'use client';
import { useState, useEffect } from 'react';

type EnvVar = {
  id: string;
  key: string;
  value: string;
  environment: string;
};

export default function EnvVarsPanel() {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadVars() {
    const res = await fetch('/api/env-vars');
    const data = await res.json();
    setVars(data.vars || []);
  }

  useEffect(() => {
    loadVars();
  }, []);

  async function addVar() {
    if (!key || !value) return;
    setLoading(true);
    await fetch('/api/env-vars', {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    setKey('');
    setValue('');
    await loadVars();
    setLoading(false);
  }

  async function deleteVar(id: string) {
    await fetch('/api/env-vars', {
      method: 'DELETE',
      body: JSON.stringify({ id }),
    });
    await loadVars();
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="KEY_NAME"
          className="flex-1 rounded-lg bg-black/40 border border-cyan-400/20 focus:border-cyan-400/60 focus:outline-none focus:ring-1 focus:ring-cyan-400/30 px-3 py-2 text-sm font-mono placeholder:text-white/30 transition-colors"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          type="password"
          className="flex-1 rounded-lg bg-black/40 border border-cyan-400/20 focus:border-cyan-400/60 focus:outline-none focus:ring-1 focus:ring-cyan-400/30 px-3 py-2 text-sm font-mono placeholder:text-white/30 transition-colors"
        />
        <button
          onClick={addVar}
          disabled={loading}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-black transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: 'linear-gradient(90deg, #00e5ff, #22d3ee)',
            boxShadow: '0 0 16px rgba(0,229,255,0.35)',
          }}
        >
          {loading ? 'Adding…' : 'Add'}
        </button>
      </div>

      <div className="space-y-2">
        {vars.length === 0 && (
          <p className="text-sm text-white/40 italic">No variables yet.</p>
        )}
        {vars.map((v) => (
          <div
            key={v.id}
            className="flex items-center justify-between bg-black/30 border border-white/5 hover:border-cyan-400/20 rounded-lg px-3 py-2.5 transition-colors group"
          >
            <div className="font-mono text-sm">
              <span className="text-cyan-400">{v.key}</span>
              <span className="text-white/30"> = ••••••••</span>
            </div>
            <button
              onClick={() => deleteVar(v.id)}
              className="text-orange-400/70 text-xs font-medium hover:text-orange-300 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
      }
