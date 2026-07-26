export default function PrivacyPolicy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "60px 24px", lineHeight: 1.7 }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: {new Date().toLocaleDateString()}</em></p>

      <h2>What we collect</h2>
      <p>ForgeStudio collects the information you provide when you create an account, generate a site, or connect a third-party integration (such as Stripe, Supabase, Slack, GitHub, or Google Business Profile). This may include your email address, prompts you submit for site generation, and data returned by connected services.</p>

      <h2>How we use it</h2>
      <p>We use your information to generate websites and apps on your behalf, store your environment variables and integration connections securely, and build installable app packages when you request them.</p>

      <h2>Third-party integrations</h2>
      <p>When you connect a third-party service, ForgeStudio accesses only the data needed to provide that integration, and only after you explicitly authorize it. You can disconnect any integration at any time from the Integrations panel, which revokes our access.</p>

      <h2>Data storage</h2>
      <p>Your data is stored using Supabase with row-level security enabled, so only your account can access your own data.</p>

      <h2>Contact</h2>
      <p>Questions about this policy can be sent to ForgeStudio@gmail.com. For business inquiries, contact trustGodcompany@gmail.com.</p>
    </main>
  );
}
