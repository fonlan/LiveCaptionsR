
import { isEOSPunctuation, calculateSimilarity } from "./textUtils";

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
            if (sentence) {
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

    if (lastSentences.length === 0) return currentSentences;
    if (currentSentences.length === 0) return [];

    // Find where currentSentences starts in lastSentences (Overlap)
    // We look for the longest suffix of lastSentences that matches a prefix of currentSentences
    
    // Iterate through LastSentences to find the start of CurrentSentences[0]
    for (let i = 0; i < lastSentences.length; i++) {
        // Use fuzzy matching for the start of overlap
        // If similarity > 0.8, consider it a match to account for minor corrections
        if (calculateSimilarity(lastSentences[i], currentSentences[0]) > 0.8) {
            // Potential match start
            // Verify subsequent matches
            let match = true;
            let overlapCount = 0;
            for (let j = 0; j < lastSentences.length - i; j++) {
                if (j >= currentSentences.length) {
                    // Current is shorter than the tail of Last? (Rare, but possible if deletions)
                    break; 
                }
                
                // Compare subsequent sentences with fuzzy matching
                if (calculateSimilarity(lastSentences[i + j], currentSentences[j]) <= 0.8) {
                    match = false;
                    break;
                }
                overlapCount++;
            }
            
            if (match) {
                // We found that Current starts at Last[i]
                // The new sentences are from Current[overlapCount...]
                return currentSentences.slice(overlapCount);
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

    for (let i = 0; i < recentExisting.length; i++) {
        // Check if the sequence starting at recentExisting[i] matches the start of newSentences
        if (calculateSimilarity(recentExisting[i], newSentences[0]) > 0.8) {
            let match = true;
            let overlapCount = 0;
            
            const suffixLength = recentExisting.length - i;
            
            for (let j = 0; j < suffixLength; j++) {
                if (j >= newSentences.length) {
                    // New sentences are fully contained in the existing suffix
                    overlapCount = newSentences.length; // Consume all
                    break; 
                }
                
                if (calculateSimilarity(recentExisting[i + j], newSentences[j]) <= 0.8) {
                    match = false;
                    break;
                }
                overlapCount++;
            }
            
            if (match) {
                // We found that newSentences starts with a sequence that already exists at the end of existingSentences
                
                // Heuristic: Only filter if it's a SEQUENCE repetition (more than 1 sentence) 
                // OR if it's a long enough sentence (> 10 chars) to be considered a unique thought rather than a short interjection like "Yes" or "Hello".
                const isSequence = overlapCount > 1;
                const isLongSentence = overlapCount === 1 && newSentences[0].length > 10;
                
                if (isSequence || isLongSentence) {
                     return newSentences.slice(overlapCount);
                }
                // Otherwise, preserve the repetition (e.g. user saying "Hello." twice)
            }
        }
    }
    
    return newSentences;
}
