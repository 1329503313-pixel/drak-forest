const K_ACCOUNT = "df_game_account";

export function loadGameAccount(): string | null {
  try {
    const v = localStorage.getItem(K_ACCOUNT)?.trim();
    return v || null;
  } catch {
    return null;
  }
}

export function saveGameAccount(gameAccountId: string): void {
  try {
    localStorage.setItem(K_ACCOUNT, gameAccountId.trim());
  } catch {
    /* ignore */
  }
}

export function clearGameAccount(): void {
  try {
    localStorage.removeItem(K_ACCOUNT);
  } catch {
    /* ignore */
  }
}
