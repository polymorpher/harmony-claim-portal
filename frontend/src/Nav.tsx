// An unlisted page's tab shows only on that page, so other pages do not link to it.
const PAGES: readonly { href: string; label: string; unlisted?: boolean }[] = [
  { href: "/", label: "Claim lookup" },
  { href: "/confirm", label: "Confirm activity" },
  { href: "/vault", label: "Governor Vaults" },
  { href: "/history", label: "Transaction history" },
  { href: "/bridge", label: "Bridge claims", unlisted: true },
];

export function Nav({ current }: { current: "/" | "/confirm" | "/vault" | "/history" | "/bridge" | null }) {
  return (
    <nav className="nav" aria-label="Pages">
      {PAGES.filter((p) => !p.unlisted || p.href === current).map((p) => (
        <a key={p.href} href={p.href} aria-current={p.href === current ? "page" : undefined}>
          {p.label}
        </a>
      ))}
    </nav>
  );
}
