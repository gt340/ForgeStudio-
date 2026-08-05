export default function SupportPage() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "60px 20px", color: "#e6e6e6" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: 16 }}>Support</h1>
      <p style={{ marginBottom: 16 }}>
        Need help with ForgeStudio? We're happy to assist.
      </p>
      <p style={{ marginBottom: 16 }}>
        Email us at{" "}
        <a href="mailto:ForgeStudio@gmail.com" style={{ color: "#4dd0e1" }}>
          ForgeStudio@gmail.com
        </a>{" "}
        and we'll get back to you as soon as we can.
      </p>
      <p style={{ marginBottom: 16 }}>
        Common topics we can help with:
      </p>
      <ul style={{ marginBottom: 16, paddingLeft: 20 }}>
        <li>Connecting integrations (GitHub, Slack, Vercel, etc.)</li>
        <li>Deploying or exporting your generated site</li>
        <li>Account or billing questions</li>
        <li>Reporting a bug</li>
      </ul>
    </div>
  );
      }
