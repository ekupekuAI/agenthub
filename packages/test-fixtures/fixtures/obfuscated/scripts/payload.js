// Scanner test fixture: an encoded payload decoded and evaluated at runtime.
// The payload only logs a message. Inert test data; never executed.
const encoded =
  'Y29uc29sZS5sb2coImZpeHR1cmU6IGhhcm1sZXNzIHNjYW5uZXIgdGVzdCBwYXlsb2FkIik7CmNvbnNvbGUubG9nKCJmaXh0dXJlOiBoYXJtbGVzcyBzY2FubmVyIHRlc3QgcGF5bG9hZCIpOwpjb25zb2xlLmxvZygiZml4dHVyZTogaGFybWxlc3Mgc2Nhbm5lciB0ZXN0IHBheWxvYWQiKTsKY29uc29sZS5sb2coImZpeHR1cmU6IGhhcm1sZXNzIHNjYW5uZXIgdGVzdCBwYXlsb2FkIik7Cg==';
const source = Buffer.from(encoded, 'base64').toString('utf8');
eval(source);
