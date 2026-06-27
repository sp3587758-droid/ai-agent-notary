const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

function verifyRazorpaySignature(rawBody, signatureHeader, secret) {
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expectedSig, 'utf8');
  const b = Buffer.from(signatureHeader || '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('RAZORPAY_WEBHOOK_SECRET not set');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }

  // Must verify signature against raw bytes — before any JSON.parse
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  const signature = event.headers['x-razorpay-signature'];
  if (!signature) {
    return { statusCode: 400, body: 'Missing x-razorpay-signature header' };
  }
  if (!verifyRazorpaySignature(rawBody, signature, webhookSecret)) {
    console.error('Webhook signature verification FAILED');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const eventType = payload.event;
  console.log('Razorpay webhook event:', eventType);

  if (eventType !== 'payment.captured' && eventType !== 'order.paid') {
    return { statusCode: 200, body: JSON.stringify({ received: true, ignored: eventType }) };
  }

  let orderId, paymentId;
  try {
    if (eventType === 'payment.captured') {
      orderId = payload.payload.payment.entity.order_id;
      paymentId = payload.payload.payment.entity.id;
    } else {
      orderId = payload.payload.order.entity.id;
      paymentId = payload.payload.payment?.entity?.id || null;
    }
  } catch (err) {
    console.error('Failed to extract IDs from webhook payload:', err);
    return { statusCode: 400, body: 'Malformed webhook payload' };
  }

  if (!orderId) {
    return { statusCode: 400, body: 'Missing order_id in webhook payload' };
  }

  // getStore() with just a name — works automatically in Netlify Functions
  const pendingStore = getStore('pending-certificates');
  const certificateStore = getStore('certificates');

  // IDEMPOTENCY: return early if certificate already exists for this order
  // get() returns null (not throw) when key missing — per Netlify Blobs docs
  const existing = await certificateStore.get(orderId, { type: 'json' });
  if (existing) {
    console.log('Certificate already exists for order:', orderId);
    return { statusCode: 200, body: JSON.stringify({ received: true, status: 'already_processed' }) };
  }

  // Retrieve pending agent data stored during order creation
  const pendingRecord = await pendingStore.get(orderId, { type: 'json' });
  if (!pendingRecord) {
    console.error('No pending record for order:', orderId);
    return { statusCode: 200, body: JSON.stringify({ received: true, status: 'no_pending_record' }) };
  }

  // ── CERTIFICATE GENERATION ──────────────────────────────────────────
  // Only reachable after Razorpay HMAC signature verified + payment event confirmed
  const { agent, plan } = pendingRecord;
  const agentId = crypto.randomUUID();
  const issuedAt = new Date().toISOString();

  let euClassification;
  if (agent.riskLevel.startsWith('High')) {
    euClassification = 'High-Risk AI System (Annex III) — Mandatory Conformity Assessment Required';
  } else if (agent.riskLevel.startsWith('Medium')) {
    euClassification = 'Limited Risk — Transparency Obligations Apply';
  } else {
    euClassification = 'Minimal Risk — No Mandatory EU AI Act Obligations';
  }

  const certificateMetadata = {
    agentId,
    agentName: agent.agentName,
    ownerCompany: agent.ownerCompany,
    modelUsed: agent.modelUsed,
    jurisdiction: agent.jurisdiction,
    riskLevel: agent.riskLevel,
    spendLimit: agent.spendLimit || 'N/A',
    permissionsScope: agent.permissionsScope || 'Not specified',
    contactEmail: agent.contactEmail,
    plan,
    euClassification,
    issuedAt,
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId
  };

  const sha256Hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(certificateMetadata))
    .digest('hex');

  const certificateRecord = {
    ...certificateMetadata,
    sha256Hash,
    status: 'paid',
    paymentStatus: 'captured',
    paymentVerifiedAt: new Date().toISOString()
  };

  // Store by orderId (for polling) and agentId (for future public verification)
  await certificateStore.setJSON(orderId, certificateRecord);
  await certificateStore.setJSON(`agent:${agentId}`, certificateRecord);

  // Update pending record as resolved (audit trail)
  await pendingStore.setJSON(orderId, {
    ...pendingRecord,
    status: 'paid',
    resolvedAt: new Date().toISOString()
  });

  console.log('Certificate generated — orderId:', orderId, 'agentId:', agentId);
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true, status: 'certificate_generated', agentId })
  };
};
