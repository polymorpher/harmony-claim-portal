const PAGES = [
  { href: "/", label: "Claim lookup" },
  { href: "/confirm", label: "Confirm activity" },
  { href: "/vault", label: "Governor Vaults" },
] as const;

export function Nav({ current }: { current: (typeof PAGES)[number]["href"] }) {
  return (
    <nav className="nav" aria-label="Pages">
      {PAGES.map((p) => (
        <a key={p.href} href={p.href} aria-current={p.href === current ? "page" : undefined}>
          {p.label}
        </a>
      ))}
    </nav>
  );
}
