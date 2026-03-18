/**
 * M-PESA Daraja API — STK Push integration
 * Supports sandbox and production environments
 */

const axios  = require('axios');
const logger = require('../config/logger');

const SANDBOX_BASE  = 'https://sandbox.safaricom.co.ke';
const PROD_BASE     = 'https://api.safaricom.co.ke';
const BASE_URL      = process.env.MPESA_ENV === 'production' ? PROD_BASE : SANDBOX_BASE;

// ─── Get OAuth token ─────────────────────────────────────────────
const getAccessToken = async () => {
  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );
  return data.access_token;
};

// ─── Generate password and timestamp ─────────────────────────────
const getPasswordAndTimestamp = () => {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);

  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');

  return { password, timestamp };
};

// ─── Initiate STK Push ───────────────────────────────────────────
const initiateSTKPush = async ({ phone, amountKES, transactionId, description }) => {
  try {
    const token = await getAccessToken();
    const { password, timestamp } = getPasswordAndTimestamp();

    // Format phone: strip leading 0 or +254 and prefix with 254
    const formattedPhone = phone
      .replace(/\s+/g, '')
      .replace(/^\+/, '')
      .replace(/^0/, '254');

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(amountKES),  // M-PESA requires integer
      PartyA:            formattedPhone,
      PartyB:            process.env.MPESA_SHORTCODE,
      PhoneNumber:       formattedPhone,
      CallBackURL:       process.env.MPESA_CALLBACK_URL,
      AccountReference:  `TRD-${transactionId.slice(0, 8).toUpperCase()}`,
      TransactionDesc:   description || 'TRD-WISE Evaluation Fee'
    };

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    logger.info('STK push initiated', {
      phone: formattedPhone,
      amount: amountKES,
      checkoutId: data.CheckoutRequestID
    });

    return {
      success:         data.ResponseCode === '0',
      checkoutId:      data.CheckoutRequestID,
      merchantId:      data.MerchantRequestID,
      responseCode:    data.ResponseCode,
      responseDesc:    data.ResponseDescription,
      customerMessage: data.CustomerMessage
    };
  } catch (err) {
    logger.error('STK push error', { error: err.response?.data || err.message });
    throw new Error(err.response?.data?.errorMessage || 'M-PESA request failed');
  }
};

// ─── Query STK Push status ───────────────────────────────────────
const querySTKStatus = async (checkoutRequestId) => {
  try {
    const token = await getAccessToken();
    const { password, timestamp } = getPasswordAndTimestamp();

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: process.env.MPESA_SHORTCODE,
        Password:          password,
        Timestamp:         timestamp,
        CheckoutRequestID: checkoutRequestId
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return {
      resultCode: data.ResultCode,
      resultDesc: data.ResultDesc,
      success:    data.ResultCode === '0'
    };
  } catch (err) {
    logger.error('STK query error', { error: err.message });
    throw err;
  }
};

// ─── Parse callback from Safaricom ───────────────────────────────
const parseCallback = (callbackBody) => {
  const result = callbackBody?.Body?.stkCallback;
  if (!result) throw new Error('Invalid callback body');

  const success = result.ResultCode === 0;
  let receipt = null, amount = null, phone = null;

  if (success && result.CallbackMetadata?.Item) {
    const items = result.CallbackMetadata.Item;
    const get = (name) => items.find(i => i.Name === name)?.Value;
    receipt = get('MpesaReceiptNumber');
    amount  = get('Amount');
    phone   = get('PhoneNumber');
  }

  return {
    success,
    checkoutId:     result.CheckoutRequestID,
    merchantId:     result.MerchantRequestID,
    resultCode:     result.ResultCode,
    resultDesc:     result.ResultDesc,
    receipt,
    amount,
    phone
  };
};

module.exports = { initiateSTKPush, querySTKStatus, parseCallback };
