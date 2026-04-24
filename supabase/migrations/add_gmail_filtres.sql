-- Migration: filtres fournisseurs pour le scan Gmail
ALTER TABLE gmail_config
  ADD COLUMN IF NOT EXISTS filtres_fournisseurs text[] NOT NULL DEFAULT '{}';
