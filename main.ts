import { parseArgs } from "jsr:@std/cli@1.0.9/parse-args";
import { OpenAI } from "jsr:@openai/openai@4.75.0";
import { findMissingTranslations, mergeTranslations } from "./src/utils.ts";
import {
  analyzeContent,
  BUFFER_TOKENS,
  DEFAULT_CHUNK_SIZE,
  type FileAnalysis,
  MAX_TOKENS,
  subdivideChunk,
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

export class Translatron {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || Deno.env.get("OPENAI_API_KEY") || "",
    });
  }

  private createChunksFromAnalysis(
    json: Record<string, unknown>,
    chunks: FileAnalysis["recommendedChunks"],
  ): Chunk[] {
    const entries = Object.entries(json);
    return chunks.map((chunk) => {
      const chunkEntries = entries.slice(chunk.start, chunk.end + 1);
      const content = Object.fromEntries(chunkEntries);
      return {
        content,
        path: [],
        tokens: chunk.tokens,
      };
    });
  }

  private constructPrompt(
    content: Record<string, unknown>,
    targetLocale: string,
    styleGuide?: StyleGuide,
  ): string {
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
      if (ctx.targetAudience) {
        prompt += `Target Audience: ${ctx.targetAudience}\n\n`;
      }
    }

    if (styleGuide?.general) {
      prompt += `General style guide:\n${styleGuide.general}\n\n`;
    }

    if (styleGuide?.locales?.[targetLocale]) {
      prompt += `Specific style guide for ${targetLocale}:\n${
        styleGuide.locales[targetLocale]
      }\n\n`;
    }

    prompt += `Content to translate (your response must be valid JSON):\n${
      JSON.stringify(content, null, 2)
    }`;
    return prompt;
  }

  private validateAndRepairJSON(jsonString: string): Record<string, unknown> {
    try {
      // Try parsing as-is first
      return JSON.parse(jsonString);
    } catch (error) {
      // Check for common issues and try to repair
      const repairedJson = jsonString
        .trim()
        // Remove any non-JSON text before {
        .replace(/^[^{]*({.*$)/, "$1")
        // Remove any non-JSON text after }
        .replace(/^(.*})[^}]*$/, "$1");

      try {
        return JSON.parse(repairedJson);
      } catch {
        if (error instanceof Error) {
          console.log(repairedJson);
          throw new Error(`Unable to repair invalid JSON: ${error.message}`);
        } else {
          throw new Error("Unable to repair invalid JSON: Unknown error");
        }
      }
    }
  }

  private async translateChunk(
    chunk: Chunk,
    targetLocale: string,
    styleGuide?: StyleGuide,
  ): Promise<TranslationResult> {
    const prompt = this.constructPrompt(
      chunk.content,
      targetLocale,
      styleGuide,
    );
    const maxRetries = 1;
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < maxRetries) {
      try {
        const completion = await this.openai.chat.completions.create({
          messages: [{ role: "user", content: prompt }],
          model: "gpt-3.5-turbo",
          temperature: 0.1,
        });

        const response = completion.choices[0].message.content || "{}";
        const translatedContent = this.validateAndRepairJSON(response);

        const originalKeys = Object.keys(chunk.content);
        const translatedKeys = Object.keys(translatedContent);

        if (!originalKeys.every((key) => translatedKeys.includes(key))) {
          throw new Error("Translation missing original keys");
        }

        return {
          originalPath: chunk.path,
          translatedContent,
        };
      } catch (error) {
        lastError = error as Error;
        attempts++;
        console.log(
          `Chunk translation attempt ${attempts} failed: ${
            (error as Error).message
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }

    throw new Error(
      `Failed to translate chunk after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  private async translateChunkWithFallback(
    chunk: Chunk,
    targetLocale: string,
    styleGuide?: StyleGuide,
    depth: number = 0,
  ): Promise<TranslationResult[]> {
    try {
      const result = await this.translateChunk(chunk, targetLocale, styleGuide);
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
      const subChunks = this.createChunksFromAnalysis(
        chunk.content,
        subAnalysis.recommendedChunks,
      );

      // Process each sub-chunk
      const results: TranslationResult[] = [];
      for (const subChunk of subChunks) {
        const subResults = await this.translateChunkWithFallback(
          subChunk,
          targetLocale,
          styleGuide,
          depth + 1,
        );
        results.push(...subResults);
      }

      return results;
    }
  }

  private reassembleTranslations(
    results: TranslationResult[],
  ): Record<string, unknown> {
    try {
      const assembled = results.reduce((acc, result) => ({
        ...acc,
        ...result.translatedContent,
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

  async translateJsonFile(
    filePath: string,
    targetLocale: string,
    styleGuidePath?: string,
    targetChunkSize: number = DEFAULT_CHUNK_SIZE,
  ): Promise<void> {
    const content = JSON.parse(await Deno.readTextFile(filePath));
    const outputPath = filePath.replace(/[^\\/]+(?=\.[^\\/]+$)/, targetLocale);

    let existingTranslations: Record<string, unknown> = {};
    try {
      const existingContent = await Deno.readTextFile(outputPath);
      existingTranslations = JSON.parse(existingContent);
    } catch {
      // File doesn't exist or is invalid
    }

    const finalContent = await this.translateJsonString(
      content,
      targetLocale,
      existingTranslations,
      styleGuidePath
        ? JSON.parse(await Deno.readTextFile(styleGuidePath))
        : undefined,
      targetChunkSize,
    );

    await Deno.writeTextFile(outputPath, JSON.stringify(finalContent, null, 2));
    console.log(`Translation updated: ${outputPath}`);
  }

  async translateJsonString(
    content: Record<string, unknown>,
    targetLocale: string,
    existingTranslations: Record<string, unknown> = {},
    styleGuide?: StyleGuide,
    targetChunkSize: number = DEFAULT_CHUNK_SIZE,
  ): Promise<Record<string, unknown>> {
    // Find missing translations
    const missingTranslations = findMissingTranslations(
      content,
      existingTranslations,
    );

    if (Object.keys(missingTranslations).length === 0) {
      console.log("All keys are already translated");
      return existingTranslations;
    }

    // Analyze missing translations
    const analysis = await analyzeContent(missingTranslations, targetChunkSize);

    let translatedContent: Record<string, unknown>;

    if (analysis.exceededLimit) {
      console.log(
        `Processing ${
          Object.keys(missingTranslations).length
        } missing keys in ${analysis.chunkCount} chunks...`,
      );

      const chunks = this.createChunksFromAnalysis(
        missingTranslations,
        analysis.recommendedChunks,
      );
      const results: TranslationResult[] = [];

      for (const [index, chunk] of chunks.entries()) {
        console.log(`Processing chunk ${index + 1}/${chunks.length}...`);
        try {
          const chunkResults = await this.translateChunkWithFallback(
            chunk,
            targetLocale,
            styleGuide,
          );
          results.push(...chunkResults);
        } catch (error) {
          console.error(`Failed to translate chunk after all retries:`, error);
          throw error;
        }
      }

      translatedContent = this.reassembleTranslations(results);
    } else {
      const result = await this.translateChunk(
        {
          content: missingTranslations,
          path: [],
          tokens: analysis.totalTokens,
        },
        targetLocale,
        styleGuide,
      );
      translatedContent = result.translatedContent;
    }

    // Merge with existing translations
    return mergeTranslations(existingTranslations, translatedContent);
  }
}

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
    console.error(
      `Usage: deno run main.ts -f <json-file> -l <target-locale> [-s <style-guide-json>] [-c <chunk-size>]
Options:
  -f, --file        Path to JSON file to translate
  -l, --locale      Target locale (e.g., es, fr)
  -s, --style-guide Path to style guide JSON file
  -c, --chunk-size  Target chunk size in tokens (default: ${DEFAULT_CHUNK_SIZE})`,
    );
    Deno.exit(1);
  }

  const chunkSizeArg = args["chunk-size"];
  const chunkSize = chunkSizeArg
    ? parseInt(chunkSizeArg, 10)
    : DEFAULT_CHUNK_SIZE;

  // Validate chunk size
  if (chunkSize >= MAX_TOKENS - BUFFER_TOKENS) {
    console.error(
      `Chunk size (${chunkSize}) must be less than ${
        MAX_TOKENS - BUFFER_TOKENS
      } tokens`,
    );
    Deno.exit(1);
  }

  const openAiKey = Deno.env.get("OPENAI_API_KEY") ||
    prompt("Enter your OpenAI API key: ");
  if (!openAiKey) {
    console.error(
      "OpenAI API key not found. Please set the OPENAI_API_KEY environment variable",
    );
    Deno.exit(1);
  }

  const translator = new Translatron(openAiKey);
  await translator.translateJsonFile(
    args.file,
    args.locale,
    args["style-guide"],
    chunkSize,
  );
}

export type { StyleGuide };
