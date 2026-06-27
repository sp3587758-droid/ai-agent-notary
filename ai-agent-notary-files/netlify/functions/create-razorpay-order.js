const Razorpay = require('razorpay');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const PLAN_CONFIG = {
  basic: {
    amount: 990000,
    description: 'AI Agent Notary — Basic Certificate (Monthly)'
  },
  annual: {
    amount: 490000,
    description: 'AI Agent Notary — Annual Renewal'
  },
  enterprise: {
    amount: 29990000,
    description: 'AI Agent Notary — Enterprise Plan (Monthly)'
  }
};

const CURRENCY = process.env.RAZORPAY_CURRENCY || 'INR';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('Missing Razorpay env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Payment service not configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { plan, agent } = payload;

  if (!plan || !PLAN_CONFIG[plan]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or missing plan' }) };
  }

  const requiredFields = ['agentName', 'ownerCompany', 'modelUsed', 'jurisdiction', 'contactEmail', 'riskLevel'];
  for (const field of requiredFields) {
    if (!agent || !agent[field] || String(agent[field]).trim() === '') {
      return { statusCode: 400, body: JSON.stringify({ error: `Missing required field: ${field}` }) };
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(agent.contactEmail)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid contact email' }) };
  }

  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  const planConfig = PLAN_CONFIG[plan];
  const internalRef = crypto.randomUUID();

  try {
    const order = await razorpay.orders.create({
      amount: planConfig.amount,
      currency: CURRENCY,
      receipt: internalRef.slice(0, 40),
      notes: {
        plan,
        internalRef: internalRef.slice(0, 50),
        contactEmail: agent.contactEmail.slice(0, 50)
      }
    });

    // Store pending agent data — keyed by Razorpay order ID
    // getStore() with just a name works automatically in Netlify Functions
    const pendingStore = getStore('pending-certificates');
    await pendingStore.setJSON(order.id, {
      plan,
      agent,
      razorpayOrderId: order.id,
      internalRef,
      status: 'pending_payment',
      createdAt: new Date().toISOString()
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        description: planConfig.description,
        prefillEmail: agent.contactEmail,
        prefillName: agent.ownerCompany
      })
    };
  } catch (err) {
    console.error('Razorpay Order creation failed:', err.message || err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not create payment order. Please try again.' })
    };
  }
};
