// Server-only helper for sending emails from the connected Gmail account
// (sdhrotacoordinator@gmail.com) via the Lovable connector gateway.

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";

function base64Url(input: string) {
  // btoa is available in the Workers runtime
  return btoa(unescape(encodeURIComponent(input)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sanitiseHeader(value: string) {
  // Strip CR/LF/NUL to prevent header injection (RFC 2822 header smuggling).
  return value.replace(/[\r\n\0]/g, " ").trim();
}

function buildRawEmail(params: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}) {
  const headers = [
    `To: ${sanitiseHeader(params.to)}`,
    `Subject: ${sanitiseHeader(params.subject)}`,
    "MIME-Version: 1.0",
  ];

  let body = "";
  if (params.html) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    body = params.html;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    body = params.text ?? "";
  }
  return base64Url(headers.join("\r\n") + "\r\n\r\n" + body);
}

export async function sendGmail(params: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}) {
  const lovableKey = process.env.LOVABLE_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  const connKey = process.env.GOOGLE_MAIL_API_KEY;
  if (!connKey) throw new Error("GOOGLE_MAIL_API_KEY is not configured");

  const raw = buildRawEmail(params);
  const res = await fetch(`${GATEWAY_URL}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": connKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gmail send failed [${res.status}]: ${errBody}`);
  }
  return res.json();
}
