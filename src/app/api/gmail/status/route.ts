import { getGmailConfig } from '@/lib/gmail-api';

export async function GET() {
  const config = await getGmailConfig();

  if (!config) {
    return Response.json({ connected: false });
  }

  return Response.json({
    connected: true,
    email: config.email,
    last_sync_at: config.last_sync_at,
    processed_count: config.processed_thread_ids.length,
    filtres_fournisseurs: config.filtres_fournisseurs ?? [],
  });
}
