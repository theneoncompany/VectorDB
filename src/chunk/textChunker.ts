import { logger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface TextChunk {
  text: string;
  startIndex: number;
  endIndex: number;
  chunkIndex: number;
  tokens?: number;
}

export interface ChunkingOptions {
  chunkSize?: number; // Target tokens per chunk (approximate)
  overlap?: number; // Overlap percentage (0-50)
  preserveSentences?: boolean; // Try to keep sentences intact
  minChunkSize?: number; // Minimum chunk size in characters
}

export class TextChunker {
  private readonly avgTokensPerChar = 0.25; // Rough approximation: 1 token ≈ 4 characters

  /**
   * Estimate token count from character count
   * TODO: Replace with tiktoken for precise token counting when needed
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length * this.avgTokensPerChar);
  }

  /**
   * Convert token count to approximate character count
   */
  private tokensToChars(tokens: number): number {
    return Math.ceil(tokens / this.avgTokensPerChar);
  }

  /**
   * Split text into sentences (basic implementation)
   */
  private splitIntoSentences(text: string): string[] {
    // Basic sentence splitting - could be enhanced with more sophisticated NLP
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);

    return sentences;
  }

  /**
   * Find the best split point in text to preserve sentence boundaries
   */
  private findSentenceBoundary(text: string, targetPosition: number): number {
    // Look for sentence endings near the target position
    const searchRadius = Math.min(200, Math.floor(text.length * 0.1)); // 10% of text or 200 chars
    const start = Math.max(0, targetPosition - searchRadius);
    const end = Math.min(text.length, targetPosition + searchRadius);

    const searchText = text.slice(start, end);
    const sentenceEndings = /[.!?]\s+/g;
    let bestPosition = targetPosition;
    let minDistance = searchRadius;

    let match;
    while ((match = sentenceEndings.exec(searchText)) !== null) {
      const actualPosition = start + match.index + match[0].length;
      const distance = Math.abs(actualPosition - targetPosition);

      if (distance < minDistance) {
        minDistance = distance;
        bestPosition = actualPosition;
      }
    }

    return bestPosition;
  }

  /**
   * Chunk text into overlapping segments
   */
  chunk(text: string, options: ChunkingOptions = {}): TextChunk[] {
    const {
      chunkSize = 400, // tokens
      overlap = 15, // percentage
      preserveSentences = true,
      minChunkSize = 50, // characters
    } = options;

    if (text.length < minChunkSize) {
      return [
        {
          text: text.trim(),
          startIndex: 0,
          endIndex: text.length,
          chunkIndex: 0,
          tokens: this.estimateTokens(text),
        },
      ];
    }

    const chunks: TextChunk[] = [];
    const targetChunkChars = this.tokensToChars(chunkSize);
    const overlapChars = Math.floor(targetChunkChars * (overlap / 100));

    let currentIndex = 0;
    let chunkIndex = 0;

    while (currentIndex < text.length) {
      let endIndex = Math.min(currentIndex + targetChunkChars, text.length);

      // Try to preserve sentence boundaries if requested
      if (preserveSentences && endIndex < text.length) {
        const sentenceBoundary = this.findSentenceBoundary(text, endIndex);

        // Only use sentence boundary if it's not too far from target
        const distanceFromTarget = Math.abs(sentenceBoundary - endIndex);
        if (distanceFromTarget < targetChunkChars * 0.3) {
          endIndex = sentenceBoundary;
        }
      }

      const chunkText = text.slice(currentIndex, endIndex).trim();

      if (chunkText.length >= minChunkSize) {
        chunks.push({
          text: chunkText,
          startIndex: currentIndex,
          endIndex: endIndex,
          chunkIndex: chunkIndex++,
          tokens: this.estimateTokens(chunkText),
        });
      }

      // Calculate next starting position with overlap
      if (endIndex >= text.length) {
        break;
      }

      currentIndex = Math.max(
        currentIndex + 1, // Ensure progress
        endIndex - overlapChars
      );
    }

    logger.debug(
      {
        originalLength: text.length,
        chunksCount: chunks.length,
        avgChunkSize: chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) / chunks.length,
        chunkSize,
        overlap,
      },
      'Text chunking completed'
    );

    return chunks;
  }

  /**
   * Chunk text specifically optimized for embeddings
   */
  chunkForEmbedding(
    text: string,
    docId?: string,
    options: ChunkingOptions = {}
  ): Array<TextChunk & { id: string; docId?: string }> {
    const baseChunks = this.chunk(text, options);

    return baseChunks.map((chunk) => ({
      ...chunk,
      id: uuidv4(), // Generate UUID for Qdrant compatibility
      docId,
    }));
  }

  /**
   * Validate if text is suitable for chunking
   */
  validate(text: string, maxTokens: number = 8000): { valid: boolean; reason?: string } {
    if (!text || text.trim().length === 0) {
      return { valid: false, reason: 'Text is empty' };
    }

    const estimatedTokens = this.estimateTokens(text);
    if (estimatedTokens > maxTokens) {
      return {
        valid: false,
        reason: `Text too long: ~${estimatedTokens} tokens (max: ${maxTokens})`,
      };
    }

    return { valid: true };
  }
}

export const textChunker = new TextChunker();
