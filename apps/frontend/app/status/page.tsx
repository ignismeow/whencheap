import Link from 'next/link';

export default function StatusPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="text-2xl font-semibold">Status</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Intent-specific status views will live here once transaction execution is wired in.
      </p>
      <Link className="mt-5 inline-block text-sm font-semibold text-[var(--accent)]" href="/app">
        Back to console
      </Link>
    </main>
  );
}
