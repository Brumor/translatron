# JSON Translator CLI

A command-line tool to translate JSON files using OpenAI.

## Installation

```bash
deno install --global -f -A -n translatron jsr:@brumor/translatron/cli
```

## Usage

```bash
# Set your OpenAI API key
export OPENAI_API_KEY='your-api-key'

# Translate a file
translatron -f input.json -l es -s style-guide.json
```

### CLI Arguments

| Argument | Alias | Required | Description | Default |
|----------|--------|----------|-------------|---------|
| --file | -f | Yes | Path to the JSON file to translate | - |
| --locale | -l | Yes | Target locale (e.g., es, fr, de) | - |
| --style-guide | -s | No | Path to style guide JSON file | - |
| --chunk-size | -c | No | Maximum tokens per translation chunk | 2000 |

### Examples

Basic translation:

```bash
translatron -f input.json -l es
```

With style guide:

```bash
translatron -f input.json -l fr -s style.json
```

Custom chunk size:

```bash
translatron -f large.json -l de -c 1000
```

## API Usage

```ts
import { translateJSON } from "jsr:@yourusername/translatron";

await translateJSON("input.json", "es", "style-guide.json", 1000);
```

## Example Files

### Style Guide (style.json)

```JSON
{
  "general": "Use formal tone",
  "locales": {
    "es": "Use 'usted' form",
    "fr": "Use 'vous' form"
  },
  "projectContext": {
    "description": "E-commerce website",
    "domain": "Retail",
    "targetAudience": "General public"
  }
}
```

## Alternative API Usage

```ts
import { Translatron } from "jsr:@brumor/translatron";

const translator = new Translatron("your-api-key");
await translator.translateJsonFile("input.json", "es", "style-guide.json");

// Or use string API
const result = await translator.translateJsonString(
  content,
  "es",
  existingTranslations,
  styleGuide
);
```

License
MIT
