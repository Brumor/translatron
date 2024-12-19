import { parseArgs } from "jsr:@std/cli@1.0.9/parse-args";
import { OpenAI } from "jsr:@openai/openai@4.75.0";
import { encode } from "npm:gpt-tokenizer@2.8.1";

interface StyleGuide {
  general?: string;
  locales?: Record<string, string>;
  projectContext?: {
    description?: string;
    domain?: string;
    targetAudience?: string;
  };
}

interface FileAnalysis {
  totalTokens: number;
  exceededLimit: boolean;
  chunkCount: number;
  recommendedChunks: Array<{
    start: number;
    end: number;
    tokens: number;
  }>;
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

const MAX_TOKENS = 4000; // GPT-3.5-turbo context limit
const BUFFER_TOKENS = 1000; // Increased buffer for safety
const DEFAULT_CHUNK_SIZE = 2000; // Default target size for each chunk

async function analyzeFile(filePath: string, targetChunkSize: number = DEFAULT_CHUNK_SIZE): Promise<FileAnalysis> {
  const content = await Deno.readTextFile(filePath);
  const jsonContent = JSON.parse(content);
  
  const jsonString = JSON.stringify(jsonContent);
  const tokens = encode(jsonString);
  const totalTokens = tokens.length;
  
  const exceededLimit = totalTokens > targetChunkSize;
  const recommendedChunks = [];
  
  if (exceededLimit) {
    const jsonEntries = Object.entries(jsonContent);
    
    let currentChunk = {
      start: 0,
      end: 0,
      tokens: 0,
    };
    
    for (const [index, [key, value]] of jsonEntries.entries()) {
      const entryTokens = encode(JSON.stringify({ [key]: value })).length;
      
      // Create new chunk if current would exceed target size
      if (currentChunk.tokens + entryTokens > targetChunkSize) {
        if (currentChunk.tokens > 0) {
          currentChunk.end = index - 1;
          recommendedChunks.push({ ...currentChunk });
        }
        currentChunk = {
          start: index,
          end: index,
          tokens: entryTokens,
        };
      } else {
        currentChunk.tokens += entryTokens;
        currentChunk.end = index;
      }
      
      // Validate chunk size
      if (currentChunk.tokens > MAX_TOKENS - BUFFER_TOKENS) {
        throw new Error(`Single entry too large: ${entryTokens} tokens`);
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
  
  const maxRetries = 3;
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

export async function translateJSON(
  filePath: string, 
  targetLocale: string, 
  styleGuidePath?: string,
  targetChunkSize: number = DEFAULT_CHUNK_SIZE
) {
  const analysis = await analyzeFile(filePath, targetChunkSize);
  const content = JSON.parse(await Deno.readTextFile(filePath));
  
  if (analysis.exceededLimit) {
    console.log(`Processing large file in ${analysis.chunkCount} chunks...`);
    
    const chunks = createChunksFromAnalysis(content, analysis.recommendedChunks);
    const results: TranslationResult[] = [];
    
    let styleGuide: StyleGuide = {};
    if (styleGuidePath) {
      const styleGuideContent = await Deno.readTextFile(styleGuidePath);
      styleGuide = JSON.parse(styleGuideContent);
    }
    
    for (const [index, chunk] of chunks.entries()) {
      console.log(`Processing chunk ${index + 1}/${chunks.length}...`);
      console.log(`Chunk size: ${chunk.tokens} tokens`);
      const result = await translateChunk(chunk, targetLocale, styleGuide);
      results.push(result);
    }
    
    const finalContent = reassembleTranslations(results);
    const outputPath = filePath.replace(".json", `_${targetLocale}.json`);
    await Deno.writeTextFile(outputPath, JSON.stringify(finalContent, null, 2));
    
    console.log(`Translation completed: ${outputPath}`);
    return;
  }

  try {
    // Read and parse JSON file
    const jsonContent = await Deno.readTextFile(filePath);
    const jsonData = JSON.parse(jsonContent);

    // Create prompt with style guides
    let styleGuide: StyleGuide = {};
    if (styleGuidePath) {
      const styleGuideContent = await Deno.readTextFile(styleGuidePath);
      styleGuide = JSON.parse(styleGuideContent);
    }

    const prompt = constructPrompt(jsonData, targetLocale, styleGuide);

    // Call OpenAI API
    const completion = await openai.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "gpt-3.5-turbo",
    });

    // Parse the response
    const translatedContent = completion.choices[0].message.content;
    const parsedTranslation = JSON.parse(translatedContent || "{}");

    // Generate output filename
    const outputPath = filePath.replace(".json", `_${targetLocale}.json`);

    // Write translated content
    await Deno.writeTextFile(
      outputPath,
      JSON.stringify(parsedTranslation, null, 2)
    );
    console.log(`Translation saved to: ${outputPath}`);

  } catch (error) {
    console.error("Error:", error);
    Deno.exit(1);
  }
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

  await translateJSON(args.file, args.locale, args["style-guide"], chunkSize);
}