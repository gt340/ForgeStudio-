'use client';

import { useState, useEffect } from 'react';

export default function SeoPanel() {
  const [metaTitle, setMetaTitle] = useState('');
  const [metaDescription, setMetaDescription] = useState('');
  const [ogImageUrl, setOgImageUrl] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    fetch('/api/seo-settings')
      .then((res) => res.json())
      .then((data) => {
        const latest = data.settings?.[0];
        if (latest) {
          setMetaTitle(latest.meta_title || '');
          setMetaDescription(latest.meta_description || '');
          setOgImageUrl(latest.og_image_url || '');
          setFaviconUrl(latest.favicon_url || '');
        }
      });
  }, []);

  const handleSave = async () => {
    setStatus('Saving...');
    const res = await fetch('/api/seo-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta_title: metaTitle,
        meta_description: metaDescription,
        og_image_url: ogImageUrl,
        favicon_url: faviconUrl,
      }),
    });
    setStatus(res.ok ? 'Saved ✓' : 'Error saving');
  };

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginTop: 16 }}>
      <h3 style={{ marginBottom: 12 }}>SEO Settings</h3>

      <label>Meta Title</label>
      <input
        style={{ width: '100%', marginBottom: 8, padding: 6 }}
        value={metaTitle}
        onChange={(e) => setMetaTitle(e.target.value)}
        placeholder="Your site title"
      />

      <label>Meta Description</label>
      <textarea
        style={{ width: '100%', marginBottom: 8, padding: 6 }}
        value={metaDescription}
        onChange={(e) => setMetaDescription(e.target.value)}
        placeholder="Short description for search engines"
      />

      <label>OG Image URL</label>
      <input
        style={{ width: '100%', marginBottom: 8, padding: 6 }}
        value={ogImageUrl}
        onChange={(e) => setOgImageUrl(e.target.value)}
        placeholder="https://example.com/og-image.png"
      />

      <label>Favicon URL</label>
      <input
        style={{ width: '100%', marginBottom: 8, padding: 6 }}
        value={faviconUrl}
        onChange={(e) => setFaviconUrl(e.target.value)}
        placeholder="https://example.com/favicon.ico"
      />

      <button onClick={handleSave} style={{ padding: '8px 16px', marginTop: 8 }}>
        Save SEO Settings
      </button>
      {status && <p style={{ marginTop: 8 }}>{status}</p>}
    </div>
  );
}
