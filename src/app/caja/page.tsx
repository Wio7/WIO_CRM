import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { CashApp } from '@/components/cash/cash-app';
export const dynamic = 'force-dynamic';
export default async function CashPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/caja');
  return <CashApp />;
}
