import { QdrantSearchResult } from '../qdrant.js';

/**
 * Maximal Marginal Relevance (MMR) implementation for re-ranking search results
 * Balances relevance and diversity in search results
 */

export interface MMROptions {
  lambda: number; // Balance between relevance (1.0) and diversity (0.0)
  fetchK: number; // Number of initial results to consider for MMR
}

export interface MMRResult extends QdrantSearchResult {
  originalScore: number;
  mmrScore: number;
  mmrRank: number;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i] || 0;
    const bVal = b[i] || 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Apply MMR re-ranking to search results
 */
export function applyMMR(
  results: QdrantSearchResult[],
  queryVector: number[],
  options: MMROptions,
  topK: number
): MMRResult[] {
  const { lambda, fetchK } = options;

  if (results.length === 0) {
    return [];
  }

  // Take only the top fetchK results for MMR processing
  const candidates = results.slice(0, Math.min(fetchK, results.length));

  // Ensure all candidates have vectors for MMR calculation
  const validCandidates = candidates.filter((result) => result.vector && result.vector.length > 0);

  if (validCandidates.length === 0) {
    // If no vectors available, return original results as MMR results
    return results.slice(0, topK).map((result, index) => ({
      ...result,
      originalScore: result.score,
      mmrScore: result.score,
      mmrRank: index + 1,
    }));
  }

  const selected: MMRResult[] = [];
  const remaining = [...validCandidates];

  // MMR selection loop
  while (selected.length < topK && remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const candidateVector = candidate.vector!;

      // Calculate relevance score (similarity to query)
      const relevanceScore = cosineSimilarity(queryVector, candidateVector);

      // Calculate diversity score (minimum similarity to already selected documents)
      let diversityScore = 0;
      if (selected.length > 0) {
        let maxSimilarity = -1;
        for (const selectedDoc of selected) {
          const similarity = cosineSimilarity(candidateVector, selectedDoc.vector!);
          maxSimilarity = Math.max(maxSimilarity, similarity);
        }
        diversityScore = -maxSimilarity; // Negative because we want to minimize similarity
      }

      // Calculate MMR score
      const mmrScore = lambda * relevanceScore + (1 - lambda) * diversityScore;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      const selectedCandidate = remaining.splice(bestIndex, 1)[0]!;
      selected.push({
        ...selectedCandidate,
        originalScore: selectedCandidate.score || 0,
        mmrScore: bestScore,
        mmrRank: selected.length + 1,
      } as MMRResult);
    } else {
      break; // No more valid candidates
    }
  }

  return selected;
}

/**
 * Simple diversity-based re-ranking without query vector
 * Useful when you only want to diversify results based on content similarity
 */
export function applyDiversityReranking(
  results: QdrantSearchResult[],
  diversityWeight: number = 0.3,
  topK: number
): MMRResult[] {
  if (results.length === 0) {
    return [];
  }

  const validCandidates = results.filter((result) => result.vector && result.vector.length > 0);

  if (validCandidates.length === 0) {
    return results.slice(0, topK).map((result, index) => ({
      ...result,
      originalScore: result.score,
      mmrScore: result.score,
      mmrRank: index + 1,
    }));
  }

  const selected: MMRResult[] = [];
  const remaining = [...validCandidates];

  // Select the first (highest scoring) result
  if (remaining.length > 0) {
    const first = remaining.shift()!;
    selected.push({
      ...first,
      originalScore: first.score,
      mmrScore: first.score,
      mmrRank: 1,
    });
  }

  // Select remaining results balancing score and diversity
  while (selected.length < topK && remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      const candidateVector = candidate.vector!;

      // Calculate diversity penalty (average similarity to selected documents)
      let diversityPenalty = 0;
      if (selected.length > 0) {
        let totalSimilarity = 0;
        for (const selectedDoc of selected) {
          totalSimilarity += cosineSimilarity(candidateVector, selectedDoc.vector!);
        }
        diversityPenalty = totalSimilarity / selected.length;
      }

      // Calculate final score with diversity penalty
      const adjustedScore =
        (candidate.score || 0) * (1 - diversityWeight) - diversityPenalty * diversityWeight;

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0) {
      const selectedCandidate = remaining.splice(bestIndex, 1)[0]!;
      selected.push({
        ...selectedCandidate,
        originalScore: selectedCandidate.score || 0,
        mmrScore: bestScore,
        mmrRank: selected.length + 1,
      } as MMRResult);
    } else {
      break;
    }
  }

  return selected;
}
