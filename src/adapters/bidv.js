const REQUIRED_MARKERS = [/bidv/i, /Số tham chiếu/, /Số tiền giao dịch/];

const match = (normalizedText) => REQUIRED_MARKERS.every((pattern) => pattern.test(normalizedText));

const extract = (normalizedText, pattern, fieldName) => {
  const found = normalizedText.match(pattern);
  if (!found) {
    throw new Error(`BIDV adapter: could not find "${fieldName}" in rawText`);
  }
  return found;
};

const parse = (normalizedText) => {
  if (!/Tài khoản nguồn/.test(normalizedText)) {
    throw new Error("BIDV incoming-transfer format is not supported yet");
  }

  const referenceCode = extract(
    normalizedText,
    /Số tham chiếu:\s*(?:Reference number:\s*)?([A-Za-z0-9]+)/i,
    "referenceCode"
  )[1];

  const amountMatch = extract(
    normalizedText,
    /Số tiền giao dịch:\s*(?:Transaction amount:\s*)?([\d,.]+)\s*VND/i,
    "amount"
  );
  const amount = parseInt(amountMatch[1].replace(/[.,]/g, ""), 10);

  const [, day, month, year] = extract(
    normalizedText,
    /Thời gian giao dịch:\s*(?:Transaction time:\s*)?(\d{2})\/(\d{2})\/(\d{4})/i,
    "transactionDate"
  );
  const transactionDate = `${year}-${month}-${day}`;

  const sourceAccountNumber = extract(
    normalizedText,
    /Tài khoản nguồn:\s*(?:Debit account:\s*)?(\d+)/i,
    "sourceAccountNumber"
  )[1];

  const counterpartyName = extract(
    normalizedText,
    /Tên người thụ hưởng:\s*(?:Beneficiary name:\s*)?([A-Z][A-Z\s]*?)\s*(?=Số tài khoản)/,
    "counterpartyName"
  )[1].trim();

  const remark = extract(
    normalizedText,
    /Nội dung giao dịch:\s*(?:Transaction remark:\s*)?(.+?)\s*(?=Kênh thực hiện giao dịch)/i,
    "description"
  )[1].trim();

  return {
    direction: "expense",
    amount,
    transactionDate,
    referenceCode,
    sourceAccountNumber,
    counterpartyName,
    description: `${remark} · Ref: ${referenceCode}`,
  };
};

module.exports = { name: "bidv", match, parse };
