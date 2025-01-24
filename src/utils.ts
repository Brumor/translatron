export function findMissingTranslations(
  original: Record<string, unknown>,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const missing: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(original)) {
    // Skip if key doesn't exist in existing or has empty value
    if (!(key in existing) || !existing[key]) {
      missing[key] = value;
      continue;
    }

    // Recurse for nested objects
    if (typeof value === 'object' && value !== null) {
      const nestedMissing = findMissingTranslations(
        value as Record<string, unknown>,
        existing[key] as Record<string, unknown>
      );
      if (Object.keys(nestedMissing).length > 0) {
        missing[key] = nestedMissing;
      }
    }
  }

  return missing;
}

export function mergeTranslations(
  existing: Record<string, unknown>,
  newTranslations: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(newTranslations)) {
    if (typeof value === 'object' && value !== null) {
      merged[key] = mergeTranslations(
        (existing[key] as Record<string, unknown>) || {},
        value as Record<string, unknown>
      );
    } else {
      merged[key] = value;
    }
  }

  return merged;
}