CREATE TABLE IF NOT EXISTS offertes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL DEFAULT 'Nieuwe Offerte',
  data jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE offertes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all for authenticated offertes" ON offertes FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_offertes_created_by ON offertes(created_by);
CREATE INDEX IF NOT EXISTS idx_offertes_updated_at ON offertes(updated_at);
CREATE OR REPLACE TRIGGER update_offertes_updated_at BEFORE UPDATE ON offertes FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
