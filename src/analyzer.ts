import { encode } from "gpt-tokenizer";

export interface FileAnalysis {
  totalTokens: number;
  exceededLimit: boolean;
  chunkCount: number;
  recommendedChunks: Array<{
    start: number;
    end: number;
    tokens: number;
  }>;
}

export const MAX_TOKENS = 4000;
export const BUFFER_TOKENS = 1000;
export const DEFAULT_CHUNK_SIZE = 2000;

export function analyzeContent(
  content: Record<string, unknown>,
  targetChunkSize: number = DEFAULT_CHUNK_SIZE,
): FileAnalysis {
  const jsonString = JSON.stringify(content);
  const tokens = encode(jsonString);
  const totalTokens = tokens.length;

  const exceededLimit = totalTokens > targetChunkSize;
  const recommendedChunks = [];

  if (exceededLimit) {
    const jsonEntries = Object.entries(content);
    let currentChunk = { start: 0, end: 0, tokens: 0 };

    for (const [index, [key, value]] of jsonEntries.entries()) {
      const entryTokens = encode(JSON.stringify({ [key]: value })).length;

      if (currentChunk.tokens + entryTokens > targetChunkSize) {
        if (currentChunk.tokens > 0) {
          recommendedChunks.push({ ...currentChunk });
        }
        currentChunk = { start: index, end: index, tokens: entryTokens };
      } else {
        currentChunk.tokens += entryTokens;
        currentChunk.end = index;
      }
    }

    if (currentChunk.tokens > 0) {
      recommendedChunks.push(currentChunk);
    }
  }

  return {
    totalTokens,
    exceededLimit,
    chunkCount: recommendedChunks.length || 1,
    recommendedChunks,
  };
}

// Add function to divide chunk into smaller pieces
export function subdivideChunk(
  content: Record<string, unknown>,
  currentChunkSize: number,
): FileAnalysis {
  // Reduce chunk size by half, but not below 500 tokens
  const newChunkSize = Math.max(500, Math.floor(currentChunkSize / 2));
  return analyzeContent(content, newChunkSize);
}
