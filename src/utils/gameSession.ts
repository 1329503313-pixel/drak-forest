const STORAGE_KEY = "darkForest_gameResume";

export type GameResumePayload = {
  roomCode: string;
  resumeToken: string;
};

export function saveGameResume(roomCode: string, resumeToken: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ roomCode, resumeToken }));
  } catch {
    /* ignore */
  }
}

export function readGameResume(): GameResumePayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as unknown;
    if (
      !o ||
      typeof o !== "object" ||
      typeof (o as GameResumePayload).roomCode !== "string" ||
      typeof (o as GameResumePayload).resumeToken !== "string"
    )
      return null;
    return { roomCode: (o as GameResumePayload).roomCode, resumeToken: (o as GameResumePayload).resumeToken };
  } catch {
    return null;
  }
}

export function clearGameResume(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
