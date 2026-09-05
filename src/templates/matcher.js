class AmbiguousMatchError extends Error {
  constructor(templateNames) {
    super(`Multiple templates matched: ${templateNames.join(", ")}`);
    this.name = "AmbiguousMatchError";
  }
}

const identify = (normalizedText, templates) => {
  const lowerText = normalizedText.toLowerCase();
  const matches = templates.filter((template) =>
    template.match.contains.every((needle) => lowerText.includes(needle.toLowerCase()))
  );

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new AmbiguousMatchError(matches.map((t) => t.name));
  }
  return matches[0];
};

module.exports = { identify, AmbiguousMatchError };
