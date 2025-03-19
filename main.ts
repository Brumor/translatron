import { parseArgs } from "jsr:@std/cli@1.0.9/parse-args";
import { OpenAI } from "jsr:@openai/openai@4.75.0";
import { findMissingTranslations, mergeTranslations } from "./src/utils.ts";
import { 
  analyzeContent, 
  type FileAnalysis, 
  MAX_TOKENS, 
  BUFFER_TOKENS, 
  DEFAULT_CHUNK_SIZE, 
  subdivideChunk
} from "./src/analyzer.ts";

interface StyleGuide {
  general?: string;
  locales?: Record<string, string>;
  projectContext?: {
    description?: string;
    domain?: string;
    targetAudience?: string;
  };
}

interface Chunk {
  content: Record<string, unknown>;
  path: string[];
  tokens: number;
}

interface TranslationResult {
  originalPath: string[];
  translatedContent: Record<string, unknown>;
}

// Remove current createChunks function and replace with:
function createChunksFromAnalysis(json: Record<string, unknown>, chunks: FileAnalysis['recommendedChunks']): Chunk[] {
  const entries = Object.entries(json);
  return chunks.map(chunk => {
    const chunkEntries = entries.slice(chunk.start, chunk.end + 1);
    const content = Object.fromEntries(chunkEntries);
    return {
      content,
      path: [], // Keeping path empty as it's not used in current implementation
      tokens: chunk.tokens
    };
  });
}

function constructPrompt(content: Record<string, unknown>, targetLocale: string, styleGuide?: StyleGuide): string {
  let prompt = `You are a JSON translator. Your task is to:
1. Translate the following JSON content to ${targetLocale}
2. Keep all JSON structure and keys exactly the same
3. Only translate string values
4. Return ONLY complete, valid JSON
5. Start your response with { and end with }
6. Maintain all numbers, booleans, and null values as is
7. Ensure all brackets and braces are properly closed\n\n`;

  if (styleGuide?.projectContext) {
    const ctx = styleGuide.projectContext;
    prompt += "Project Context:\n";
    if (ctx.description) prompt += `Description: ${ctx.description}\n`;
    if (ctx.domain) prompt += `Domain: ${ctx.domain}\n`;
    if (ctx.targetAudience) prompt += `Target Audience: ${ctx.targetAudience}\n\n`;
  }

  if (styleGuide?.general) {
    prompt += `General style guide:\n${styleGuide.general}\n\n`;
  }

  if (styleGuide?.locales?.[targetLocale]) {
    prompt += `Specific style guide for ${targetLocale}:\n${styleGuide.locales[targetLocale]}\n\n`;
  }

  prompt += `Content to translate (your response must be valid JSON):\n${JSON.stringify(content, null, 2)}`;
  return prompt;
}

function validateAndRepairJSON(jsonString: string): Record<string, unknown> {
  try {
    // Try parsing as-is first
    return JSON.parse(jsonString);
  } catch (error) {
    // Check for common issues and try to repair
    const repairedJson = jsonString
      .trim()
      // Remove any non-JSON text before {
      .replace(/^[^{]*({.*$)/, '$1')
      // Remove any non-JSON text after }
      .replace(/^(.*})[^}]*$/, '$1');

    try {
      return JSON.parse(repairedJson);
    } catch {
      if (error instanceof Error) {
        console.log(repairedJson)
        throw new Error(`Unable to repair invalid JSON: ${error.message}`);
      } else {
        throw new Error("Unable to repair invalid JSON: Unknown error");
      }
    }
  }
}

async function translateChunk(chunk: Chunk, targetLocale: string, styleGuide?: StyleGuide): Promise<TranslationResult> {
  const prompt = constructPrompt(chunk.content, targetLocale, styleGuide);
  
  const maxRetries = 1;
  let attempts = 0;
  let lastError: Error | null = null;

  while (attempts < maxRetries) {
    try {
      const completion = await openai.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "gpt-3.5-turbo",
        temperature: 0.1, // Lower temperature for more consistent JSON
      });

      const response = completion.choices[0].message.content || "{}";
      const translatedContent = validateAndRepairJSON(response);
      
      // Verify structure matches original
      const originalKeys = Object.keys(chunk.content);
      const translatedKeys = Object.keys(translatedContent);
      
      if (!originalKeys.every(key => translatedKeys.includes(key))) {
        throw new Error("Translation missing original keys");
      }

      return {
        originalPath: chunk.path,
        translatedContent
      };
    } catch (error) {
      lastError = error as Error;
      attempts++;
      console.log(`Chunk translation attempt ${attempts} failed: ${(error as Error).message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // Exponential backoff
    }
  }

  throw new Error(`Failed to translate chunk after ${maxRetries} attempts: ${lastError?.message}`);
}

async function translateChunkWithFallback(
  chunk: Chunk, 
  targetLocale: string, 
  styleGuide?: StyleGuide,
  depth: number = 0
): Promise<TranslationResult[]> {
  try {
    const result = await translateChunk(chunk, targetLocale, styleGuide);
    return [result];
  } catch (error) {
    if (depth >= 3) { // Maximum recursion depth
      throw error;
    }

    console.log(`Chunk translation failed, subdividing...`);
    
    // Analyze chunk content with smaller size
    const subAnalysis = subdivideChunk(chunk.content, chunk.tokens);
    
    if (!subAnalysis.exceededLimit) {
      // If chunk is too small to divide further, rethrow
      throw error;
    }

    // Create smaller chunks
    const subChunks = createChunksFromAnalysis(chunk.content, subAnalysis.recommendedChunks);
    
    // Process each sub-chunk
    const results: TranslationResult[] = [];
    for (const subChunk of subChunks) {
      const subResults = await translateChunkWithFallback(
        subChunk,
        targetLocale,
        styleGuide,
        depth + 1
      );
      results.push(...subResults);
    }
    
    return results;
  }
}

function reassembleTranslations(results: TranslationResult[]): Record<string, unknown> {
  try {
    const assembled = results.reduce((acc, result) => ({
      ...acc,
      ...result.translatedContent
    }), {});

    // Validate final JSON
    JSON.stringify(assembled);
    return assembled;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to reassemble translations: ${error.message}`);
    } else {
      throw new Error("Failed to reassemble translations: Unknown error");
    }
  }
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY") || "",
});

export async function translateJsonFile(
  filePath: string, 
  targetLocale: string, 
  styleGuidePath?: string,
  targetChunkSize: number = DEFAULT_CHUNK_SIZE
) {
  const content = JSON.parse(await Deno.readTextFile(filePath));
  const outputPath = filePath.replace(/[^\\/]+(?=\.[^\\/]+$)/, targetLocale);
  
  // Check for existing translations
  let existingTranslations: Record<string, unknown> = {};
  try {
    const existingContent = await Deno.readTextFile(outputPath);
    existingTranslations = JSON.parse(existingContent);
  } catch {
    // File doesn't exist or is invalid, continue with empty translations
  }

  const finalContent = await translateJsonString(content, targetLocale, existingTranslations, styleGuidePath ? JSON.parse(await Deno.readTextFile(styleGuidePath)) : undefined, targetChunkSize);
  
  // Write final content
  await Deno.writeTextFile(outputPath, JSON.stringify(finalContent, null, 2));
  console.log(`Translation updated: ${outputPath}`);
}

export async function translateJsonString(
  content: Record<string, unknown>,
  targetLocale: string,
  existingTranslations: Record<string, unknown> = {},
  styleGuide?: StyleGuide,
  targetChunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<Record<string, unknown>> {
  // Find missing translations
  const missingTranslations = findMissingTranslations(content, existingTranslations);
  
  if (Object.keys(missingTranslations).length === 0) {
    console.log('All keys are already translated');
    return existingTranslations;
  }

  // Analyze missing translations
  const analysis = await analyzeContent(missingTranslations, targetChunkSize);
  
  let translatedContent: Record<string, unknown>;
  
  if (analysis.exceededLimit) {
    console.log(`Processing ${Object.keys(missingTranslations).length} missing keys in ${analysis.chunkCount} chunks...`);
    
    const chunks = createChunksFromAnalysis(missingTranslations, analysis.recommendedChunks);
    const results: TranslationResult[] = [];
    
    for (const [index, chunk] of chunks.entries()) {
      console.log(`Processing chunk ${index + 1}/${chunks.length}...`);
      try {
        const chunkResults = await translateChunkWithFallback(chunk, targetLocale, styleGuide);
        results.push(...chunkResults);
      } catch (error) {
        console.error(`Failed to translate chunk after all retries:`, error);
        throw error;
      }
    }
    
    translatedContent = reassembleTranslations(results);
  } else {
    const result = await translateChunk(
      { content: missingTranslations, path: [], tokens: analysis.totalTokens },
      targetLocale,
      styleGuide
    );
    translatedContent = result.translatedContent;
  }

  // Merge with existing translations
  return mergeTranslations(existingTranslations, translatedContent);
}

// Update CLI parsing
if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["file", "locale", "style-guide", "chunk-size"],
    alias: {
      f: "file",
      l: "locale",
      s: "style-guide",
      c: "chunk-size",
    },
  });
  
  if (!args.file || !args.locale) {
    console.error(`Usage: deno run main.ts -f <json-file> -l <target-locale> [-s <style-guide-json>] [-c <chunk-size>]
Options:
  -f, --file        Path to JSON file to translate
  -l, --locale      Target locale (e.g., es, fr)
  -s, --style-guide Path to style guide JSON file
  -c, --chunk-size  Target chunk size in tokens (default: ${DEFAULT_CHUNK_SIZE})`);
    Deno.exit(1);
  }

  const chunkSizeArg = args["chunk-size"];
  const chunkSize = chunkSizeArg ?  parseInt(chunkSizeArg, 10) : DEFAULT_CHUNK_SIZE;
  
  // Validate chunk size
  if (chunkSize >= MAX_TOKENS - BUFFER_TOKENS) {
    console.error(`Chunk size (${chunkSize}) must be less than ${MAX_TOKENS - BUFFER_TOKENS} tokens`);
    Deno.exit(1);
  }

  await translateJsonFile(args.file, args.locale, args["style-guide"], chunkSize);
}
