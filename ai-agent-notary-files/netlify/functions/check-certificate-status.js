const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const orderId = event.queryStringParameters?.order_id;
  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing order_id' }) };
  }

  const certificateStore = getStore('certificates');

  // get() returns null when key missing — no try/catch needed
  const certificate = await certificateStore.get(orderId, { type: 'json' });

  if (!certificate) {
    return { statusCode: 200, body: JSON.stringify({ status: 'pending' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: 'paid',
      certificate: {
        agentId: certificate.agentId,
        agentName: certificate.agentName,
        ownerCompany: certificate.ownerCompany,
        modelUsed: certificate.modelUsed,
        jurisdiction: certificate.jurisdiction,
        riskLevel: certificate.riskLevel,
        euClassification: certificate.euClassification,
        spendLimit: certificate.spendLimit,
        permissionsScope: certificate.permissionsScope,
        contactEmail: certificate.contactEmail,
        issuedAt: certificate.issuedAt,
        sha256Hash: certificate.sha256Hash,
        razorpayPaymentId: certificate.razorpayPaymentId
      }
    })
  };
};
