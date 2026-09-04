# VietQR / Bank-email Transaction Import — Design

Status: draft, awaiting user review
Scope: server-side route + adapter framework + BIDV (expense) adapter

## 1. Context

ActualTap (fork: `tuongbeo/actualtapforbank`) hiện chỉ có route `/transaction`, nhận payload
đã được cấu trúc sẵn từ iOS Shortcuts Tap-to-Pay (`amount`, `payee`, `account`, ...).

Mục tiêu của tính năng này: tự động ghi nhận giao dịch chuyển khoản ngân hàng VN vào Actual
Budget, dựa trên nội dung thô (`rawText`) mà client (iOS Shortcuts) gửi lên — không có cấu
trúc sẵn, không có field `bank`. Server phải tự nhận diện ngân hàng và trích xuất dữ liệu.

Nguồn `rawText` phía client (đã chốt):
- **Chính**: Shortcuts "Email Trigger" (iOS 17+, "Run Immediately") — lấy nội dung email đã
  được Mail app render sẵn thành **plain text** (không còn thẻ HTML/quoted-printable), giữ dấu
  tiếng Việt.
- **Dự phòng**: Back Tap → Screenshot + Live Text OCR → Alert xác nhận → POST.
- **Tương lai**: iOS 27 Notification trigger (không đổi gì phía server).

Route mới độc lập hoàn toàn với `/transaction` hiện có, dùng chung `fastify.actual` connector
và middleware xác thực `x-api-key` toàn cục đã có sẵn.

## 2. Goals / Non-goals

**Goals (phần này):**
- Route `POST /vietqr-transaction` nhận `{ rawText, capturedAt }`.
- Adapter framework: mỗi ngân hàng có `match()` + `parse()` riêng, đăng ký trong 1 registry.
- Adapter đầu tiên: **BIDV, chiều expense** (chuyển tiền đi / interbank transfer) — dựa trên 2
  bản xác nhận khớp nhau tuyệt đối của cùng 1 email thật (paste trực tiếp + export PDF).
- Account resolution qua mapping số tài khoản ngân hàng → Actual account (hỗ trợ nhiều tài
  khoản ngay từ đầu, xem §5).
- Dedup cache in-memory, TTL 10 phút.
- Không tự gán category — để rule engine của Actual xử lý.

**Non-goals (deferred, không chặn merge phần này):**
- BIDV chiều income (nhận tiền vào) — chưa có mẫu email thật. `parse()` sẽ throw lỗi rõ ràng
  thay vì đoán, xem §4.3.
- Các adapter MB, Vietcombank, ACB, Techcombank — theo cùng interface, thêm sau khi có fixture
  thật của từng ngân hàng.
- Back Tap / OCR flow, Shortcut Email Trigger thật trên điện thoại — nằm ngoài phạm vi thay đổi
  server.

## 3. Kiến trúc / luồng xử lý

```
POST /vietqr-transaction { rawText, capturedAt }
  → validate schema (rawText non-empty string, capturedAt optional ISO datetime)
  → adapters.identify(rawText)            // duyệt registry, trả về adapter đầu tiên match()=true
       không có adapter nào match          → 400 "Unrecognized bank format"
  → adapter.parse(rawText)                 // throws nếu thiếu field bắt buộc / format không hỗ trợ
       parse() throw                       → 422 "Failed to parse transaction: <lý do>"
  → resolveAccount(parsed.sourceAccountNumber)
       không khớp entry nào trong ACCOUNT_MAP → 400 "Unknown source account: <number>"
  → dedupCache.checkAndMark(dedupKey)
       đã tồn tại (chưa hết TTL)            → 200 { duplicate: true, ...parsed } (không tạo transaction, không sync)
  → build Actual transaction + addTransactions() + sync()  // tái dùng logic addAndSync hiện có
       sync lỗi                            → 500 (transaction đã lưu local, chưa sync)
  → 200 { ...transaction đã tạo }
```

Route này không thay đổi hành vi của `/transaction`.

## 4. Adapter framework

### 4.1 Interface

```js
// mỗi file trong src/adapters/*.js export:
{
  name: string,               // "bidv"
  match(rawText: string): boolean,
  parse(rawText: string): {
    direction: "expense" | "income",
    amount: number,               // VND, số nguyên dương
    transactionDate: string,      // "YYYY-MM-DD"
    referenceCode: string | null, // dùng cho dedup key nếu có
    sourceAccountNumber: string,  // dùng để resolveAccount
    counterpartyName: string,     // → payee_name
    description: string,          // → notes
  }, // throws Error(message) nếu thiếu field bắt buộc hoặc format chưa hỗ trợ
}
```

`src/adapters/index.js` export `identify(rawText)`: duyệt tuần tự mảng adapter đã đăng ký,
trả về adapter đầu tiên có `match(rawText) === true`, hoặc `null`.

**Chuẩn hóa đầu vào**: trước khi chạy `match()`/`parse()`, route collapse whitespace của
`rawText` (`replace(/\s+/g, " ").trim()`). Điều này làm cho regex không phụ thuộc vào việc
label và value nằm cùng dòng hay khác dòng — cả 2 dạng rawText ta đã thấy (paste email gốc,
text trích từ PDF) đều xử lý được bằng cùng 1 bộ regex.

### 4.2 BIDV adapter — `match()`

Yêu cầu đủ 3 điều kiện (để không nhận nhầm OTP/khuyến mãi của BIDV):
- Chứa "BIDV" (không phân biệt hoa/thường)
- Chứa nhãn "Số tham chiếu"
- Chứa nhãn "Số tiền giao dịch"

### 4.3 BIDV adapter — `parse()`

Trích xuất bằng regex trên chuỗi đã chuẩn hóa whitespace:

| Field | Nguồn | Ví dụ |
|---|---|---|
| `referenceCode` | "Số tham chiếu: X" | `6247BIDVE2NEKZD1` |
| `amount` | "Số tiền giao dịch: X VND" → strip non-digit | `10000` |
| `transactionDate` | "Thời gian giao dịch: dd/mm/yyyy HH:mm:ss" → lấy phần ngày | `2026-09-04` |
| `sourceAccountNumber` | "Tài khoản nguồn: X" | `8820966012` |
| `counterpartyName` | "Tên người thụ hưởng: X" | `PHAM MANH TUONG` |
| `description` | "Nội dung giao dịch: X" (+ nối thêm `Ref: {referenceCode}` để dễ tra soát trong Actual) | `PHAM MANH TUONG Chuyen tien · Ref: 6247BIDVE2NEKZD1` |
| `direction` | có nhãn "Tài khoản nguồn" → `"expense"` | |

Nếu **không** tìm thấy nhãn "Tài khoản nguồn" (tức có thể là email income mà `match()` vẫn
nhận vì đủ 3 điều kiện chung ở §4.2), `parse()` **throw** `"BIDV incoming-transfer format is
not supported yet"` → route trả 422. Đây là hành vi cố ý: thà từ chối rõ ràng còn hơn đoán sai
chiều giao dịch.

## 5. Account resolution

`ACCOUNT_MAP` — ENV var mới, dạng chuỗi JSON, **optional** (default `"{}"`) để không phá vỡ
deployment hiện tại chưa dùng tính năng này:

```
ACCOUNT_MAP={"8820966012":"BIDV Cash"}
```

`resolveAccount(sourceAccountNumber)` tra map → tên account trong Actual → tái dùng
`getAccountId()` đã có trong `transaction.js`. Không khớp entry nào → 400, thông báo rõ số tài
khoản nào không nhận diện được (không lộ toàn bộ map ra response).

Thiết kế này chọn vì khóa định tuyến (số tài khoản ngân hàng) đã nằm sẵn trong dữ liệu giao
dịch — khi có tài khoản ngân hàng thứ 2 gửi email vào cùng hộp thư, chỉ cần thêm 1 dòng vào
`ACCOUNT_MAP`, không cần đổi code.

## 6. Dedup cache

`src/lib/dedupCache.js`: `Map<key, expiresAt>`, TTL 10 phút, dọn lazy khi truy cập (không cần
`setInterval`).

Khóa dedup: `` `${bank}:ref:${referenceCode}` `` nếu adapter trả về `referenceCode`; nếu không
(ngân hàng/adapter không có mã tham chiếu, ví dụ ảnh OCR từ Back Tap), fallback
`` `${bank}:hash:${sha256(normalizedRawText)}` ``.

Trùng khóa trong TTL → response `200 { duplicate: true, ...parsed }`, không gọi
`addTransactions`/`sync`.

## 7. Error handling

| Tình huống | HTTP | Body |
|---|---|---|
| `rawText` rỗng/thiếu | 400 | lỗi schema (Fastify tự xử lý) |
| Không adapter nào match | 400 | `{ error: "Unrecognized bank format", message }` |
| `parse()` throw | 422 | `{ error: "Failed to parse transaction", message }` |
| `sourceAccountNumber` không có trong `ACCOUNT_MAP` | 400 | `{ error: "Unknown source account", message }` |
| Dedup hit | 200 | `{ duplicate: true, ...parsed }` |
| `sync()` lỗi | 500 | giống route `/transaction` hiện tại |

## 8. File structure

```
src/adapters/index.js            // identify()
src/adapters/bidv.js
src/lib/accountResolver.js       // resolveAccount()
src/lib/dedupCache.js
src/routes/vietqrTransaction.js
src/plugins/env.js               // + ACCOUNT_MAP (optional)
src/server.js                    // đăng ký route mới

test/adapters/bidv.test.js       // pure unit test, không cần ACTUAL_URL/Actual server thật
test/fixtures/bidv-expense.txt   // plain text, dựng từ email thật đã xác nhận (2 nguồn khớp nhau)
test/vietqr-transaction.test.js  // integration test theo pattern buildServer() có sẵn
```

## 9. Testing plan

- **Unit test adapter** (`bidv.test.js`, không cần kết nối Actual thật):
  - `match()` trả `true` với fixture hợp lệ.
  - `match()` trả `false` với text không liên quan (email khác, chuỗi rỗng, OTP).
  - `parse()` trả đúng toàn bộ field từ fixture (so khớp với bảng ở §4.3).
  - `parse()` throw khi thiếu "Tài khoản nguồn" (giả lập trường hợp income).
  - Test cả 2 dạng khoảng trắng (label/value cùng dòng và khác dòng) để xác nhận bước
    normalize hoạt động đúng.
- **Integration test route** (`vietqr-transaction.test.js`, theo pattern `buildServer()` có
  sẵn — chạy chống lại Actual server thật):
  - Gửi fixture hợp lệ → 200, transaction xuất hiện đúng account (theo `ACCOUNT_MAP` test), amount âm (expense), payee đúng.
  - Gửi lại cùng fixture lần 2 trong TTL → 200 `duplicate: true`, không tạo transaction thứ 2.
  - Gửi text không match adapter nào → 400.
  - Gửi text thiếu "Tài khoản nguồn" (mô phỏng income) → 422.
  - `sourceAccountNumber` không có trong `ACCOUNT_MAP` test → 400.

**Giới hạn đã biết**: fixture được dựng từ nội dung email thật do người dùng cung cấp (paste +
export PDF, khớp nhau tuyệt đối), nhưng **chưa được xác nhận bằng rawText thực tế lấy trực
tiếp từ Shortcuts trên điện thoại**. Cần verify lại khi Shortcut Email Trigger được build thật
(nằm ngoài phạm vi phần server này).

## 10. Follow-ups (ngoài phạm vi spec này)

- BIDV adapter chiều income — cần mẫu email thật ("Tài khoản nhận"/"Tài khoản đích" thay vì
  "Tài khoản nguồn").
- Adapter cho MB, Vietcombank, ACB, Techcombank.
- Build Shortcut Email Trigger thật trên iOS, test end-to-end.
- Nâng cấp lên iOS 27 Notification trigger khi GA (~14/9/2026).
