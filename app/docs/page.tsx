export default function DocsPage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "60px 20px", color: "#e6e6e6" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: 16 }}>Documentation</h1>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>What is ForgeStudio?</h2>
      <p style={{ marginBottom: 16 }}>
        ForgeStudio turns a plain-language prompt into a working, deployable web app.
        Describe what you want to build, and ForgeStudio generates real code, runs it
        in a live sandbox so you can preview it instantly, and lets you keep refining
        it with follow-up instructions.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>Getting started</h2>
      <ol style={{ marginBottom: 16, paddingLeft: 20 }}>
        <li>Go to the Build page and type a description of the app or site you want</li>
        <li>Wait for the live preview to generate</li>
        <li>Use the edit box to refine it with follow-up instructions</li>
        <li>Export as a ZIP, push to GitHub, or deploy to Vercel when you're ready</li>
      </ol>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>Integrations</h2>
      <p style={{ marginBottom: 16 }}>
        ForgeStudio can connect to GitHub, Slack, Vercel, Supabase, and other services
        to extend what your generated app can do. Connect integrations from the
        Integrations panel on the Build page.
      </p>

      <h2 style={{ fontSize: "1.3rem", marginTop: 32, marginBottom: 12 }}>Need help?</h2>
      <p style={{ marginBottom: 16 }}>
        Visit our{" "}
        <a href="/support" style={{ color: "#4dd0e1" }}>Support page</a>{" "}
        or email{" "}
        <a href="mailto:ForgeStudio@gmail.com" style={{ color: "#4dd0e1" }}>
          ForgeStudio@gmail.com
        </a>.
      </p>
    </div>
  );
        }
