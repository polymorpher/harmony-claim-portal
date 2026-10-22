/** Public name: a governor's signed name when one is stored, otherwise the catalog name. */
export function displayVaultName(
  entry: { vault: string; name: string; validator_one1: string },
  names: ReadonlyMap<string, string> | undefined,
): string {
  return names?.get(entry.vault.toLowerCase()) || entry.name || entry.validator_one1;
}

export function vaultMatchesQuery(
  entry: { name: string; validator_one1: string; validator: string; vault: string },
  display: string,
  needle: string,
): boolean {
  if (!needle) return true;
  return (
    display.toLowerCase().includes(needle) ||
    entry.name.toLowerCase().includes(needle) ||
    entry.validator_one1.toLowerCase().includes(needle) ||
    entry.validator.toLowerCase().includes(needle) ||
    entry.vault.toLowerCase().includes(needle)
  );
}
