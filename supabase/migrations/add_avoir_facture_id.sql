-- Lien entre une ligne de retour et la facture d'avoir reçue
ALTER TABLE lignes_be
  ADD COLUMN IF NOT EXISTS avoir_facture_id uuid REFERENCES factures(id);

-- Bucket Supabase Storage pour les PDFs importés (à exécuter via le dashboard Supabase)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('documents', 'documents', true)
-- ON CONFLICT DO NOTHING;
-- CREATE POLICY "Public read documents" ON storage.objects FOR SELECT USING (bucket_id = 'documents');
-- CREATE POLICY "Anon insert documents" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'documents');
