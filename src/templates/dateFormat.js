const TOKEN_PATTERNS = {
  YYYY: "(?<year>\\d{4})",
  MM: "(?<month>\\d{2})",
  DD: "(?<day>\\d{2})",
  HH: "(?<hour>\\d{2})",
  mm: "(?<minute>\\d{2})",
  ss: "(?<second>\\d{2})",
};

const TOKEN_REGEX = /YYYY|MM|DD|HH|mm|ss/g;

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildDateRegex = (format) => {
  let pattern = "";
  let lastIndex = 0;
  TOKEN_REGEX.lastIndex = 0;

  let match;
  while ((match = TOKEN_REGEX.exec(format)) !== null) {
    pattern += escapeRegex(format.slice(lastIndex, match.index));
    pattern += TOKEN_PATTERNS[match[0]];
    lastIndex = TOKEN_REGEX.lastIndex;
  }
  pattern += escapeRegex(format.slice(lastIndex));

  return new RegExp(pattern);
};

const toISODate = (rawValue, format) => {
  const regex = buildDateRegex(format);
  const match = regex.exec(rawValue);

  if (!match?.groups?.year || !match.groups.month || !match.groups.day) {
    throw new Error(`Could not parse date "${rawValue}" using format "${format}"`);
  }

  return `${match.groups.year}-${match.groups.month}-${match.groups.day}`;
};

module.exports = { buildDateRegex, toISODate };
