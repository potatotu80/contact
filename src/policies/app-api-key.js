'use strict';

const getClientIp = (ctx) => {
  const forwardedFor = ctx.request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return ctx.request.ip || ctx.ip || 'unknown';
};

module.exports = async (policyContext, _config, { strapi }) => {
  const expectedKey = (process.env.APP_API_KEY || '').trim();

  if (!expectedKey) {
    strapi.log.error(`APP_API_KEY is not configured. Blocking request to ${policyContext.request.path}.`);
    return policyContext.forbidden('Server authentication is not configured.');
  }

  const headerKey = (
    policyContext.request.headers['x-app-api-key']
    || policyContext.request.headers['x-app-write-key']
    || ''
  ).trim();

  if (headerKey && headerKey === expectedKey) {
    return true;
  }

  const authHeader = (policyContext.request.headers.authorization || '').trim();
  const bearerPrefix = 'Bearer ';
  const bearerToken = authHeader.startsWith(bearerPrefix)
    ? authHeader.slice(bearerPrefix.length).trim()
    : '';

  if (bearerToken && bearerToken === expectedKey) {
    return true;
  }

  const adminUser = policyContext.state?.admin?.user;
  if (adminUser?.id) {
    return true;
  }

  strapi.log.warn(
    `[app-api-key] Blocked ${policyContext.request.method} ${policyContext.request.path} ` +
    `from ${getClientIp(policyContext)} user-agent="${policyContext.request.headers['user-agent'] || 'unknown'}"`
  );

  return policyContext.forbidden('Invalid application API key.');
};
