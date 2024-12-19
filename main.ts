import { parseArgs } from "jsr:@std/cli/parse-args";
import { OpenAI } from "https://deno.land/x/openai@v4.24.0/mod.ts";

// Parse command line arguments
const args = parseArgs(Deno.args, {
  string: ["file", "locale"],
  alias: {
    f: "file",
    l: "locale",
  },
});

// Validate arguments
if (!args.file || !args.locale) {
  console.error("Usage: deno run main.ts -f <json-file> -l <target-locale>");
  Deno.exit(1);
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

    // Create prompt for OpenAI
    const prompt = `Translate the following JSON content to ${targetLocale}. 
    Maintain the JSON structure and keys, only translate the values: 
    ${JSON.stringify(jsonData, null, 2)}`;

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