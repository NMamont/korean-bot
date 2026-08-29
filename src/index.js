export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 1. Безпека: Перевірка Telegram Webhook Secret Token
    const telegramSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (telegramSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
      console.error('Unauthorized: Invalid Telegram Secret Token');
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const payload = await request.json();
      if (!payload.message || !payload.message.text) return new Response('OK');

      const chatId = payload.message.chat.id;
      const text = payload.message.text;

      // 2. Безпека: Whitelist за Chat ID
      const allowedIds = JSON.parse(env.ALLOWED_CHAT_IDS || "[]");
      if (!allowedIds.includes(chatId)) {
        console.warn(`Access denied for Chat ID: ${chatId}`);
        await sendTelegramMessage(chatId, "🚫 Доступ заборонено.", env.TELEGRAM_TOKEN);
        return new Response('OK');
      }

      // Ігнорування службових команд Telegram
      if (text.startsWith('/')) {
        await sendTelegramMessage(chatId, "👋 Надішліть текст замовлення з VIN-кодом або артикулами запчастин.", env.TELEGRAM_TOKEN);
        return new Response('OK');
      }

      // UX: Миттєвий фідбек
      await sendTelegramMessage(chatId, "⏳ ШІ аналізує текст та розшифровує дані...", env.TELEGRAM_TOKEN);

      // Крок 1: Парсинг через OpenAI
      const parsedData = await parseTextWithLLM(text, env.OPENAI_API_KEY);

      if (!parsedData || !parsedData.parts || parsedData.parts.length === 0) {
        await sendTelegramMessage(chatId, "❌ Не знайдено кодів запчастин або артикулів у тексті.", env.TELEGRAM_TOKEN);
        return new Response('OK');
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
      const partsListStr = parsedData.parts.map(p => `• <code>${p.number}</code> — ${p.name} (${p.quantity || 1} шт)`).join('\n');
      const reply = `✅ <b>Замовлення успішно додано!</b>\n🆔 <b>ID:</b> <code>${orderId}</code>\n🚗 <b>Авто:</b> ${parsedData.car || 'Не визначено'}\n🔍 <b>VIN:</b> <code>${parsedData.vin || 'Не вказано'}</code>\n\n📦 <b>Деталі (${parsedData.parts.length}):</b>\n${partsListStr}`;
      
      await sendTelegramMessage(chatId, reply, env.TELEGRAM_TOKEN, 'HTML');

    } catch (err) {
      console.error('Global Worker Error:', err);
    }

    return new Response('OK');
  }
};

async function parseTextWithLLM(text, apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: 'system',
            content: `Ти парсер замовлень автозапчастин (спеціалізація Hyundai/Kia, Mobis).
Витягни з тексту: "vin" (17 знаків, верхній регістр), "car" (марка, модель, рік) та масив "parts".
Кожен об'єкт у масиві "parts" повинен мати:
- "number" (чистий артикул/OEM без пробілів та дефісів у верхньому регістрі)
- "name" (назва запчастини українською)
- "quantity" (число, кількість, за замовчуванням 1)

Формат відповіді СУВОРO JSON:
{
  "vin": "KMHD...",
  "car": "Hyundai Tucson 2019",
  "parts": [
    {"number": "58101D3A00", "name": "Колодки передні", "quantity": 1}
  ]
}`
          },
          { role: 'user', content: text }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API Error:', errorText);
      return null;
    }

    const resData = await response.json();
    return JSON.parse(resData.choices[0].message.content);
  } catch (e) {
    console.error('parseTextWithLLM Error:', e);
    return null;
  }
}

async function decodeVinViaNhtsa(vin) {
  try {
    const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`, { method: 'GET' });
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.Results?.[0];
    if (info && info.Make) {
      const make = info.Make;
      const model = info.Model || '';
      const year = info.ModelYear || '';
      const fullCar = `${make} ${model} ${year}`.replace(/\s+/g, ' ').trim();
      return fullCar.length > 0 ? fullCar : null;
    }
  } catch (e) {
    console.error('NHTSA API Error:', e);
  }
  return null;
}

async function appendToGoogleSheets(data, orderId, env) {
  const accessToken = await getGoogleAccessToken(env.GOOGLE_CLIENT_EMAIL, env.GOOGLE_PRIVATE_KEY);
  
  const now = new Date();
  const dateStr = now.toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  const rows = data.parts.map(part => {
    // Очищення артикулу від пробілів і дефісів (наприклад: 58101-D3A00 -> 58101D3A00)
    const cleanNumber = part.number ? part.number.replace(/[^A-Z0-9]/gi, '').toUpperCase() : 'НЕВІДОМО';
    
    return [
      orderId,                  // A: ID
      dateStr,                  // B: Дата/Час
      '🆕 Нове',               // C: Статус
      data.car || 'Не вказано', // D: Авто
      data.vin ? data.vin.toUpperCase() : 'Не вказано', // E: VIN
      cleanNumber,              // F: Артикул (OEM США / Запитуваний)
      "",                       // G: Крос-номер (Mobis KDM) -> ПОРОЖНЄ (Вписує постачальник!)
      part.name || 'Запчастина',// H: Назва
      part.quantity || 1        // I: Кількість
    ];
  });

  const range = 'Замовлення!A:I';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: rows })
  });

  if (!response.ok) {
    const errRes = await response.text();
    throw new Error(`Google Sheets Append Error: ${errRes}`);
  }
}

async function getGoogleAccessToken(clientEmail, privateKeyJson) {
  const pk = privateKeyJson.replace(/\\n/g, '\n');
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const base64UrlEncode = (obj) => {
    const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const raw = new TextEncoder().encode(str);
    return btoa(String.fromCharCode(...raw)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };

  const jwtHeader = base64UrlEncode(header);
  const jwtClaim = base64UrlEncode(claim);
  const signatureInput = `${jwtHeader}.${jwtClaim}`;

  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pk.substring(pk.indexOf(pemHeader) + pemHeader.length, pk.indexOf(pemFooter)).replace(/\s/g, '');
  const binaryDer = new Uint8Array(atob(pemContents).split("").map(c => c.charCodeAt(0)));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", binaryDer.buffer, { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } }, false, ["sign"]
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signatureInput));
  const jwtSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signatureInput}.${jwtSignature}`
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

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}