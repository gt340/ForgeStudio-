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
    <div className="space-y-4 border border-white/10 rounded-lg p-6 bg-black/20">
      <h2 className="text-xl font-bold">Environment Variables</h2>
      <div className="flex gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="KEY_NAME"
          className="flex-1 rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-sm font-mono"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          type="password"
          className="flex-1 rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-sm font-mono"
        />
        <button
          onClick={addVar}
          disabled={loading}
          className="rounded-lg bg-cyan-400 text-black px-4 py-2 text-sm font-semibold"
        >
          Add
        </button>
      </div>
      <div className="space-y-2">
        {vars.length === 0 && (
          <p className="text-sm text-white/40">No variables yet.</p>
        )}
        {vars.map((v) => (
          <div
            key={v.id}
            className="flex items-center justify-between bg-black/30 rounded-lg px-3 py-2"
          >
            <div className="font-mono text-sm">
              <span className="text-cyan-400">{v.key}</span>
              <span className="text-white/40"> = ••••••••</span>
            </div>
            <button
              onClick={() => deleteVar(v.id)}
              className="text-red-400 text-xs hover:text-red-300"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
