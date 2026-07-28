CREATE TABLE seo_settings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  meta_title text,
  meta_description text,
  og_image_url text,
  favicon_url text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE seo_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access" ON seo_settings
  FOR ALL USING (true) WITH CHECK (true);

GRANT ALL ON seo_settings TO anon, authenticated;
