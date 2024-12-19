import { parseArgs } from "jsr:@std/cli/parse-args";
import { OpenAI } from "https://deno.land/x/openai@v4.24.0/mod.ts";

interface StyleGuide {
  general?: string;
  locales?: Record<string, string>;
  projectContext?: {
    description?: string;
    domain?: string;
    targetAudience?: string;
  };
}

// Parse command line arguments
const args = parseArgs(Deno.args, {
  string: ["file", "locale", "style-guide"],
  alias: {
    f: "file",
    l: "locale",
    s: "style-guide",
  },
});

// Validate arguments
if (!args.file || !args.locale) {
  console.error("Usage: deno run main.ts -f <json-file> -l <target-locale> [-s <style-guide-json>]");
  Deno.exit(1);
}

let styleGuide: StyleGuide = {};
if (args["style-guide"]) {
  try {
    const styleGuideContent = await Deno.readTextFile(args["style-guide"]);
    styleGuide = JSON.parse(styleGuideContent);
  } catch (error) {
    console.error("Error reading style guide:", error);
    Deno.exit(1);
  }
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: Deno.env.get("OPENAI_API_KEY") || "",
});

async function translateJSON(filePath: string, targetLocale: string) {
  try {
    // Read and parse JSON file
    const jsonContent = await Deno.readTextFile(filePath);
    const jsonData = JSON.parse(jsonContent);

    // Create prompt with style guides
    let prompt = `Translate the following JSON content to ${targetLocale}.\n`;
    prompt += `Maintain the JSON structure and keys, only translate the values.\n\n`;
    
    if (styleGuide.projectContext) {
      const ctx = styleGuide.projectContext;
      prompt += "Project Context:\n";
      if (ctx.description) prompt += `Description: ${ctx.description}\n`;
      if (ctx.domain) prompt += `Domain: ${ctx.domain}\n`;
      if (ctx.targetAudience) prompt += `Target Audience: ${ctx.targetAudience}\n\n`;
    }
    
    if (styleGuide.general) {
      prompt += `General style guide:\n${styleGuide.general}\n\n`;
    }
    
    if (styleGuide.locales?.[targetLocale]) {
      prompt += `Specific style guide for ${targetLocale}:\n${styleGuide.locales[targetLocale]}\n\n`;
    }
    
    prompt += `Content to translate:\n${JSON.stringify(jsonData, null, 2)}`;

    console.log(prompt)

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

// Execute translation
await translateJSON(args.file, args.locale);