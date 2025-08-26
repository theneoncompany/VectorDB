export interface EmbeddingChunk {
  text: string;
  startIndex: number;
  endIndex: number;
  tokens?: number;
}

export interface EmbeddingResult {
  chunk: EmbeddingChunk;
  embedding: number[];
}

export interface EmbeddingProvider {
  /**
   * Generate embeddings for a single text string
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple text chunks in batch
   */
  embedBatch(texts: string[]): Promise<number[][]>;

  /**
   * Get the dimension size of the embeddings
   */
  getDimensions(): number;

  /**
   * Get the maximum input length (in tokens/characters)
   */
  getMaxInputLength(): number;

  /**
   * Get the provider name
   */
  getProviderName(): string;
}
