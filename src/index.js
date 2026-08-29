export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Безпека: Перевірка Telegram Webhook Secret Token
    const telegramSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token",
    );
    if (telegramSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("Unauthorized: Invalid Telegram Secret Token");
      return new Response("Unauthorized", { status: 401 });
    }

    // Змінна для chatId, щоб мати доступ до неї у блоці catch
    let currentChatId = null;

    try {
      const payload = await request.json();
      if (!payload.message || !payload.message.text) return new Response("OK");

      // Отримуємо chatId та текст
      currentChatId =
        payload.message?.chat?.id || payload.callback_query?.message?.chat?.id;
      const text = payload.message?.text;

      // 2. Безпека: Whitelist за Chat ID
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

      // Ігнорування службових команд Telegram
      if (text.startsWith("/")) {
        await sendTelegramMessage(
          currentChatId,
          "👋 Надішліть текст замовлення з VIN-кодом або артикулами запчастин.",
          env.TELEGRAM_SECRET_TOKEN,
        );
        return new Response("OK");
      }

      // UX: Миттєвий фідбек
      await sendTelegramMessage(
        currentChatId,
        "⏳ ШІ аналізує текст та розшифровує дані...",
        env.TELEGRAM_SECRET_TOKEN,
      );

      // Крок 1: Парсинг через Groq API
      const parsedData = await parseTextWithLLM(text, env.OPENAI_API_KEY);

      if (!parsedData || !parsedData.parts || parsedData.parts.length === 0) {
        await sendTelegramMessage(
          currentChatId,
          "❌ Не знайдено кодів запчастин або артикулів у тексті.",
          env.TELEGRAM_SECRET_TOKEN,
        );
        return new Response("OK");
      }

      // Крок 2: Збагачення автомобіля через NHTSA API (якщо є VIN)
      if (parsedData.vin && parsedData.vin.length >= 10) {
        const exactCar = await decodeVinViaNhtsa(parsedData.vin);
        if (exactCar) {
          parsedData.car = exactCar; // Замінюємо гіпотезу ШІ на паспортні дані
        }
      }

      // Крок 3: Запис у Google Sheets
      const orderId = `ORD-${Date.now().toString().slice(-6)}`;
      await appendToGoogleSheets(parsedData, orderId, env);

      // Крок 4: Формування та відправка звіту користувачу
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

async function parseTextWithLLM(text, apiKey) {
  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
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
              content: `You are a strict auto parts order parser specialized in Hyundai, Kia, and Mobis catalogs.
Extract the VIN and all OEM part numbers from the provided user text.

Respond ONLY with a valid JSON object matching this schema:
{
  "vin": "17-character VIN code in UPPERCASE, or null if missing",
  "car": "Vehicle make/model/year if mentioned, or null if missing",
  "parts": [
    {
      "number": "OEM part number stripped of spaces/dashes in UPPERCASE, or null if invalid",
      "name": "Part description ONLY if explicitly mentioned in user text, otherwise null",
      "predicted_name": "Short English description derived from your knowledge of the OEM part number (e.g. 'Front Brake Pads', 'Intercooler', 'Oil Filter'), or null if unknown",
      "quantity": 1
    }
  ]
}

Rules:
- Strip all hyphens, dashes, and spaces from OEM part numbers (e.g., '58101-D3A00' -> '58101D3A00').
- Set "name" ONLY if the input text explicitly contains a part name next to the number.
- Always provide "predicted_name" in concise English for known Hyundai/Kia/Mobis OEM numbers.
- Default "quantity" is 1 unless explicitly specified near the part number (e.g., 'x2', '2 pcs', '2 шт').`,
            },
            { role: "user", content: text },
          ],
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq API Error:", errorText);
      return null;
    }

    const resData = await response.json();
    return JSON.parse(resData.choices[0].message.content);
  } catch (e) {
    console.error("parseTextWithLLM Error:", e);
    return null;
  }
}

async function decodeVinViaNhtsa(vin) {
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`,
      { method: "GET" },
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

    // Беремо явну назву, або предиктивну англійською, або залишаємо порожньою:
    const finalPartName = part.name || part.predicted_name || "";

    return [
      orderId, // Column A: Order ID
      dateStr, // Column B: Date/Time
      "🆕 Нове", // Column C: Status
      data.car || "", // Column D: Car Model
      data.vin ? data.vin.toUpperCase() : "", // Column E: VIN
      cleanNumber, // Column F: OEM Part Number
      "", // Column G: Cross-number
      finalPartName, // Column H: Part Name (English from AI)
      part.quantity || 1, // Column I: Quantity
    ];
  });

  const range = "Замовлення!A:I";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: "POST",
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

  const base64UrlEncode = (obj) => {
    const str = typeof obj === "string" ? obj : JSON.stringify(obj);
    const raw = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...raw))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
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
  const jwtSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

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
