import { redirect } from 'next/navigation';
// Root URL sends visitors straight to the live portal. CHANGED 7 Jul 2026 (Michael): this used to
// redirect to /Cinch_Portal.html, a static jQuery-based mockup from before the real Next.js/Supabase
// build existed — that file (plus its public/js, public/css, public/assets, public/index.html
// scaffolding) has been deleted entirely since portal-v2 has no dependency on any of it (confirmed via
// repo-wide grep). portal-v2 is now the ONLY portal in this app — one URL, no more "which one is this."
export default function Home() {
  redirect('/portal-v2');
}
