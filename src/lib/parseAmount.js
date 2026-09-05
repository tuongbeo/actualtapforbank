// iOS Shortcuts passes the Tap-to-Pay amount as locale-formatted text, so the
// string may carry a currency symbol and use either "," or "." as the decimal
// separator (e.g. "£12.34", "12,34", "1.234,56 €")
const parseAmount = (raw) => {
  let value = raw.replace(/[^\d.,-]/g, "");
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the later one is the decimal separator, the other is a thousands separator
    value =
      lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma > -1) {
    const isDecimalComma = value.indexOf(",") === lastComma && value.length - lastComma - 1 !== 3;
    value = isDecimalComma ? value.replace(",", ".") : value.replace(/,/g, "");
  }

  return parseFloat(value);
};

module.exports = { parseAmount };
