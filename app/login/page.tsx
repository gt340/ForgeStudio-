'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    router.push('/build');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-black text-white">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 p-6 rounded-2xl border border-white/10 bg-white/[0.03]">
        <h1 className="text-2xl font-bold">Sign in to ForgeStudio</h1>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:border-cyan-400/50"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:border-cyan-400/50"
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg px-5 py-2 text-sm font-semibold text-black disabled:opacity-50"
          style={{ background: 'linear-gradient(90deg, #00e5ff, #ff6b35)' }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-xs text-white/40 text-center">
          No account? <a href="/signup" className="text-cyan-300 underline">Sign up</a>
        </p>
      </form>
    </div>
  );
}
