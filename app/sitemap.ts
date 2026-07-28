import { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://forge-studio-rosy.vercel.app', lastModified: new Date(), changeFrequency: 'weekly', priority: 1 },
    { url: 'https://forge-studio-rosy.vercel.app/privacy', lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
    { url: 'https://forge-studio-rosy.vercel.app/terms', lastModified: new Date(), changeFrequency: 'monthly', priority: 0.5 },
  ];
}
