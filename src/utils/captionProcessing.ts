
import { isEOSPunctuation, calculateSimilarity } from "./textUtils";

function normalizeSentenceForHistory(text: string): string {
    return text
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .replace(/[.!?。！？,，;；:：]+$/g, "")
        .trim()
        .toLowerCase();
}

function isMeaningfulSentence(text: string): boolean {
    return normalizeSentenceForHistory(text).length > 0;
}

/**
 * Splits a continuous text block into an array of complete sentences.
 * Ignores any trailing incomplete sentence.
 */
export function splitIntoSentences(text: string): string[] {
    const sentences: string[] = [];
    let start = 0;
    
    // We iterate through the text and slice at every EOS punctuation
    for (let i = 0; i < text.length; i++) {
        if (isEOSPunctuation(text, i)) {
            // Found a sentence boundary
            const sentence = text.slice(start, i + 1).trim();
            if (sentence && isMeaningfulSentence(sentence)) {
                sentences.push(sentence);
            }
            start = i + 1;
        }
    }
    
    return sentences;
}

/**
 * Identifies new sentences in the current text buffer compared to the previous buffer.
 * Handles sliding windows (old sentences dropping off) and corrections.
 */
export function getNewSentences(currentText: string, lastText: string): string[] {
    const currentSentences = splitIntoSentences(currentText);
    const lastSentences = splitIntoSentences(lastText);
    const matchThreshold = 0.8;

    if (lastSentences.length === 0) return currentSentences;
    if (currentSentences.length === 0) return [];

    // Prefer the longest overlap between the suffix of last and prefix of current.
    // This is resilient when caption providers resend history windows.
    const maxOverlap = Math.min(lastSentences.length, currentSentences.length);
    for (let overlap = maxOverlap; overlap >= 1; overlap--) {
        const lastStart = lastSentences.length - overlap;
        let isMatch = true;
        for (let i = 0; i < overlap; i++) {
            if (calculateSimilarity(lastSentences[lastStart + i], currentSentences[i]) <= matchThreshold) {
                isMatch = false;
                break;
            }
        }
        if (isMatch) {
            return currentSentences.slice(overlap);
        }
    }

    // If current starts with older history (not the latest tail), locate last tail sentence
    // and treat only sentences after it as new.
    const lastExisting = lastSentences[lastSentences.length - 1];
    if (lastExisting) {
        for (let i = 0; i < currentSentences.length; i++) {
            if (calculateSimilarity(lastExisting, currentSentences[i]) <= matchThreshold) {
                continue;
            }

            let verified = true;
            if (lastSentences.length >= 2 && i >= 1) {
                const secondLast = lastSentences[lastSentences.length - 2];
                if (calculateSimilarity(secondLast, currentSentences[i - 1]) <= matchThreshold) {
                    verified = false;
                }
            }

            if (verified) {
                return currentSentences.slice(i + 1);
            }
        }
    }
    
    // If no overlap found (e.g. disjoint or correction), return all current sentences
    return currentSentences;
}

/**
 * Filters out sentences that are duplications of the recent history.
 * This handles cases where the caption source artificially repeats a sequence of sentences.
 * (文比较去重)
 */
export function filterDuplicateSentences(existingSentences: string[], newSentences: string[]): string[] {
    if (existingSentences.length === 0) return newSentences;
    if (newSentences.length === 0) return [];

    // Look back at most 10 sentences to check for duplicate sequences
    const lookback = Math.min(existingSentences.length, 10);
    const recentExisting = existingSentences.slice(-lookback);
    const recentHistory = existingSentences
        .map(normalizeSentenceForHistory)
        .filter(Boolean);
    const recentHistorySet = new Set(recentHistory);

    // 1. Forward check: Check if newSentences starts with the end of existingSentences
    // Existing: [A, B, C]
    // New: [B, C, D]
    // Match: B, C -> Overlap 2 -> Result: [D]
    for (let i = 0; i < recentExisting.length; i++) {
        // Check if the sequence starting at recentExisting[i] matches the start of newSentences
        if (calculateSimilarity(recentExisting[i], newSentences[0]) > 0.8) {
            let match = true;
            let overlapCount = 0;
            
            const suffixLength = recentExisting.length - i;
            
            for (let j = 0; j < suffixLength; j++) {
                if (j >= newSentences.length) {
                    overlapCount = newSentences.length; 
                    break; 
                }
                
                if (calculateSimilarity(recentExisting[i + j], newSentences[j]) <= 0.8) {
                    match = false;
                    break;
                }
                overlapCount++;
            }
            
            if (match) {
                const isSequence = overlapCount > 1;
                const isLongSentence = overlapCount === 1 && newSentences[0].length > 10;
                
                if (isSequence || isLongSentence) {
                     return newSentences.slice(overlapCount);
                }
            }
        }
    }

    // 2. Backward check: Check if existingSentences end is contained SOMEWHERE in newSentences
    // This handles cases where Teams dumps history *before* the current point
    // Existing: [A, B, C]
    // New: [A, B, C, D] (Context expanded backwards)
    // We want to find C in New, and take only D.
    
    // We verify using the last few sentences of existing to ensure strong lock
    const lastExisting = existingSentences[existingSentences.length - 1];
    if (lastExisting) {
        // Scan newSentences to find where lastExisting appears
        for (let i = 0; i < newSentences.length; i++) {
            if (calculateSimilarity(lastExisting, newSentences[i]) > 0.8) {
                // Found a potential sync point at New[i]
                // Verify backwards if possible to be sure
                // For simplicity, if the last sentence matches, we assume everything before it in New is also history
                // and everything after it is fresh.
                
                // Double check if we have more context to verify
                let verified = true;
                if (existingSentences.length >= 2 && i >= 1) {
                     const secondLast = existingSentences[existingSentences.length - 2];
                     if (calculateSimilarity(secondLast, newSentences[i - 1]) <= 0.8) {
                         verified = false;
                     }
                }
                
                if (verified) {
                    // Match confirmed. New sentences are only those AFTER index i.
                    return newSentences.slice(i + 1);
                }
            }
        }
    }

    // If the current snapshot replayed older history, anchor at the last recently emitted
    // sentence we can find anywhere in the candidate list, then keep only the suffix after it.
    for (let i = newSentences.length - 1; i >= 0; i--) {
        const normalized = normalizeSentenceForHistory(newSentences[i]);
        if (normalized && recentHistorySet.has(normalized)) {
            return newSentences
                .slice(i + 1)
                .filter(sentence => {
                    const candidate = normalizeSentenceForHistory(sentence);
                    return candidate.length > 0 && !recentHistorySet.has(candidate);
                });
        }
    }

    return newSentences.filter(sentence => {
        const normalized = normalizeSentenceForHistory(sentence);
        return normalized.length > 0 && !recentHistorySet.has(normalized);
    });
}
