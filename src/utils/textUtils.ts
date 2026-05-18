// Constants
const SIMILARITY_THRESHOLD = 0.66;

// --- Utility Functions ---

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

export function calculateSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLength = Math.max(a.length, b.length);
  return 1 - distance / maxLength;
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.!?。！？，,;；:：\s]+$/, '');
}

function isContinuation(oldText: string, newText: string): boolean {
  if (!oldText || !newText) return false;
  const oldStripped = stripTrailingPunctuation(oldText).toLowerCase();
  const newLower = newText.toLowerCase();
  return newLower.startsWith(oldStripped) && newLower.length > oldStripped.length;
}

export function shouldOverwrite(oldText: string, newText: string): boolean {
  if (!oldText || !newText) return false;
  if (isContinuation(oldText, newText)) return true;
  return calculateSimilarity(oldText, newText) > SIMILARITY_THRESHOLD;
}

function isDecimalPoint(text: string, dotIndex: number): boolean {
  if (dotIndex <= 0 || dotIndex >= text.length - 1) return false;
  return /\d/.test(text[dotIndex - 1]) && /\d/.test(text[dotIndex + 1]);
}

export function isEOSPunctuation(text: string, index: number): boolean {
  const char = text[index];
  if (char === '!' || char === '?' || char === '。' || char === '！' || char === '？') return true;
  if (char === '.') return !isDecimalPoint(text, index);
  return false;
}

function findLastEOSIndex(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (isEOSPunctuation(text, i)) return i;
  }
  return -1;
}

export function getLatestCaption(text: string): string {
  if (!text.trim()) return "";
  const lastEOS = findLastEOSIndex(text);
  return lastEOS >= 0 ? text.slice(lastEOS + 1).trim() : text.trim();
}

export function generateId(): string {
  return crypto.randomUUID();
}
