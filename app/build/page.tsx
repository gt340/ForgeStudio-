import LivePreview from '@/components/LivePreview';
import EnvVarsPanel from '@/components/EnvVarsPanel';
import IntegrationsCanvas from '@/components/IntegrationsCanvas';
import SeoPanel from '@/components/SeoPanel';

function PanelCard({ title, tag, children }: { title: string; tag: string; children: React.ReactNode }) {
  return (
    <section className="relative rounded-2xl border border-cyan-400/20 bg-white/[0.02] backdrop-blur-sm p-6 md:p-8 overflow-hidden group hover:border-cyan-400/40 transition-colors duration-300">
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
           style={{ background: 'radial-gradient(600px circle at 0% 0%, rgba(0,229,255,0.06), transparent 60%)' }} />
      <div className="flex items-center justify-between mb-6 relative">
        <h2 className="text-lg font-semibold tracking-tight text-white">{title}</h2>
        <span className="text-[11px] uppercase tracking-widest px-2.5 py-1 rounded-full border border-orange-400/30 text-orange-300/90 bg-orange-400/5">
          {tag}
        </span>
      </div>
      <div className="relative">{children}</div>
    </section>
  );
}

export default function Home() {
  return (
    <main className="relative min-h-screen bg-[#05070d] text-white overflow-hidden">
      {/* grid backdrop */}
      <div
        className="absolute inset-0 opacity-[0.15] pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0,229,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(0,229,255,0.5) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)',
        }}
      />
      <div
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(0,229,255,0.08) 0%, transparent 65%)',
        }}
      />

      <div className="relative px-6 py-20 max-w-5xl mx-auto space-y-10">
        <div className="space-y-4">
          <span className="text-xs uppercase tracking-[0.2em] text-cyan-300/80">Build console</span>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            ForgeStudio{' '}
            <span
              style={{
                backgroundImage: 'linear-gradient(90deg, #00e5ff, #ff6b35)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              — live demo
            </span>
          </h1>
          <p className="text-white/60 max-w-2xl leading-relaxed">
            Describe the business or site you want in plain language, and ForgeStudio generates a
            working website with a live preview, lets you connect integrations like Stripe and
            Supabase, and package it as an installable Android app.
          </p>
        </div>

        <PanelCard title="Live Preview" tag="Editor">
          <LivePreview />
        </PanelCard>

        <PanelCard title="Environment Variables" tag="Config">
          <EnvVarsPanel />
        </PanelCard>

        <PanelCard title="Integrations" tag="Connect">
          <IntegrationsCanvas />
        </PanelCard>

        <PanelCard title="SEO Settings" tag="Growth">
          <SeoPanel />
        </PanelCard>
      </div>
    </main>
  );
        }
