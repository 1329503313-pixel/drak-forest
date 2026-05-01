const K_NICK = "df_nickname";
const K_AVATAR = "df_avatar";

export function loadNickname(): string | null {
  try {
    return localStorage.getItem(K_NICK);
  } catch {
    return null;
  }
}

export function saveNickname(v: string): void {
  try {
    localStorage.setItem(K_NICK, v);
  } catch {
    /* ignore */
  }
}

export function loadAvatar(): string | null {
  try {
    return localStorage.getItem(K_AVATAR);
  } catch {
    return null;
  }
}

export function saveAvatar(dataUrl: string): void {
  try {
    localStorage.setItem(K_AVATAR, dataUrl);
  } catch {
    /* ignore */
  }
}
