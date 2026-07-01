export function validateRequired(value: string, label: string): string | null {
  return value.trim() ? null : `${label} ist erforderlich.`;
}

export function validateHttpUrl(value: string, label: string): string | null {
  const required = validateRequired(value, label);
  if (required) return required;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "http:" || url.protocol === "https:") return null;
  } catch {
    /* handled below */
  }
  return `${label} muss mit http:// oder https:// beginnen.`;
}

export function validateHfToken(value: string): string | null {
  const required = validateRequired(value, "Hugging Face Token");
  if (required) return required;
  return value.trim().startsWith("hf_") ? null : "Hugging Face Tokens beginnen mit hf_.";
}
