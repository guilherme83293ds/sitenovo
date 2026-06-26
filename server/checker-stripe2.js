function getStr(string, start, end) {
  const str = string.split(start);
  if (str.length < 2) return '';
  return str[1].split(end)[0];
}

function multiexplode(delimiters, string) {
  const one = string.replace(new RegExp('[' + delimiters.join('') + ']', 'g'), delimiters[0]);
  return one.split(delimiters[0]);
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.77 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export async function checkCardStripe2(card, month, year, cvv, sec) {
  const sk = sec || process.env.STRIPE_SEC_KEY || '';
  if (!sk) {
    return { status: 'REPROVADA', detalhes: 'Stripe SK key not configured' };
  }

  const ua = randomUA();
  const cc = card;
  const mes = month;
  let ano = year.length === 2 ? '20' + year : year;
  const cvc = cvv;

  // Get random user
  let userName = 'User';
  let userLast = 'Name';
  try {
    const ruRes = await fetch('https://randomuser.me/api/1.2/?nat=us', { signal: AbortSignal.timeout(10000) });
    const ruData = await ruRes.json();
    if (ruData.results && ruData.results[0]) {
      userName = ruData.results[0].name.first;
      userLast = ruData.results[0].name.last;
    }
  } catch {}

  // Step 1: Create Stripe source
  const sourceBody = new URLSearchParams({
    'type': 'card',
    'owner[name]': userName + ' ' + userLast,
    'card[number]': cc,
    'card[cvc]': cvc,
    'card[exp_month]': mes,
    'card[exp_year]': ano,
  });

  let result1, result2, result3, result4;
  let token, token3, chtoken;

  try {
    const srcRes = await fetch('https://api.stripe.com/v1/sources', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sk + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ua,
      },
      body: sourceBody,
      signal: AbortSignal.timeout(20000),
    });
    result1 = await srcRes.text();
    const srcJson = JSON.parse(result1);
    token = srcJson.id || '';
  } catch (e) {
    return { status: 'REPROVADA', detalhes: 'Stripe source error: ' + e.message };
  }

  if (!token) {
    try {
      const j = JSON.parse(result1);
      return { status: 'REPROVADA', detalhes: j.error?.message || j.error?.code || 'Stripe source failed' };
    } catch {
      return { status: 'REPROVADA', detalhes: 'Stripe source failed' };
    }
  }

  // Step 2: Create customer
  try {
    const custRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sk + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ua,
      },
      body: new URLSearchParams({
        'description': userName + ' ' + userLast,
        'source': token,
      }),
      signal: AbortSignal.timeout(20000),
    });
    result2 = await custRes.text();
    const custJson = JSON.parse(result2);
    token3 = custJson.id || '';
  } catch (e) {
    return { status: 'REPROVADA', detalhes: 'Stripe customer error: ' + e.message };
  }

  if (!token3) {
    try {
      const j = JSON.parse(result2);
      const msg = j.error?.message || j.error?.code || 'Stripe customer failed';
      // Check for specific errors
      if (result2.includes('"cvc_check": "pass"')) {
        return { status: 'LIVE', detalhes: 'Approved (CVV) AUTH ONLY' };
      }
      if (result2.includes('incorrect_cvc') || result2.includes('invalid_cvc')) {
        return { status: 'LIVE', detalhes: 'CCN LIVE' };
      }
      if (result2.includes('do_not_honor')) {
        return { status: 'REPROVADA', detalhes: 'DO_NOT_HONOR' };
      }
      if (result2.includes('generic_decline')) {
        return { status: 'REPROVADA', detalhes: 'GENERIC_DECLINE' };
      }
      if (result2.includes('stolen_card')) {
        return { status: 'REPROVADA', detalhes: 'STOLEN_CARD' };
      }
      if (result2.includes('lost_card')) {
        return { status: 'REPROVADA', detalhes: 'LOST_CARD' };
      }
      if (result2.includes('pickup_card')) {
        return { status: 'REPROVADA', detalhes: 'PICKUP_CARD' };
      }
      if (result2.includes('transaction_not_allowed')) {
        return { status: 'REPROVADA', detalhes: 'TRANSACTION_NOT_ALLOWED' };
      }
      if (result2.includes('Your card has expired.')) {
        return { status: 'REPROVADA', detalhes: 'EXPIRED_CARD' };
      }
      if (result2.includes('incorrect_number')) {
        return { status: 'REPROVADA', detalhes: 'INCORRECT_NUMBER' };
      }
      if (result2.includes('processing_error')) {
        return { status: 'REPROVADA', detalhes: 'PROCESSING_ERROR' };
      }
      if (result2.includes('service_not_allowed')) {
        return { status: 'REPROVADA', detalhes: 'SERVICE_NOT_ALLOWED' };
      }
      if (result2.includes('fraudulent')) {
        return { status: 'LIVE', detalhes: 'FRAUDULENT CARD' };
      }
      return { status: 'REPROVADA', detalhes: msg };
    } catch {
      return { status: 'REPROVADA', detalhes: 'Stripe customer failed' };
    }
  }

  // Step 3: Charge $0.50
  try {
    const chRes = await fetch('https://api.stripe.com/v1/charges', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(sk + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': ua,
      },
      body: new URLSearchParams({
        'amount': '50',
        'currency': 'usd',
        'customer': token3,
      }),
      signal: AbortSignal.timeout(20000),
    });
    result3 = await chRes.text();
    const chJson = JSON.parse(result3);
    chtoken = chJson.charge || chJson.id || '';
    const declineCode = chJson.decline_code || '';
    const sellerMsg = chJson.outcome?.seller_message || '';

    if (sellerMsg.includes('Payment complete.') || chJson.status === 'succeeded') {
      // Charge succeeded - now refund
      try {
        await fetch('https://api.stripe.com/v1/refunds', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(sk + ':').toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': ua,
          },
          body: new URLSearchParams({
            'charge': chtoken || chJson.id,
            'amount': '50',
            'reason': 'requested_by_customer',
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {}
      return { status: 'LIVE', detalhes: 'Approved (CVV) charge + refund' };
    }

    if (result3.includes('insufficient_funds')) {
      return { status: 'LIVE', detalhes: 'Approved (CVV - INSUFFICIENT FUNDS)' };
    }
    if (declineCode === 'do_not_honor') {
      return { status: 'REPROVADA', detalhes: 'DO_NOT_HONOR' };
    }
    if (result3.includes('generic_decline')) {
      return { status: 'REPROVADA', detalhes: 'GENERIC_DECLINE' };
    }
    if (result3.includes('fraudulent')) {
      return { status: 'REPROVADA', detalhes: 'FRAUDULENT' };
    }
    if (result3.includes('stolen_card')) {
      return { status: 'REPROVADA', detalhes: 'STOLEN_CARD' };
    }
    if (result3.includes('lost_card')) {
      return { status: 'REPROVADA', detalhes: 'LOST_CARD' };
    }
    if (result3.includes('pickup_card')) {
      return { status: 'REPROVADA', detalhes: 'PICKUP_CARD' };
    }
    if (result3.includes('incorrect_cvc')) {
      return { status: 'LIVE', detalhes: 'CCN LIVE' };
    }
    if (result3.includes('Your card has expired.')) {
      return { status: 'REPROVADA', detalhes: 'EXPIRED_CARD' };
    }
    if (result3.includes('processing_error')) {
      return { status: 'REPROVADA', detalhes: 'PROCESSING_ERROR' };
    }
    if (result3.includes('incorrect_number')) {
      return { status: 'REPROVADA', detalhes: 'INCORRECT_NUMBER' };
    }
    if (result3.includes('service_not_allowed')) {
      return { status: 'REPROVADA', detalhes: 'SERVICE_NOT_ALLOWED' };
    }
    if (result3.includes('Your card number is incorrect.')) {
      return { status: 'REPROVADA', detalhes: 'INCORRECT_NUMBER' };
    }

    return { status: 'REPROVADA', detalhes: 'Charge declined: ' + (chJson.error?.message || declineCode || 'Unknown') };
  } catch (e) {
    return { status: 'REPROVADA', detalhes: 'Stripe charge error: ' + e.message };
  }
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

export function formatStripe2Result(card, month, year, cvv, result) {
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
