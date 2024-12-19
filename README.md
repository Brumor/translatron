# JSON Translator CLI

A command-line tool to translate JSON files using OpenAI.

## Installation

```bash
deno install -A -n translatron https://jsr.io/@yourusername/translatron/main.ts
```

## Usage

```bash
# Set your OpenAI API key
export OPENAI_API_KEY='your-api-key'

# Translate a file
translatron -f input.json -l es -s style-guide.json
```

## API Usage

```ts
import { translateJSON } from "jsr:@yourusername/translatron";

await translateJSON("input.json", "es", "style-guide.json");
```

License
MIT