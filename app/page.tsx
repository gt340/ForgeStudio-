'use client';

import Script from 'next/script';

const BODY_HTML = `
<header>
  <nav>
    <div class="logo">
      <span class="logo-mark">
        <svg viewBox="0 0 26 26" fill="none"><path d="M13 1 L24 7 V19 L13 25 L2 19 V7 Z" stroke="url(#g1)" stroke-width="1.6"/><path d="M13 1 V13 M13 13 L24 7 M13 13 L2 7 M13 13 V25" stroke="url(#g1)" stroke-width="1"/><defs><linearGradient id="g1" x1="0" y1="0" x2="26" y2="26"><stop offset="0%" stop-color="#00e5ff"/><stop offset="100%" stop-color="#ff6b35"/></linearGradient></defs></svg>
      </span>
      ForgeStudio
    </div>
    <div class="nav-links">
      <a href="#demo">Live Demo</a>
      <a href="#features">Product</a>
      <a href="#integrations">Integrations</a>
      <a href="#pricing">Pricing</a>
    </div>
    <div class="nav-cta">
      <a href="/build" class="btn-text">Sign in</a>
      <a href="/build" class="btn btn-primary">Start Building</a>
    </div>
  </nav>
</header>

<section class="hero">
  <canvas id="hero-canvas"></canvas>
  <div class="hero-content">
    <span class="eyebrow">AI website & app builder</span>
    <h1>Describe it.<br><span class="grad">Watch it forge itself.</span></h1>
    <p class="sub">ForgeStudio turns a prompt into a live website or mobile app — code, preview, integrations, and app-store build, all inside one browser tab.</p>
    <div class="hero-ctas">
      <a href="/build" class="btn btn-primary btn-lg">Start Building — Free</a>
      <a href="#demo" class="btn btn-ghost btn-lg">Watch it build →</a>
    </div>
    <div class="build-log" id="buildlog">
      <span class="ln">&gt; reading prompt<span class="dim">: "portfolio site for a ceramics studio"</span></span>
      <span class="ln">&gt; scaffolding routes <span class="ok">✓ done</span></span>
      <span class="ln">&gt; generating components <span class="ok">✓ 14 built</span></span>
      <span class="ln">&gt; wiring integrations <span class="ok">✓ stripe, sanity</span></span>
      <span class="ln">&gt; build ready <span class="ok">→ deployed in 41s</span></span>
    </div>
  </div>
  <div class="scroll-cue"><span>Scroll</span><span class="stick"></span></div>
</section>

<section id="demo">
  <div class="wrap">
    <div class="section-head center">
      <span class="eyebrow">Live coding preview</span>
      <h2>Type a prompt. See a site come alive.</h2>
      <p>Every keystroke on the left renders instantly on the right — real components, real layout, real-time.</p>
    </div>
    <div class="demo-shell reveal">
      <div class="demo-bar">
        <div class="dot"></div><div class="dot"></div><div class="dot"></div>
        <span class="path">forgestudio.app/build/ceramics-studio</span>
      </div>
      <div class="demo-grid">
        <div class="demo-code"><span id="typecode"></span><span class="cursor-blink"></span></div>
        <div class="demo-preview">
          <span class="pv-badge" id="pvbadge">live preview</span>
          <div class="pv-block pv-nav" id="pv1"><span></span><span></span><span></span></div>
          <div class="pv-block pv-hero" id="pv2"><div class="bar1"></div><div class="bar2"></div><div class="bar3"></div></div>
          <div class="pv-block pv-cards" id="pv3"><div class="c"></div><div class="c"></div><div class="c"></div></div>
          <div class="pv-block pv-footer" id="pv4"></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="features">
  <div class="wrap">
    <div class="section-head">
      <span class="eyebrow">Everything, in one tab</span>
      <h2>From first prompt to app-store build.</h2>
    </div>
    <div class="features-grid">

      <div class="feature-card reveal">
        <div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/><path d="M8 9v9"/></svg></div>
        <h3>Live split-view preview</h3>
        <p>Code on one side, a real 3D-rendered render of your site on the other. No refresh, no build step — it updates as you type.</p>
        <span class="f-tag">Editor</span>
      </div>

      <div class="feature-card reveal">
        <div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
        <h3>Environment variables</h3>
        <p>Manage secrets and config per environment — local, staging, production — with encrypted storage and one-click sync to your build.</p>
        <span class="f-tag">Config</span>
      </div>

      <div class="feature-card reveal">
        <div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 8.5L15.5 15.5"/><circle cx="18" cy="6" r="3"/><path d="M9 7.5L15.5 8.5"/></svg></div>
        <h3>Drag-and-drop integrations</h3>
        <p>Connect a database, payment processor, or auth provider by dragging its node onto the canvas. ForgeStudio wires the code for you.</p>
        <span class="f-tag">Integrations</span>
      </div>

      <div class="feature-card reveal">
        <div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg></div>
        <h3>One-click APK / iOS build</h3>
        <p>Package your site as a native Android or iOS app and ship a signed build straight to Google Play or the App Store.</p>
        <span class="f-tag">Ship</span>
      </div>

      <div class="feature-card reveal">
        <div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></div>
        <h3>Google Business & SEO tools</h3>
        <p>Optimize your Business Profile, generate metadata, and track local search rankings — without leaving the builder.</p>
        <span class="f-tag">Growth</span>
      </div>

      <div class="feature-card reveal">
        <div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 6.5L21 11l-6.6 2.5L12 20l-2.4-6.5L3 11l6.6-2.5z"/></svg></div>
        <h3>AI agent, full-site generation</h3>
        <p>Describe the product in a sentence. The agent plans the sitemap, writes the components, and asks before it makes a judgment call.</p>
        <span class="f-tag">AI Agent</span>
      </div>

    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="section-head center">
      <span class="eyebrow">How it works</span>
      <h2>Four steps, one browser tab.</h2>
    </div>
    <div class="flow">
      <div class="flow-step reveal">
        <div class="flow-num">01</div>
        <h3>Describe</h3>
        <p>Tell the agent what you're building and who it's for. No brief templates required.</p>
      </div>
      <div class="flow-step reveal">
        <div class="flow-num">02</div>
        <h3>Forge</h3>
        <p>Watch components, pages, and layout assemble live in the split-view preview.</p>
      </div>
      <div class="flow-step reveal">
        <div class="flow-num">03</div>
        <h3>Connect</h3>
        <p>Drag in your database, payments, and auth. Set environment variables once.</p>
      </div>
      <div class="flow-step reveal">
        <div class="flow-num">04</div>
        <h3>Ship</h3>
        <p>Deploy the site, or build a signed APK / iOS binary and submit it directly.</p>
      </div>
    </div>
  </div>
</section>

<section id="integrations">
  <div class="wrap">
    <div class="section-head center">
      <span class="eyebrow">Integrations</span>
      <h2>Plug into the tools you already trust.</h2>
      <p>Every node is a real, working connection — not a mockup. Drop it in and ForgeStudio generates the client code and env vars.</p>
    </div>
    <div class="integrations-wrap reveal">
      <div class="orbit-field" id="orbitField">
        <div class="orbit-ring r1"></div>
        <div class="orbit-ring r2"></div>
        <div class="orbit-core">FORGE<br>CORE</div>
      </div>
    </div>
  </div>
</section>

<section id="pricing">
  <div class="wrap">
    <div class="section-head center">
      <span class="eyebrow">Pricing</span>
      <h2>Start free. Scale when it earns its keep.</h2>
    </div>
    <div class="pricing-grid">

      <div class="price-card reveal">
        <h3>Spark</h3>
        <div class="price-amt">$0<span>/mo</span></div>
        <p class="desc">For trying the agent and shipping a first project.</p>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>1 active project</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Live preview & editor</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>3 integrations</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Community support</li>
        </ul>
        <a href="/build" class="btn btn-ghost">Get started</a>
      </div>

      <div class="price-card pop reveal">
        <span class="pop-tag">Most popular</span>
        <h3>Forge</h3>
        <div class="price-amt">$39<span>/mo</span></div>
        <p class="desc">For builders shipping client and production work.</p>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Unlimited projects</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>One-click APK / iOS builds</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Unlimited integrations</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>SEO & Business Profile tools</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Priority build queue</li>
        </ul>
        <a href="/build" class="btn btn-primary">Start Building</a>
      </div>

      <div class="price-card reveal">
        <h3>Foundry</h3>
        <div class="price-amt">Custom</div>
        <p class="desc">For teams and agencies building at scale.</p>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Everything in Forge</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>SSO & role permissions</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>Dedicated build capacity</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>White-glove onboarding</li>
        </ul>
        <a href="#" class="btn btn-ghost">Talk to sales</a>
      </div>

    </div>
  </div>
</section>

<section class="final-cta">
  <div class="wrap" style="position:relative;">
    <span class="eyebrow">Ready when you are</span>
    <h2 style="margin-top:18px;">Your next site is one prompt away.</h2>
    <p>No local setup. No app-store paperwork. Describe it, and ForgeStudio does the rest.</p>
    <a href="/build" class="btn btn-primary btn-lg">Start Building — Free</a>
  </div>
</section>

<footer>
  <div class="wrap">
    <div class="footer-grid">
      <div class="footer-col" style="max-width:260px;">
        <div class="logo" style="margin-bottom:14px;">
          <span class="logo-mark"><svg viewBox="0 0 26 26" fill="none"><path d="M13 1 L24 7 V19 L13 25 L2 19 V7 Z" stroke="url(#g2)" stroke-width="1.6"/><defs><linearGradient id="g2" x1="0" y1="0" x2="26" y2="26"><stop offset="0%" stop-color="#00e5ff"/><stop offset="100%" stop-color="#ff6b35"/></linearGradient></defs></svg></span>
          ForgeStudio
        </div>
        <p style="color:var(--slate);font-size:13.5px;line-height:1.6;">The AI builder that forges complete websites and apps inside your browser.</p>
      </div>
      <div class="footer-col">
        <h4>Product</h4>
        <a href="#demo">Live Demo</a><a href="#features">Features</a><a href="#integrations">Integrations</a><a href="#pricing">Pricing</a>
      </div>
      <div class="footer-col">
        <h4>Resources</h4>
        <a href="#">Documentation</a><a href="#">Changelog</a><a href="#">Status</a>
      </div>
      <div class="footer-col">
        <h4>Company</h4>
        <a href="#">About</a><a href="#">Careers</a><a href="#">Contact</a>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© 2026 ForgeStudio. All rights reserved.</span>
      <span>Built inside ForgeStudio, obviously.</span>
    </div>
  </div>
</footer>
`;

export default function LandingPage() {
  return (
    <>
      <link rel="stylesheet" href="/landing.css" />
      <div dangerouslySetInnerHTML={{ __html: BODY_HTML }} />

      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"
        strategy="afterInteractive"
      />
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"
        strategy="afterInteractive"
      />
      <Script
        src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/ScrollTrigger.min.js"
        strategy="afterInteractive"
      />
      <Script src="/landing.js" strategy="afterInteractive" />
    </>
  );
}
