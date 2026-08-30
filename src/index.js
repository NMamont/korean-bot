export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Security: Limit payload size to prevent DoS
    const contentLength = parseInt(
      request.headers.get("content-length") || "0",
      10,
    );
    if (contentLength > 10000) {
      return new Response("Payload too large", { status: 413 });
    }

    // Security: Verify Telegram Webhook Secret Token
    const telegramSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token",
    );
    if (telegramSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("Unauthorized: Invalid Telegram Secret Token");
      return new Response("Unauthorized", { status: 401 });
    }

    let currentChatId = null;

    try {
      const payload = await request.json();
      if (!payload.message || !payload.message.text) return new Response("OK");

      currentChatId =
        payload.message?.chat?.id || payload.callback_query?.message?.chat?.id;
      const text = payload.message?.text;

      // Security: Whitelist by Chat ID
      if (currentChatId) {
        const rawAllowed = String(env.ALLOWED_CHAT_IDS || "");
        const allowedIds = rawAllowed
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);

        if (!allowedIds.includes(String(currentChatId))) {
          console.warn(`Access denied for Chat ID: ${currentChatId}`);
          await sendTelegramMessage(
            currentChatId,
            "🚫 Доступ заборонено.",
            env.TELEGRAM_SECRET_TOKEN,
          );
          return new Response("OK", { status: 200 });
        }
      }

      // Ignore service commands
      if (text.startsWith("/")) {
        await sendTelegramMessage(
          currentChatId,
          "👋 Надішліть текст замовлення з VIN-кодом або артикулами запчастин.",
          env.TELEGRAM_SECRET_TOKEN,
        );
        return new Response("OK");
      }

      // UX: Instant feedback
      await sendTelegramMessage(
        currentChatId,
        "⏳ ШІ аналізує текст та розшифровує дані...",
        env.TELEGRAM_SECRET_TOKEN,
      );

      // Step 1: Parse with Groq API
      const parsedData = await parseTextWithLLM(text, env.OPENAI_API_KEY);

      if (!parsedData || !parsedData.parts || parsedData.parts.length === 0) {
        await sendTelegramMessage(
          currentChatId,
          "❌ Не знайдено кодів запчастин або артикулів у тексті.",
          env.TELEGRAM_SECRET_TOKEN,
        );
        return new Response("OK");
      }

      // Step 2: Enrich car data via NHTSA API (if VIN present)
      if (parsedData.vin && parsedData.vin.length >= 10) {
        const exactCar = await decodeVinViaNhtsa(parsedData.vin);
        if (exactCar) {
          parsedData.car = exactCar;
        }
      }

      // Step 3: Append to Google Sheets
      const orderId = `ORD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      await appendToGoogleSheets(parsedData, orderId, env);

      // Step 4: Send report to user
      const partsListStr = parsedData.parts
        .map((p) => {
          const nameToDisplay = p.name || p.predicted_name || "";
          const nameStr = nameToDisplay ? ` — <i>${nameToDisplay}</i>` : "";
          return `• <code>${p.number || "Без OEM"}</code>${nameStr} (${p.quantity || 1} шт)`;
        })
        .join("\n");
      const reply = `✅ <b>Замовлення успішно додано!</b>\n🆔 <b>ID:</b> <code>${orderId}</code>\n🚗 <b>Авто:</b> ${parsedData.car || "Не визначено"}\n🔍 <b>VIN:</b> <code>${parsedData.vin || "Не вказано"}</code>\n\n📦 <b>Деталі (${parsedData.parts.length}):</b>\n${partsListStr}`;

      await sendTelegramMessage(
        currentChatId,
        reply,
        env.TELEGRAM_SECRET_TOKEN,
        "HTML",
      );
    } catch (err) {
      console.error("Global Worker Error:", err);
      if (currentChatId) {
        await sendTelegramMessage(
          currentChatId,
          `⚠️ <b>Помилка обробки замовлення:</b>\n<code>${err.message}</code>`,
          env.TELEGRAM_SECRET_TOKEN,
          "HTML",
        );
      }
    }

    return new Response("OK");
  },
};

// Safer base64 URL encode that works with large strings
function base64UrlEncode(input) {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function parseTextWithLLM(text, apiKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          temperature: 0.0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `You are a strict text parser for Hyundai/Kia auto parts orders.
Extract the VIN code, vehicle information (if present), and all OEM part numbers.

Respond ONLY with this JSON schema:
{
  "vin": "17-character VIN code in UPPERCASE, or null",
  "car": "Vehicle model/year if mentioned, or null",
  "parts": [
    {
      "number": "OEM part number stripped of space/dashes in UPPERCASE",
      "name": "Part description ONLY if explicitly typed in the user input text, otherwise null",
      "quantity": 1
    }
  ]
}

Rules:
- DO NOT invent, guess, or predict part names. If the input is just part numbers without text descriptions, set "name": null.
- Strip dashes and spaces from part numbers (e.g., '25310-P0000' -> '25310P0000').
- Default quantity is 1.`,
            },
            { role: "user", content: text },
          ],
        }),
      },
    );

    if (!response.ok) return null;
    const resData = await response.json();
    return JSON.parse(resData.choices[0].message.content);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function decodeVinViaNhtsa(vin) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`,
      { method: "GET", signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.Results?.[0];
    if (info && info.Make) {
      const make = info.Make;
      const model = info.Model || "";
      const year = info.ModelYear || "";
      const fullCar = `${make} ${model} ${year}`.replace(/\s+/g, " ").trim();
      return fullCar.length > 0 ? fullCar : null;
    }
  } catch (e) {
    console.error("NHTSA API Error:", e);
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}

async function appendToGoogleSheets(data, orderId, env) {
  const accessToken = await getGoogleAccessToken(
    env.GOOGLE_CLIENT_EMAIL,
    env.GOOGLE_PRIVATE_KEY,
  );

  const now = new Date();
  const dateStr = now.toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });

  const rows = data.parts.map((part) => {
    const cleanNumber = part.number
      ? part.number.replace(/[^A-Z0-9]/gi, "").toUpperCase()
      : "";

    const finalPartName = part.name || part.predicted_name || "";

    return [
      orderId,
      dateStr,
      "🆕 Нове",
      data.car || "",
      data.vin ? data.vin.toUpperCase() : "",
      cleanNumber,
      "",
      finalPartName,
      part.quantity || 1,
    ];
  });

  const range = "Замовлення!A:I";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    });

    if (!response.ok) {
      const errRes = await response.text();
      throw new Error(`Google Sheets Append Error: ${errRes}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getGoogleAccessToken(clientEmail, privateKeyJson) {
  const pk = privateKeyJson.replace(/\\n/g, "\n");
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);

  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const jwtHeader = base64UrlEncode(header);
  const jwtClaim = base64UrlEncode(claim);
  const signatureInput = `${jwtHeader}.${jwtClaim}`;

  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pk
    .substring(pk.indexOf(pemHeader) + pemHeader.length, pk.indexOf(pemFooter))
    .replace(/\s/g, "");
  const binaryDer = new Uint8Array(
    atob(pemContents)
      .split("")
      .map((c) => c.charCodeAt(0)),
  );

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signatureInput),
  );
  const jwtSignature = base64UrlEncode(new Uint8Array(signature));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signatureInput}.${jwtSignature}`,
  });

  const resData = await response.json();
  if (!resData.access_token) {
    throw new Error(`Google OAuth Failed: ${JSON.stringify(resData)}`);
  }
  return resData.access_token;
}

async function sendTelegramMessage(chatId, text, token, parseMode = null) {
  const body = { chat_id: chatId, text: text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Telegram SendMessage Error:", errText);
  }
}
