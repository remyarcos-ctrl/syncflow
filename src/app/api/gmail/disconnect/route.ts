import { createClient } from '@supabase/supabase-js';

export async function POST() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  await sb.from('gmail_config').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  return Response.json({ ok: true });
}
